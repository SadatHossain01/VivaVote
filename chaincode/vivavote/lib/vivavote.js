/*
 * vivavote.js — VivaVote Smart Contract (Chaincode)
 *
 * This is the primary smart contract for the VivaVote system.
 * It runs inside Hyperledger Fabric and manages:
 *
 *   1. ELECTION LIFECYCLE   — Create elections, advance through phases
 *   2. MERKLE VERIFICATION  — O(1) voter eligibility via Merkle proofs
 *   3. COMMIT-REVEAL VOTING — Privacy-preserving two-phase voting
 *   4. TRUSTEE RECOVERY     — Shamir-based vote recovery for absent voters
 *
 * ELECTION PHASES:
 *   SETUP → COMMIT → REVEAL → RECOVER → TALLY
 *
 * DATA MODEL (World State Keys):
 *   ELECTION_{id}           — Election metadata (title, candidates, phase, merkleRoot, voter counts)
 *   VOTE_{electionId}_{id}  — Individual vote (commitment, shares, revealed status)
 *   TALLY_{electionId}      — Running vote tally per candidate
 */

'use strict';

const { Contract } = require('fabric-contract-api');
const crypto = require('crypto');
const { verifyMerkleProof } = require('./merkle');
const { combineShares, verifyShare } = require('./shamir');

class VivaVoteContract extends Contract {

  // ─────────────────────── HELPERS ───────────────────────

  /** SHA-256 hash → hex string */
  _hash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  _normalizeShare(share) {
    if (!share || typeof share !== 'object') throw new Error('Share must be an object');
    const x = Number(share.x);
    const data = String(share.data || '');
    if (!Number.isInteger(x) || x < 1) throw new Error('Share x must be a positive integer');
    if (!data) throw new Error('Share data is required');
    return { x, data };
  }

  _hashShare(share) {
    return this._hash(JSON.stringify(this._normalizeShare(share)));
  }

  _normalizeFeldmanCommitments(commitments, expectedCount) {
    if (!Array.isArray(commitments) || !commitments.length) {
      throw new Error('Feldman commitments are required');
    }
    if (expectedCount != null && commitments.length !== expectedCount) {
      throw new Error(`Expected ${expectedCount} Feldman commitments`);
    }
    return commitments.map((commitment) => {
      const normalized = String(commitment || '').toLowerCase();
      if (!/^[0-9a-f]+$/i.test(normalized)) {
        throw new Error('Feldman commitments must be hex strings');
      }
      return normalized;
    });
  }

  /** Read a JSON object from the world state */
  async _get(ctx, key) {
    const raw = await ctx.stub.getState(key);
    if (!raw || raw.length === 0) return null;
    return JSON.parse(raw.toString());
  }

  /** Write a JSON object to the world state */
  async _put(ctx, key, value) {
    await ctx.stub.putState(key, Buffer.from(JSON.stringify(value)));
  }


  /**
   * Derive the tally by scanning vote records. Like the committed count, the
   * per-candidate tally is computed on read rather than mutated on every reveal
   * or recovery: a shared TALLY_/ELECTION_ counter would serialize those phases
   * under MVCC exactly as it did for commits. Each counted ballot lives in one
   * VOTE_<id>_<voterId> record with `revealed`/`recovered` and `vote` set, so the
   * record set is the single source of truth for both direct and recovered votes.
   */
  async _deriveTally(ctx, electionId, election) {
    const tally = {};
    for (const candidate of election.candidates) tally[candidate] = 0;
    let totalCommitted = 0;
    let totalRevealed = 0;
    let totalRecovered = 0;
    const iter = await ctx.stub.getStateByRange(
      `VOTE_${electionId}_`,
      `VOTE_${electionId}_~`
    );
    let res = await iter.next();
    while (!res.done) {
      const vote = JSON.parse(res.value.value.toString());
      totalCommitted += 1;
      if (vote.revealed || vote.recovered) {
        if (vote.revealed) totalRevealed += 1;
        else totalRecovered += 1;
        if (vote.vote != null) tally[vote.vote] = (tally[vote.vote] || 0) + 1;
      }
      res = await iter.next();
    }
    await iter.close();
    tally.totalCommitted = totalCommitted;
    tally.totalRevealed = totalRevealed;
    tally.totalRecovered = totalRecovered;
    return tally;
  }

