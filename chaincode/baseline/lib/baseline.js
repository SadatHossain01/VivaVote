/*
 * baseline.js — Naive Linear-Whitelist Voting (for benchmarking)
 *
 * This chaincode implements the STRAWMAN approach:
 *   - Each voter is individually registered on-chain → O(N) PutState calls
 *   - Eligibility is checked via direct GetState lookup
 *   - No Merkle tree, no trustee recovery
 *
 * PURPOSE: This exists ONLY for comparison with the VivaVote chaincode.
 * By deploying both to the same Fabric channel, we can measure:
 *   - Setup cost:  1 PutState (Merkle root) vs N PutState (linear)
 *   - State size:  32 bytes vs N × ~50 bytes
 *   - Tally rate:  100% (with recovery) vs <100% (without recovery)
 */

'use strict';

const { Contract } = require('fabric-contract-api');
const crypto = require('crypto');

class BaselineContract extends Contract {

  // ─────────────────────── HELPERS ───────────────────────

  _hash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  async _get(ctx, key) {
    const raw = await ctx.stub.getState(key);
    if (!raw || raw.length === 0) return null;
    return JSON.parse(raw.toString());
  }

  async _put(ctx, key, value) {
    await ctx.stub.putState(key, Buffer.from(JSON.stringify(value)));
  }

  // Counts are derived from BVOTE_ records rather than stored on the election
  // record, so concurrent commits/reveals do not contend on a shared hot key.
  // This mirrors the VivaVote chaincode so the two systems are compared fairly.
  async _countCommitted(ctx, electionId) {
    const iter = await ctx.stub.getStateByRange(`BVOTE_${electionId}_`, `BVOTE_${electionId}_~`);
    let count = 0;
    let res = await iter.next();
    while (!res.done) { count += 1; res = await iter.next(); }
    await iter.close();
    return count;
  }

  async _deriveTally(ctx, electionId, election) {
    const tally = {};
    for (const candidate of election.candidates) tally[candidate] = 0;
    let totalRevealed = 0;
    const iter = await ctx.stub.getStateByRange(`BVOTE_${electionId}_`, `BVOTE_${electionId}_~`);
    let res = await iter.next();
    while (!res.done) {
      const vote = JSON.parse(res.value.value.toString());
      if (vote.revealed && vote.vote != null) {
        totalRevealed += 1;
        tally[vote.vote] = (tally[vote.vote] || 0) + 1;
      }
      res = await iter.next();
    }
    await iter.close();
    tally.totalRevealed = totalRevealed;
    return tally;
  }

  _timestamp(ctx) {
    const ts = ctx.stub.getTxTimestamp();
    return new Date(ts.seconds.low * 1000).toISOString();
  }

  // ─────────────── ELECTION MANAGEMENT ─────────────────

  /**
   * Create an election (same as VivaVote but no trustee config).
   */
  async CreateElection(ctx, electionId, title, candidatesJSON) {
    const existing = await this._get(ctx, `ELECTION_${electionId}`);
    if (existing) throw new Error(`Election "${electionId}" already exists`);

    const candidates = JSON.parse(candidatesJSON);
    const election = {
      id: electionId,
      title,
      candidates,
      phase: 'SETUP',
      totalVoters: 0,
      totalCommitted: 0,
      totalRevealed: 0,
      createdAt: this._timestamp(ctx),
    };

    const tally = { finalized: false };
    candidates.forEach((c) => { tally[c] = 0; });

    await this._put(ctx, `ELECTION_${electionId}`, election);
    await this._put(ctx, `TALLY_${electionId}`, tally);

    return JSON.stringify(election);
  }

  /**
   * Register a SINGLE voter — O(1) per voter, but O(N) total for N voters.
   * This is the expensive operation that VivaVote avoids with Merkle trees.
   */
  async RegisterVoter(ctx, electionId, voterId) {
    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`Election "${electionId}" not found`);
    if (election.phase !== 'SETUP') throw new Error('Can only register during SETUP');

    await this._put(ctx, `BVOTER_${electionId}_${voterId}`, { registered: true });
    election.totalVoters++;
    await this._put(ctx, `ELECTION_${electionId}`, election);

    return JSON.stringify({ success: true, voterId });
  }

  /**
   * Register voters in batch — still O(N) PutState calls.
   */
  async RegisterVoterBatch(ctx, electionId, voterIdsJSON) {
    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`Election "${electionId}" not found`);
    if (election.phase !== 'SETUP') throw new Error('Can only register during SETUP');

    const voterIds = JSON.parse(voterIdsJSON);
    for (const voterId of voterIds) {
      await this._put(ctx, `BVOTER_${electionId}_${voterId}`, { registered: true });
    }
    election.totalVoters += voterIds.length;
    await this._put(ctx, `ELECTION_${electionId}`, election);

    return JSON.stringify({ registered: voterIds.length });
  }

  /** Advance election phase. */
  async SetPhase(ctx, electionId, newPhase) {
    const PHASES = ['SETUP', 'COMMIT', 'REVEAL', 'TALLY']; // No RECOVER phase!
    if (!PHASES.includes(newPhase)) throw new Error(`Invalid phase: ${newPhase}`);

    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`Election "${electionId}" not found`);

    const curIdx = PHASES.indexOf(election.phase);
    const newIdx = PHASES.indexOf(newPhase);
    if (newIdx <= curIdx) throw new Error(`Cannot go backward: ${election.phase} → ${newPhase}`);

    election.phase = newPhase;
    await this._put(ctx, `ELECTION_${electionId}`, election);
    return JSON.stringify(election);
  }

  // ─────────────── COMMIT-REVEAL VOTING ─────────────────

  /**
   * Commit a vote — checks eligibility via direct state lookup.
   */
  async CommitVote(ctx, electionId, voterId, commitmentHash) {
    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`Election "${electionId}" not found`);
    if (election.phase !== 'COMMIT') throw new Error(`Not in COMMIT phase`);

    // LINEAR eligibility check — GetState lookup
    const voter = await this._get(ctx, `BVOTER_${electionId}_${voterId}`);
    if (!voter) throw new Error('Voter not registered');

    const existing = await this._get(ctx, `BVOTE_${electionId}_${voterId}`);
    if (existing) throw new Error('Already committed');

    await this._put(ctx, `BVOTE_${electionId}_${voterId}`, {
      commitment: commitmentHash,
      revealed: false,
      vote: null,
      committedAt: this._timestamp(ctx),
    });

    // No ELECTION_ counter write (derived via _countCommitted) — keeps the commit
    // path contention-free, matching the VivaVote chaincode.

    return JSON.stringify({ success: true, voterId });
  }

  /**
   * Reveal a vote — same logic as VivaVote, but NO recovery mechanism.
   * If the voter fails to reveal, the vote is LOST forever.
   */
  async RevealVote(ctx, electionId, voterId, candidateId, nonce) {
    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`Election "${electionId}" not found`);
    if (election.phase !== 'REVEAL') throw new Error(`Not in REVEAL phase`);

    const vote = await this._get(ctx, `BVOTE_${electionId}_${voterId}`);
    if (!vote) throw new Error('No commitment found');
    if (vote.revealed) throw new Error('Already revealed');

    const expectedHash = this._hash(candidateId + '||' + nonce);
    if (expectedHash !== vote.commitment) {
      throw new Error('Hash mismatch');
    }
    if (!election.candidates.includes(candidateId)) {
      throw new Error(`Unknown candidate: "${candidateId}"`);
    }

    vote.revealed = true;
    vote.vote = candidateId;
    vote.revealedAt = this._timestamp(ctx);
    await this._put(ctx, `BVOTE_${electionId}_${voterId}`, vote);

    // Vote record is the only write; tally and revealed count derived on read.

    return JSON.stringify({ success: true, voterId, candidateId });
  }

  // ──────────────────── QUERIES ─────────────────────────

  async GetElection(ctx, electionId) {
    const e = await this._get(ctx, `ELECTION_${electionId}`);
    if (!e) throw new Error(`Election "${electionId}" not found`);
    e.totalCommitted = await this._countCommitted(ctx, electionId);
    e.totalRevealed = (await this._deriveTally(ctx, electionId, e)).totalRevealed;
    return JSON.stringify(e);
  }

  async GetAllElections(ctx) {
    const iter = await ctx.stub.getStateByRange('ELECTION_', 'ELECTION_~');
    const results = [];
    let res = await iter.next();
    while (!res.done) {
      results.push(JSON.parse(res.value.value.toString()));
      res = await iter.next();
    }
    await iter.close();
    return JSON.stringify(results);
  }

  async GetTally(ctx, electionId) {
    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`No tally for "${electionId}"`);
    const tally = await this._deriveTally(ctx, electionId, election);
    // Finalization is stored, not derived — carry it across (mirrors VivaVote).
    const stored = await this._get(ctx, `TALLY_${electionId}`);
    tally.finalized = Boolean(stored && stored.finalized);
    if (stored && stored.finalizedAt) tally.finalizedAt = stored.finalizedAt;
    return JSON.stringify(tally);
  }

  async FinalizeTally(ctx, electionId) {
    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`Election "${electionId}" not found`);
    if (election.phase !== 'TALLY') throw new Error('Must be in TALLY phase');

    const tally = await this._deriveTally(ctx, electionId, election);
    tally.finalized = true;
    tally.totalCommitted = await this._countCommitted(ctx, electionId);
    tally.finalizedAt = this._timestamp(ctx);
    await this._put(ctx, `TALLY_${electionId}`, tally);

    return JSON.stringify(tally);
  }

  /** Return serialized ledger footprint for one baseline election. */
  async GetStorageStats(ctx, electionId) {
    const electionKey = `ELECTION_${electionId}`;
    const tallyKey = `TALLY_${electionId}`;
    const electionRaw = await ctx.stub.getState(electionKey);
    if (!electionRaw || electionRaw.length === 0) throw new Error(`Election "${electionId}" not found`);
    const tallyRaw = await ctx.stub.getState(tallyKey);

    const voterIter = await ctx.stub.getStateByRange(
      `BVOTER_${electionId}_`,
      `BVOTER_${electionId}_~`
    );
    let voterCount = 0;
    let voterValueBytes = 0;
    let voterKeyBytes = 0;
    let res = await voterIter.next();
    while (!res.done) {
      voterCount++;
      voterValueBytes += res.value.value.length;
      voterKeyBytes += Buffer.byteLength(res.value.key);
      res = await voterIter.next();
    }
    await voterIter.close();

    const voteIter = await ctx.stub.getStateByRange(
      `BVOTE_${electionId}_`,
      `BVOTE_${electionId}_~`
    );
    let voteCount = 0;
    let voteValueBytes = 0;
    let voteKeyBytes = 0;
    res = await voteIter.next();
    while (!res.done) {
      voteCount++;
      voteValueBytes += res.value.value.length;
      voteKeyBytes += Buffer.byteLength(res.value.key);
      res = await voteIter.next();
    }
    await voteIter.close();

    const electionValueBytes = electionRaw.length;
    const tallyValueBytes = tallyRaw.length;
    const electionKeyBytes = Buffer.byteLength(electionKey);
    const tallyKeyBytes = Buffer.byteLength(tallyKey);

    return JSON.stringify({
      keyCount: 2 + voterCount + voteCount,
      categories: {
        election: { keyCount: 1, keyBytes: electionKeyBytes, valueBytes: electionValueBytes },
        tally: { keyCount: 1, keyBytes: tallyKeyBytes, valueBytes: tallyValueBytes },
        voters: { keyCount: voterCount, keyBytes: voterKeyBytes, valueBytes: voterValueBytes },
        votes: { keyCount: voteCount, keyBytes: voteKeyBytes, valueBytes: voteValueBytes },
      },
      keyBytes: electionKeyBytes + tallyKeyBytes + voterKeyBytes + voteKeyBytes,
      valueBytes: electionValueBytes + tallyValueBytes + voterValueBytes + voteValueBytes,
      totalBytes: electionKeyBytes + tallyKeyBytes + voterKeyBytes + voteKeyBytes + electionValueBytes + tallyValueBytes + voterValueBytes + voteValueBytes,
    });
  }
}

module.exports = BaselineContract;