  /** Get the transaction timestamp (deterministic — never use Date.now()!) */
  _timestamp(ctx) {
    const ts = ctx.stub.getTxTimestamp();
    return new Date(ts.seconds.low * 1000).toISOString();
  }

  // ─────────────────── ELECTION MANAGEMENT ───────────────────

  /**
   * Create a new election.
   * @param {string} electionId        — Unique election identifier
   * @param {string} title             — Human-readable title
   * @param {string} candidatesJSON    — JSON array of candidate names
   * @param {string} merkleRoot        — Hex Merkle root built off-chain from voter IDs
   * @param {string} totalVoters       — Number of eligible voters represented by the root
   * @param {string} trusteesJSON      — JSON array of trustee usernames
   * @param {string} trusteeThreshold  — Min trustees to reconstruct (T)
   */
  async CreateElection(ctx, electionId, title, candidatesJSON, merkleRoot, totalVoters, trusteesJSON, trusteeThreshold, trusteePublicKeysJSON) {
    // Guard: no duplicates
    const existing = await this._get(ctx, `ELECTION_${electionId}`);
    if (existing) throw new Error(`Election "${electionId}" already exists`);

    const candidates = JSON.parse(candidatesJSON);
    const trustees = JSON.parse(trusteesJSON);
    const trusteePublicKeys = JSON.parse(trusteePublicKeysJSON || '{}');
    const t = parseInt(trusteeThreshold);
    const voterCount = parseInt(totalVoters, 10);
    if (!merkleRoot) throw new Error('Merkle root is required');
    if (!Number.isInteger(voterCount) || voterCount < 1) throw new Error('totalVoters must be a positive integer');
    if (t > trustees.length) throw new Error('Threshold cannot exceed trustee count');
    if (t < 2) throw new Error('Threshold must be at least 2');
    if (new Set(trustees).size !== trustees.length) throw new Error('Trustee IDs must be unique');
    for (const trusteeId of trustees) {
      if (!trusteePublicKeys[trusteeId]) {
        throw new Error(`Missing trustee recovery key for "${trusteeId}"`);
      }
    }

    const election = {
      id: electionId,
      title,
      candidates,
      trustees,
      trusteePublicKeys,
      merkleRoot,
      phase: 'SETUP',
      trusteeCount: trustees.length,
      trusteeThreshold: t,
      totalVoters: voterCount,
      totalRevealed: 0,
      totalRecovered: 0,
      createdAt: this._timestamp(ctx),
      recoveryTargetVoters: [],
      submittedRecoveryBundles: [],
    };

    // Initialize empty tally
    const tally = { finalized: false };
    candidates.forEach((c) => { tally[c] = 0; });

    await this._put(ctx, `ELECTION_${electionId}`, election);
    await this._put(ctx, `TALLY_${electionId}`, tally);

    return JSON.stringify(election);
  }

  /**
   * Store the Merkle root of the eligible voter list.
   * Called by admin after building the tree off-chain.
   * This is the ONLY on-chain storage needed for voter registration — O(1)!
   */
  async SetMerkleRoot(ctx, electionId, merkleRoot, totalVoters) {
    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`Election "${electionId}" not found`);
    if (election.phase !== 'SETUP') throw new Error('Can only set root during SETUP');

    election.merkleRoot = merkleRoot;
    election.totalVoters = parseInt(totalVoters);
    await this._put(ctx, `ELECTION_${electionId}`, election);

    return JSON.stringify(election);
  }

  /**
   * Advance the election to the next phase.
   * Phase order: SETUP → COMMIT → REVEAL → RECOVER → TALLY
   */
  async SetPhase(ctx, electionId, newPhase) {
    const PHASES = ['SETUP', 'COMMIT', 'REVEAL', 'RECOVER', 'TALLY'];
    if (!PHASES.includes(newPhase)) throw new Error(`Invalid phase: ${newPhase}`);

    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`Election "${electionId}" not found`);

    const curIdx = PHASES.indexOf(election.phase);
    const newIdx = PHASES.indexOf(newPhase);
    if (newIdx <= curIdx) throw new Error(`Cannot go backward: ${election.phase} → ${newPhase}`);
    if (election.phase === 'SETUP' && !election.merkleRoot) {
      throw new Error('Must set Merkle root before leaving SETUP');
    }

    if (newPhase === 'RECOVER') {
      const targets = JSON.parse(await this.GetUnrevealedVoters(ctx, electionId));
      election.recoveryTargetVoters = targets;
      election.submittedRecoveryBundles = [];
    }

    if (election.phase === 'RECOVER' && newPhase === 'TALLY') {
      const pendingTargets = [];
      for (const voterId of election.recoveryTargetVoters || []) {
        const vote = await this._get(ctx, `VOTE_${electionId}_${voterId}`);
        if (vote && !vote.revealed && !vote.recovered) {
          pendingTargets.push(voterId);
        }
      }
      if (pendingTargets.length > 0) {
        throw new Error(`Cannot finalize recovery selectively; pending voters: ${pendingTargets.join(', ')}`);
      }
    }

    election.phase = newPhase;
    await this._put(ctx, `ELECTION_${electionId}`, election);
    return JSON.stringify(election);
  }

  /** Read a single election. */
  async GetElection(ctx, electionId) {
    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`Election "${electionId}" not found`);
    const derived = await this._deriveTally(ctx, electionId, election);
    election.totalCommitted = derived.totalCommitted;
    election.totalRevealed = derived.totalRevealed;
    election.totalRecovered = derived.totalRecovered;
    return JSON.stringify(election);
  }

  /** List all elections. */
  async GetAllElections(ctx) {
    const iter = await ctx.stub.getStateByRange('ELECTION_', 'ELECTION_~');
    const results = [];
    let res = await iter.next();
    while (!res.done) {
      results.push(JSON.parse(res.value.value.toString()));
      res = await iter.next();
    }
    await iter.close();
    for (const election of results) {
      const derived = await this._deriveTally(ctx, election.id, election);
      election.totalCommitted = derived.totalCommitted;
      election.totalRevealed = derived.totalRevealed;
      election.totalRecovered = derived.totalRecovered;
    }
    return JSON.stringify(results);
  }

  // ─────────────── MERKLE ELIGIBILITY CHECK ─────────────────

  /**
   * Verify a voter's eligibility using their Merkle proof.
   * This is a read-only query — it doesn't write to the ledger.
   */
  async VerifyVoter(ctx, electionId, voterId, proofJSON) {
    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`Election "${electionId}" not found`);
    if (!election.merkleRoot) throw new Error('No Merkle root set for this election');

    const proof = JSON.parse(proofJSON);
    const eligible = verifyMerkleProof(voterId, proof, election.merkleRoot);

    return JSON.stringify({ eligible, voterId, electionId });
  }

  // ──────────────── COMMIT-REVEAL VOTING ────────────────────

  /**
   * COMMIT PHASE: Voter submits a blinded vote.
   *
   * What gets stored on-chain:
   *   - commitmentHash  = SHA256(candidateId + "||" + nonce)
   *   - Shamir shares   = the secret split into N pieces
   *
   * The actual vote choice is NOT visible until the reveal phase.
   *
   * @param {string} commitmentHash    — SHA256(candidateId || nonce)
   * @param {string} proofJSON         — Merkle proof of voter eligibility
  * @param {string} sharesJSON        — JSON object keyed by trustee with encrypted shares
  * @param {string} commitmentsJSON   — JSON array of Feldman commitments for the share polynomial
   */
  async CommitVote(ctx, electionId, voterId, commitmentHash, proofJSON, sharesJSON, commitmentsJSON) {
    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`Election "${electionId}" not found`);
    if (election.phase !== 'COMMIT') throw new Error(`Not in COMMIT phase (current: ${election.phase})`);

    // Prevent double-voting
    const existing = await this._get(ctx, `VOTE_${electionId}_${voterId}`);
    if (existing) throw new Error('This voter has already committed a vote');

    // Verify Merkle proof — O(log N) on-chain verification
    const proof = JSON.parse(proofJSON);
    if (!verifyMerkleProof(voterId, proof, election.merkleRoot)) {
      throw new Error('Merkle proof invalid — voter is not eligible');
    }

    const encryptedTrusteeShares = JSON.parse(sharesJSON);
    const feldmanCommitments = this._normalizeFeldmanCommitments(
      JSON.parse(commitmentsJSON || '[]'),
      election.trusteeThreshold,
    );
    for (const trusteeId of election.trustees) {
      const shareEnvelope = encryptedTrusteeShares[trusteeId];
      if (!shareEnvelope || !shareEnvelope.ciphertext || !shareEnvelope.hash) {
        throw new Error(`Missing encrypted share envelope for trustee "${trusteeId}"`);
      }
    }

    const vote = {
      electionId,
      voterId,
      commitment: commitmentHash,
      encryptedTrusteeShares,
      feldmanCommitments,
      submittedShares: [],
      revealed: false,
      recovered: false,
      vote: null,
      committedAt: this._timestamp(ctx),
    };

    await this._put(ctx, `VOTE_${electionId}_${voterId}`, vote);

    // The election record is deliberately NOT written here. Writing it to bump a
    // committed counter would make ELECTION_<id> a hot key: concurrent ballots
    // would all read the same version and every one but the first would be
    // rejected with MVCC_READ_CONFLICT. The vote record above is per-voter, so
    // commits stay contention-free; the committed count is derived on read via
    // _deriveTally(). Reading the election above is fine — only writers
    // create conflicts.

    return JSON.stringify({ success: true, voterId, electionId });
  }

  /**
   * REVEAL PHASE: Voter proves their vote by revealing the plaintext.
   *
   * The chaincode verifies: SHA256(candidateId + "||" + nonce) === stored commitment
   * If valid, the vote is recorded in the tally.
   */
  async RevealVote(ctx, electionId, voterId, candidateId, nonce) {
    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`Election "${electionId}" not found`);
    if (election.phase !== 'REVEAL') throw new Error(`Not in REVEAL phase (current: ${election.phase})`);

    const vote = await this._get(ctx, `VOTE_${electionId}_${voterId}`);
    if (!vote) throw new Error('No commitment found for this voter');
    if (vote.revealed || vote.recovered) throw new Error('Vote already counted');

    // Verify the reveal matches the commitment
    const expectedHash = this._hash(candidateId + '||' + nonce);
    if (expectedHash !== vote.commitment) {
      throw new Error('Hash mismatch — reveal does not match commitment');
    }

    // Verify candidate is valid
    if (!election.candidates.includes(candidateId)) {
      throw new Error(`Unknown candidate: "${candidateId}"`);
    }

    // Record the revealed vote
    vote.revealed = true;
    vote.vote = candidateId;
    vote.revealedAt = this._timestamp(ctx);
    await this._put(ctx, `VOTE_${electionId}_${voterId}`, vote);

    // The vote record above is the only write: it records revealed=true and the
    // choice. TALLY_ and ELECTION_ are intentionally NOT written here — doing so
    // would make them hot keys shared by every reveal, serializing the phase under
    // MVCC. The tally and revealed count are derived on read via _deriveTally().

    return JSON.stringify({ success: true, voterId, candidateId });
  }

  /**
   * RECOVER PHASE: Trustees reconstruct a vote from Shamir shares.
   *
   * This is the KEY INNOVATION: if a voter commits but never reveals
   * (due to apathy, connectivity loss, etc.), the trustees can recover
   * the vote from the stored shares — NO DEPOSIT REQUIRED.
   *
   * The chaincode:
   *   1. Reads the stored Shamir shares
   *   2. Reconstructs the secret (candidateId || nonce)
   *   3. Verifies SHA256(secret) === stored commitment
   *   4. Records the vote in the tally
   */
  async TrusteeRecoverVote(ctx, electionId, voterId) {
    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`Election "${electionId}" not found`);
    if (election.phase !== 'RECOVER') throw new Error(`Not in RECOVER phase (current: ${election.phase})`);

    const vote = await this._get(ctx, `VOTE_${electionId}_${voterId}`);
    if (!vote) throw new Error('No commitment found for this voter');
    if (vote.revealed || vote.recovered) throw new Error('Vote already counted');

    // Use submitted shares for reconstruction
    const shares = vote.submittedShares;
    if (shares.length < election.trusteeThreshold) {
      throw new Error(`Not enough shares (have ${shares.length}, need ${election.trusteeThreshold})`);
    }

    for (const share of shares) {
      if (!verifyShare(share, vote.feldmanCommitments)) {
        throw new Error('Submitted shares failed Feldman verification');
      }
    }

    const reconstructed = combineShares(shares);
    const parts = reconstructed.split('||');
    if (parts.length < 2) throw new Error('Reconstructed secret has invalid format');

    const candidateId = parts[0];
    const nonce = parts.slice(1).join('||'); // nonce might contain ||

    // Verify against the stored commitment
    const expectedHash = this._hash(candidateId + '||' + nonce);
    if (expectedHash !== vote.commitment) {
      throw new Error('Recovered secret does not match commitment — data corruption');
    }

    // Verify candidate
    if (!election.candidates.includes(candidateId)) {
      throw new Error(`Recovered invalid candidate: "${candidateId}"`);
    }

    // Record the recovered vote. As in RevealVote, the vote record is the only
    // write; TALLY_/ELECTION_ counters are derived on read (see _deriveTally).
    vote.recovered = true;
    vote.vote = candidateId;
    vote.recoveredAt = this._timestamp(ctx);
    await this._put(ctx, `VOTE_${electionId}_${voterId}`, vote);

    return JSON.stringify({
      success: true,
      voterId,
      candidateId,
      method: 'trustee-recovery',
    });
  }

  // ──────────────── TRUSTEE SHARE SUBMISSION ─────────────────

  /**
   * A trustee submits a recovery bundle covering every unrevealed voter in the RECOVER snapshot.
   * This prevents selective recovery by forcing all-or-nothing trustee participation.
   */
  async SubmitRecoveryBundle(ctx, electionId, trusteeId, sharesJSON) {
    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`Election "${electionId}" not found`);
    if (election.phase !== 'RECOVER') throw new Error(`Not in RECOVER phase (current: ${election.phase})`);

    if (!election.trustees.includes(trusteeId)) {
      throw new Error(`"${trusteeId}" is not a trustee for this election`);
    }

    if ((election.submittedRecoveryBundles || []).includes(trusteeId)) {
      throw new Error(`Trustee "${trusteeId}" has already submitted a recovery bundle`);
    }

    const submittedShares = JSON.parse(sharesJSON || '[]');
    const recoveryTargets = [...(election.recoveryTargetVoters || [])].sort();
    const submittedTargets = submittedShares.map((entry) => String(entry?.voterId || '')).sort();
    if (submittedTargets.length !== recoveryTargets.length) {
      throw new Error('Recovery bundle must include every unrevealed voter in the recovery set');
    }
    if (JSON.stringify(submittedTargets) !== JSON.stringify(recoveryTargets)) {
      throw new Error('Recovery bundle voter set does not match the election recovery targets');
    }

    let recoveredCount = 0;

    for (const entry of submittedShares) {
      const voterId = String(entry.voterId || '');
      const vote = await this._get(ctx, `VOTE_${electionId}_${voterId}`);
      if (!vote) throw new Error(`No commitment found for voter "${voterId}"`);

      const assignment = vote.encryptedTrusteeShares?.[trusteeId];
      if (!assignment) {
        throw new Error(`No encrypted share assigned to trustee "${trusteeId}" for voter "${voterId}"`);
      }

      const share = this._normalizeShare(entry.share);
      if (this._hashShare(share) !== assignment.hash) {
        throw new Error(`Submitted share failed integrity verification for voter "${voterId}"`);
      }
      if (!verifyShare(share, vote.feldmanCommitments)) {
        throw new Error(`Submitted share failed Feldman verification for voter "${voterId}"`);
      }

      if (!vote.submittedShares.some((submitted) => submitted.trusteeId === trusteeId)) {
        vote.submittedShares.push({
          trusteeId,
          x: share.x,
          data: share.data,
          submittedAt: this._timestamp(ctx),
        });
      }

      if (!vote.revealed && !vote.recovered && vote.submittedShares.length >= election.trusteeThreshold) {
        const reconstructed = combineShares(vote.submittedShares.map((submitted) => ({ x: submitted.x, data: submitted.data })));
        const parts = reconstructed.split('||');
        if (parts.length < 2) throw new Error('Recovered secret has invalid format');

        const candidateId = parts[0];
        const nonce = parts.slice(1).join('||');
        const expectedHash = this._hash(candidateId + '||' + nonce);
        if (expectedHash !== vote.commitment) {
          throw new Error(`Recovered secret does not match commitment for voter "${voterId}"`);
        }
        if (!election.candidates.includes(candidateId)) {
          throw new Error(`Recovered invalid candidate for voter "${voterId}"`);
        }

        vote.recovered = true;
        vote.vote = candidateId;
        vote.recoveredAt = this._timestamp(ctx);

        // No TALLY_/ELECTION_ counter write here (see _deriveTally): the recovered
        // ballot is recorded on its own vote record below. recoveredCount is a
        // local tally of this bundle's reconstructions for the response only.
        recoveredCount++;
      }

      await this._put(ctx, `VOTE_${electionId}_${voterId}`, vote);
    }

    election.submittedRecoveryBundles = [...(election.submittedRecoveryBundles || []), trusteeId];
    await this._put(ctx, `ELECTION_${electionId}`, election);

    return JSON.stringify({
      success: true,
      trusteeId,
      submittedCount: election.submittedRecoveryBundles.length,
      threshold: election.trusteeThreshold,
      recovered: recoveredCount > 0,
      recoveredCount,
    });
  }

  /**
   * Get recovery status for all unrevealed voters in an election.
   */
  async GetRecoveryStatus(ctx, electionId, viewerId) {
    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`Election "${electionId}" not found`);
    const effectiveViewerId = viewerId || '';

    const iter = await ctx.stub.getStateByRange(
      `VOTE_${electionId}_`,
      `VOTE_${electionId}_~`
    );
    const status = {};
    let res = await iter.next();
    while (!res.done) {
      const vote = JSON.parse(res.value.value.toString());
      if (!vote.revealed) {
        status[vote.voterId] = {
          submittedCount: vote.submittedShares?.length || 0,
          threshold: election.trusteeThreshold,
          recovered: vote.recovered || false,
          submittedBy: vote.submittedShares?.map((s, i) => {
            // Find which trustee has this share x-value
            for (const [tid] of Object.entries(vote.encryptedTrusteeShares || {})) {
              if (tid === s.trusteeId) return tid;
            }
            return `unknown-${i}`;
          }) || [],
          assignedEncryptedShare: election.trustees.includes(effectiveViewerId)
            ? vote.encryptedTrusteeShares?.[effectiveViewerId] || null
            : null,
        };
      }
      res = await iter.next();
    }
    await iter.close();
    return JSON.stringify(status);
  }

  /**
   * Get elections where a given user is assigned as trustee.
   */
  async GetTrusteeAssignments(ctx, trusteeId) {
    const iter = await ctx.stub.getStateByRange('ELECTION_', 'ELECTION_~');
    const assignments = [];
    let res = await iter.next();
    while (!res.done) {
      const election = JSON.parse(res.value.value.toString());
      if (election.trustees && election.trustees.includes(trusteeId)) {
        assignments.push({
          id: election.id,
          title: election.title,
          phase: election.phase,
          trusteeThreshold: election.trusteeThreshold,
          trusteeCount: election.trusteeCount,
        });
      }
      res = await iter.next();
    }
    await iter.close();
    return JSON.stringify(assignments);
  }

  // ──────────────────── TALLY & RESULTS ─────────────────────

  /** Get current tally (can be called at any phase) — derived from vote records. */
  async GetTally(ctx, electionId) {
    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`No tally for election "${electionId}"`);
    const tally = await this._deriveTally(ctx, electionId, election);
    // Counts are derived, but finalization is a stored fact: carry it across so a
    // finalized tally still reports as finalized after FinalizeTally has run.
    const stored = await this._get(ctx, `TALLY_${electionId}`);
    tally.finalized = Boolean(stored && stored.finalized);
    if (stored && stored.finalizedAt) tally.finalizedAt = stored.finalizedAt;
    return JSON.stringify(tally);
  }

  /** Finalize the tally — marks it as official. Counts are derived from records. */
  async FinalizeTally(ctx, electionId) {
    const election = await this._get(ctx, `ELECTION_${electionId}`);
    if (!election) throw new Error(`Election "${electionId}" not found`);
    if (election.phase !== 'TALLY') throw new Error('Must be in TALLY phase to finalize');

    const tally = await this._deriveTally(ctx, electionId, election);
    tally.finalized = true;
    tally.finalizedAt = this._timestamp(ctx);
    await this._put(ctx, `TALLY_${electionId}`, tally);

    return JSON.stringify(tally);
  }

  /** Return serialized ledger footprint for one election's stored values. */
  async GetStorageStats(ctx, electionId) {
    const electionKey = `ELECTION_${electionId}`;
    const tallyKey = `TALLY_${electionId}`;
    const electionRaw = await ctx.stub.getState(electionKey);
    if (!electionRaw || electionRaw.length === 0) throw new Error(`Election "${electionId}" not found`);

    const tallyRaw = await ctx.stub.getState(tallyKey);
    const voteIter = await ctx.stub.getStateByRange(
      `VOTE_${electionId}_`,
      `VOTE_${electionId}_~`
    );

    let voteCount = 0;
    let voteValueBytes = 0;
    let voteKeyBytes = 0;
    let res = await voteIter.next();
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
      keyCount: 2 + voteCount,
      categories: {
        election: { keyCount: 1, keyBytes: electionKeyBytes, valueBytes: electionValueBytes },
        tally: { keyCount: 1, keyBytes: tallyKeyBytes, valueBytes: tallyValueBytes },
        votes: { keyCount: voteCount, keyBytes: voteKeyBytes, valueBytes: voteValueBytes },
      },
      keyBytes: electionKeyBytes + tallyKeyBytes + voteKeyBytes,
      valueBytes: electionValueBytes + tallyValueBytes + voteValueBytes,
      totalBytes: electionKeyBytes + tallyKeyBytes + voteKeyBytes + electionValueBytes + tallyValueBytes + voteValueBytes,
    });
  }

  // ──────────────────── QUERY HELPERS ───────────────────────

  /** Get a voter's vote status (hides Shamir shares for privacy). */
  async GetVote(ctx, electionId, voterId) {
    const vote = await this._get(ctx, `VOTE_${electionId}_${voterId}`);
    if (!vote) throw new Error('Vote not found');
    const { encryptedTrusteeShares, submittedShares, ...safeVote } = vote; // strip sensitive share data
    safeVote.submittedShareCount = submittedShares?.length || 0;
    return JSON.stringify(safeVote);
  }

  /** List all voters who committed but haven't revealed or been recovered. */
  async GetUnrevealedVoters(ctx, electionId) {
    const iter = await ctx.stub.getStateByRange(
      `VOTE_${electionId}_`,
      `VOTE_${electionId}_~`
    );
    const unrevealed = [];
    let res = await iter.next();
    while (!res.done) {
      const vote = JSON.parse(res.value.value.toString());
      if (!vote.revealed && !vote.recovered) {
        unrevealed.push(vote.voterId);
      }
      res = await iter.next();
    }
    await iter.close();
    return JSON.stringify(unrevealed);
  }
}

module.exports = VivaVoteContract;
