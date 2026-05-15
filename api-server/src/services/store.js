/*
 * store.js — Data Store Abstraction
 *
 * This module provides TWO implementations of the same interface:
 *   - MockStore:   In-memory simulation (works without Fabric — great for dev/demo)
 *   - FabricStore: Calls the real Hyperledger Fabric chaincode
 *
 * The API routes use whichever store is active.  Both produce transaction
 * events for the Backend Insight Panel.
 *
 * To switch modes, set the USE_FABRIC=true environment variable.
 */

'use strict';

const crypto = require('crypto');
const { combineShares, verifyShare } = require('./shamir');
const { buildMerkleTree, verifyProof } = require('./merkle');

function elapsedMs(startTime) {
  return Number(process.hrtime.bigint() - startTime) / 1e6;
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function normalizeShare(share) {
  if (!share || typeof share !== 'object') throw new Error('Share must be an object');
  const x = Number(share.x);
  const data = String(share.data || '');
  if (!Number.isInteger(x) || x < 1) throw new Error('Share x must be a positive integer');
  if (!data) throw new Error('Share data is required');
  return { x, data };
}

function hashShare(share) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalizeShare(share)))
    .digest('hex');
}

function normalizeEncryptedShares(election, encryptedShares) {
  if (!encryptedShares || typeof encryptedShares !== 'object' || Array.isArray(encryptedShares)) {
    throw new Error('encryptedShares must be an object keyed by trustee ID');
  }

  const normalized = {};
  for (const trusteeId of election.trustees) {
    const entry = encryptedShares[trusteeId];
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Missing encrypted share for trustee "${trusteeId}"`);
    }
    const ciphertext = String(entry.ciphertext || '');
    const digest = String(entry.hash || '');
    const algorithm = String(entry.algorithm || 'RSA-OAEP-SHA-256');
    if (!ciphertext || !digest) {
      throw new Error(`Encrypted share for trustee "${trusteeId}" must include ciphertext and hash`);
    }
    normalized[trusteeId] = { ciphertext, hash: digest, algorithm };
  }

  return normalized;
}

function normalizeFeldmanCommitments(election, feldmanCommitments) {
  if (!Array.isArray(feldmanCommitments) || !feldmanCommitments.length) {
    throw new Error('feldmanCommitments must be a non-empty array');
  }
  if (feldmanCommitments.length !== election.trusteeThreshold) {
    throw new Error(`Expected ${election.trusteeThreshold} Feldman commitments`);
  }

  return feldmanCommitments.map((commitment) => {
    const normalized = String(commitment || '').toLowerCase();
    if (!/^[0-9a-f]+$/i.test(normalized)) {
      throw new Error('Feldman commitments must be hex strings');
    }
    return normalized;
  });
}

// ═══════════════════════════════════════════════════════════════
// MockStore — Full simulation without Fabric
// ═══════════════════════════════════════════════════════════════

class MockStore {
  constructor(options = {}) {
    const {
      simulateLatency = true,
      latencyRangeMs = [10, 80],
    } = options;
    this.state = new Map();        // world state simulation
    this.txLog = [];               // transaction history
    this.blockNumber = 0;
    this.listeners = [];           // WebSocket event listeners
    this.merkleData = new Map();   // electionId → { root, proofs }
    this.simulateLatency = simulateLatency;
    this.latencyRangeMs = latencyRangeMs;
  }

  /** Register a callback for transaction events */
  onTransaction(cb) { this.listeners.push(cb); }

  /** Emit a transaction event to all listeners */
  _emit(tx) { this.listeners.forEach((cb) => cb(tx)); }

  /** Simulate a blockchain transaction with timing and logging */
  _tx(funcName, args, fn) {
    const start = Date.now();
    const txId = crypto.randomBytes(16).toString('hex');

    return fn().then((result) => {
      const [minDelay, maxDelay] = this.latencyRangeMs;
      const delay = this.simulateLatency
        ? minDelay + Math.random() * Math.max(maxDelay - minDelay, 0)
        : 0;
      return new Promise((resolve) => setTimeout(() => {
        const tx = {
          txId,
          function: funcName,
          args: args.filter((a) => typeof a === 'string' && a.length < 100),
          status: 'VALID',
          blockNumber: ++this.blockNumber,
          latencyMs: Date.now() - start,
          timestamp: new Date().toISOString(),
          stateWrites: 0,
        };
        this.txLog.push(tx);
        this._emit(tx);
        resolve({ result, tx });
      }, delay));
    });
  }

  /** Read from simulated world state */
  _get(key) { return this.state.get(key) || null; }

  /** Write to simulated world state and count the write */
  _put(key, value) { this.state.set(key, value); }

  _hash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  // ─────────────── VivaVote Operations ───────────────────

  async createElection(id, title, candidates, voters, trustees, trusteeThreshold, trusteePublicKeys = {}) {
    return this._tx('CreateElection', [id, title], async () => {
      if (this._get(`ELECTION_${id}`)) throw new Error(`Election "${id}" exists`);
      const n = trustees.length;
      const t = parseInt(trusteeThreshold);
      if (t > n || t < 2) throw new Error('Invalid trustee config: need 2 ≤ T ≤ N');

      // Voters and trustees must not overlap
      const overlap = voters.filter(v => trustees.includes(v));
      if (overlap.length > 0) throw new Error('Users cannot be both voter and trustee: ' + overlap.join(', '));

      const missingTrusteeKeys = trustees.filter((trusteeId) => !trusteePublicKeys[trusteeId]);
      if (missingTrusteeKeys.length > 0) {
        throw new Error('Missing trustee recovery keys: ' + missingTrusteeKeys.join(', '));
      }

      const proofBuildStart = process.hrtime.bigint();
      const { root, proofs } = buildMerkleTree(voters);
      const proofBuildMs = elapsedMs(proofBuildStart);
      this.merkleData.set(id, { root, proofs, voterIds: [...voters] });

      const election = {
        id, title, candidates, merkleRoot: root, phase: 'SETUP',
        trustees,
        trusteePublicKeys,
        trusteeCount: n, trusteeThreshold: t,
        totalVoters: voters.length, totalCommitted: 0, totalRevealed: 0, totalRecovered: 0,
        createdAt: new Date().toISOString(),
        recoveryTargetVoters: [],
        submittedRecoveryBundles: [],
      };
      const tally = { finalized: false };
      candidates.forEach((c) => { tally[c] = 0; });

      this._put(`ELECTION_${id}`, election);
      this._put(`TALLY_${id}`, tally);

      return {
        ...election,
        metrics: {
          proofBuildMs,
          merkleRootBytes: Buffer.from(root, 'hex').length,
        },
      };
    });
  }

  async setMerkleRoot(electionId, voterIds) {
    return this._tx('SetMerkleRoot', [electionId, `${voterIds.length} voters`], async () => {
      const election = this._get(`ELECTION_${electionId}`);
      if (!election) throw new Error('Election not found');
      if (election.phase !== 'SETUP') throw new Error('Not in SETUP phase');

      const { root, proofs } = buildMerkleTree(voterIds);
      this.merkleData.set(electionId, { root, proofs, voterIds: [...voterIds] });

      election.merkleRoot = root;
      election.totalVoters = voterIds.length;
      this._put(`ELECTION_${electionId}`, election);
      return election;
    });
  }

  async setPhase(electionId, newPhase) {
    return this._tx('SetPhase', [electionId, newPhase], async () => {
      const PHASES = ['SETUP', 'COMMIT', 'REVEAL', 'RECOVER', 'TALLY'];
      const election = this._get(`ELECTION_${electionId}`);
      if (!election) throw new Error('Election not found');

      const cur = PHASES.indexOf(election.phase);
      const next = PHASES.indexOf(newPhase);
      if (next <= cur) throw new Error(`Cannot go from ${election.phase} to ${newPhase}`);
      if (election.phase === 'SETUP' && !election.merkleRoot) {
        throw new Error('Set Merkle root first');
      }

      if (newPhase === 'RECOVER') {
        election.recoveryTargetVoters = await this.getUnrevealedVoters(electionId);
        election.submittedRecoveryBundles = [];
      }

      if (election.phase === 'RECOVER' && newPhase === 'TALLY') {
        const pendingTargets = (election.recoveryTargetVoters || []).filter((voterId) => {
          const vote = this._get(`VOTE_${electionId}_${voterId}`);
          return vote && !vote.revealed && !vote.recovered;
        });
        if (pendingTargets.length > 0) {
          throw new Error(`Cannot finalize recovery selectively; pending voters: ${pendingTargets.join(', ')}`);
        }
      }

      election.phase = newPhase;
      this._put(`ELECTION_${electionId}`, election);
      return election;
    });
  }

  async commitVote(electionId, voterId, commitment, encryptedShares, feldmanCommitments) {
    return this._tx('CommitVote', [electionId, voterId], async () => {
      const election = this._get(`ELECTION_${electionId}`);
      if (!election) throw new Error('Election not found');
      if (election.phase !== 'COMMIT') throw new Error('Not in COMMIT phase');
      if (this._get(`VOTE_${electionId}_${voterId}`)) throw new Error('Already voted');
      if (!commitment) throw new Error('commitment required');

      // Verify Merkle proof
      const md = this.merkleData.get(electionId);
      if (!md || !md.proofs[voterId]) throw new Error('Voter not eligible');
      const verificationStart = process.hrtime.bigint();
      const eligible = verifyProof(voterId, md.proofs[voterId], md.root);
      const proofVerificationMs = elapsedMs(verificationStart);
      if (!eligible) {
        throw new Error('Merkle proof invalid');
      }

      const normalizedEncryptedShares = normalizeEncryptedShares(election, encryptedShares);
      const normalizedFeldmanCommitments = normalizeFeldmanCommitments(election, feldmanCommitments);

      const vote = {
        electionId, voterId, commitment,
        encryptedTrusteeShares: normalizedEncryptedShares,
        feldmanCommitments: normalizedFeldmanCommitments,
        submittedShares: [],     // shares submitted by trustees during RECOVER
        revealed: false, recovered: false, vote: null,
        committedAt: new Date().toISOString(),
      };
      this._put(`VOTE_${electionId}_${voterId}`, vote);

      election.totalCommitted++;
      this._put(`ELECTION_${electionId}`, election);

      // Return nonce to voter (they must save this for reveal!)
      return {
        success: true,
        voterId,
        commitment,
        proofVerificationMs,
        proofDepth: md.proofs[voterId].length,
      };
    });
  }

  async revealVote(electionId, voterId, candidateId, nonce) {
    return this._tx('RevealVote', [electionId, voterId], async () => {
      const election = this._get(`ELECTION_${electionId}`);
      if (!election) throw new Error('Election not found');
      if (election.phase !== 'REVEAL') throw new Error('Not in REVEAL phase');

      const vote = this._get(`VOTE_${electionId}_${voterId}`);
      if (!vote) throw new Error('No commitment found');
      if (vote.revealed || vote.recovered) throw new Error('Already counted');

      const hash = this._hash(candidateId + '||' + nonce);
      if (hash !== vote.commitment) throw new Error('Hash mismatch');
      if (!election.candidates.includes(candidateId)) throw new Error('Invalid candidate');

      vote.revealed = true;
      vote.vote = candidateId;
      vote.revealedAt = new Date().toISOString();
      this._put(`VOTE_${electionId}_${voterId}`, vote);

      const tally = this._get(`TALLY_${electionId}`);
      tally[candidateId] = (tally[candidateId] || 0) + 1;
      this._put(`TALLY_${electionId}`, tally);

      election.totalRevealed++;
      this._put(`ELECTION_${electionId}`, election);

      return { success: true, voterId, candidateId };
    });
  }

  async recoverVote(electionId, voterId) {
    return this._tx('TrusteeRecoverVote', [electionId, voterId], async () => {
      const election = this._get(`ELECTION_${electionId}`);
      if (!election) throw new Error('Election not found');
      if (election.phase !== 'RECOVER') throw new Error('Not in RECOVER phase');

      const vote = this._get(`VOTE_${electionId}_${voterId}`);
      if (!vote) throw new Error('No commitment found');
      if (vote.revealed || vote.recovered) throw new Error('Already counted');

      // Check that enough trustee shares have been submitted
      if ((vote.submittedShares || []).length < election.trusteeThreshold) {
        throw new Error(`Not enough shares: ${(vote.submittedShares || []).length}/${election.trusteeThreshold}`);
      }

      // Reconstruct from submitted shares
      const shares = vote.submittedShares.map(s => ({ x: s.x, data: s.data }));
      for (const share of shares) {
        if (!verifyShare(share, vote.feldmanCommitments)) {
          throw new Error('Submitted shares failed Feldman verification');
        }
      }
      const reconstructionStart = process.hrtime.bigint();
      const secret = combineShares(shares);
      const reconstructionMs = elapsedMs(reconstructionStart);
      const [candidateId, ...rest] = secret.split('||');
      const nonce = rest.join('||');

      const hash = this._hash(candidateId + '||' + nonce);
      if (hash !== vote.commitment) throw new Error('Recovery hash mismatch');

      vote.recovered = true;
      vote.vote = candidateId;
      vote.recoveredAt = new Date().toISOString();
      this._put(`VOTE_${electionId}_${voterId}`, vote);

      const tally = this._get(`TALLY_${electionId}`);
      tally[candidateId] = (tally[candidateId] || 0) + 1;
      this._put(`TALLY_${electionId}`, tally);

      election.totalRecovered++;
      this._put(`ELECTION_${electionId}`, election);

      return { success: true, voterId, candidateId, method: 'trustee-recovery', reconstructionMs };
    });
  }

  /**
   * Trustee submits their individual share for a voter's recovery.
   * When threshold is reached, auto-triggers recovery.
   */
  async submitRecoveryBundle(electionId, trusteeId, shares) {
    return this._tx('SubmitRecoveryBundle', [electionId, trusteeId], async () => {
      const election = this._get(`ELECTION_${electionId}`);
      if (!election) throw new Error('Election not found');
      if (election.phase !== 'RECOVER') throw new Error('Not in RECOVER phase');

      if (!election.trustees.includes(trusteeId)) {
        throw new Error('Not a trustee for this election');
      }
      if ((election.submittedRecoveryBundles || []).includes(trusteeId)) {
        throw new Error('Recovery bundle already submitted by this trustee');
      }

      const recoveryTargets = [...(election.recoveryTargetVoters || [])].sort();
      const submittedShares = Array.isArray(shares) ? shares : [];
      const submittedTargets = submittedShares.map((entry) => String(entry?.voterId || '')).sort();

      if (submittedTargets.length !== recoveryTargets.length) {
        throw new Error('Recovery bundle must include every unrevealed voter in the recovery set');
      }
      if (JSON.stringify(submittedTargets) !== JSON.stringify(recoveryTargets)) {
        throw new Error('Recovery bundle voter set does not match the election recovery targets');
      }

      let recoveredCount = 0;
      let reconstructionMs = 0;

      for (const entry of submittedShares) {
        const voterId = String(entry.voterId || '');
        const vote = this._get(`VOTE_${electionId}_${voterId}`);
        if (!vote) throw new Error(`No commitment found for voter "${voterId}"`);

        const assignment = vote.encryptedTrusteeShares?.[trusteeId];
        if (!assignment) {
          throw new Error(`No encrypted share assigned to trustee "${trusteeId}" for voter "${voterId}"`);
        }

        const share = normalizeShare(entry.share);
        if (hashShare(share) !== assignment.hash) {
          throw new Error(`Submitted share failed integrity verification for voter "${voterId}"`);
        }
        if (!verifyShare(share, vote.feldmanCommitments)) {
          throw new Error(`Submitted share failed Feldman verification for voter "${voterId}"`);
        }

        if (!vote.submittedShares) vote.submittedShares = [];
        if (!vote.submittedShares.some((submitted) => submitted.trusteeId === trusteeId)) {
          vote.submittedShares.push({
            trusteeId,
            x: share.x,
            data: share.data,
            submittedAt: new Date().toISOString(),
          });
        }

        if (!vote.revealed && !vote.recovered && vote.submittedShares.length >= election.trusteeThreshold) {
          const reconstructionStart = process.hrtime.bigint();
          const secret = combineShares(vote.submittedShares.map((submitted) => ({ x: submitted.x, data: submitted.data })));
          reconstructionMs += elapsedMs(reconstructionStart);
          const [candidateId, ...rest] = secret.split('||');
          const nonce = rest.join('||');
          const hash = this._hash(candidateId + '||' + nonce);

          if (hash !== vote.commitment) {
            throw new Error(`Recovery hash mismatch for voter "${voterId}"`);
          }
          if (!election.candidates.includes(candidateId)) {
            throw new Error(`Recovered invalid candidate for voter "${voterId}"`);
          }

          vote.recovered = true;
          vote.vote = candidateId;
          vote.recoveredAt = new Date().toISOString();

          const tally = this._get(`TALLY_${electionId}`);
          tally[candidateId] = (tally[candidateId] || 0) + 1;
          this._put(`TALLY_${electionId}`, tally);

          election.totalRecovered++;
          recoveredCount++;
        }

        this._put(`VOTE_${electionId}_${voterId}`, vote);
      }

      election.submittedRecoveryBundles = [...(election.submittedRecoveryBundles || []), trusteeId];
      this._put(`ELECTION_${electionId}`, election);

      return {
        success: true,
        trusteeId,
        submittedCount: election.submittedRecoveryBundles.length,
        threshold: election.trusteeThreshold,
        recovered: recoveredCount > 0,
        recoveredCount,
        reconstructionMs,
      };
    });
  }

  async verifyVoterEligibility(electionId, voterId) {
    const election = this._get(`ELECTION_${electionId}`);
    if (!election) throw new Error('Election not found');

    const md = this.merkleData.get(electionId);
    if (!md || !md.proofs[voterId]) throw new Error('Voter not eligible');

    const start = process.hrtime.bigint();
    const eligible = verifyProof(voterId, md.proofs[voterId], md.root);
    return {
      eligible,
      proofVerificationMs: elapsedMs(start),
      proofDepth: md.proofs[voterId].length,
    };
  }

  /** Get recovery status for a specific voter */
  async getRecoveryStatus(electionId, voterId, viewerId) {
    const vote = this._get(`VOTE_${electionId}_${voterId}`);
    if (!vote) throw new Error('No commitment found');
    const election = this._get(`ELECTION_${electionId}`);
    return {
      voterId,
      submittedCount: (vote.submittedShares || []).length,
      threshold: election.trusteeThreshold,
      submittedBy: (vote.submittedShares || []).map(s => s.trusteeId),
      recovered: vote.recovered,
      assignedEncryptedShare: election.trustees.includes(viewerId)
        ? vote.encryptedTrusteeShares?.[viewerId] || null
        : null,
    };
  }

  /** Get elections where a user is assigned as trustee */
  async getTrusteeAssignments(trusteeId) {
    const assignments = [];
    for (const [key, val] of this.state) {
      if (key.startsWith('ELECTION_') && val.trustees?.includes(trusteeId)) {
        assignments.push({
          electionId: val.id,
          title: val.title,
          phase: val.phase,
          trusteeThreshold: val.trusteeThreshold,
          trusteeCount: val.trusteeCount,
          totalCommitted: val.totalCommitted,
          totalRevealed: val.totalRevealed,
          totalRecovered: val.totalRecovered,
        });
      }
    }
    return assignments;
  }

  async getElection(electionId) {
    const e = this._get(`ELECTION_${electionId}`);
    if (!e) throw new Error('Election not found');
    return e;
  }

  async getAllElections() {
    const elections = [];
    for (const [key, val] of this.state) {
      if (key.startsWith('ELECTION_')) elections.push(val);
    }
    return elections;
  }

  async getTally(electionId) {
    const t = this._get(`TALLY_${electionId}`);
    if (!t) throw new Error('Tally not found');
    return t;
  }

  async finalizeTally(electionId) {
    return this._tx('FinalizeTally', [electionId], async () => {
      const election = this._get(`ELECTION_${electionId}`);
      if (!election) throw new Error('Election not found');
      if (election.phase !== 'TALLY') throw new Error('Not in TALLY phase');

      const tally = this._get(`TALLY_${electionId}`);
      tally.finalized = true;
      tally.totalCommitted = election.totalCommitted;
      tally.totalRevealed = election.totalRevealed;
      tally.totalRecovered = election.totalRecovered;
      tally.finalizedAt = new Date().toISOString();
      this._put(`TALLY_${electionId}`, tally);
      return tally;
    });
  }

  async getVoteStatus(electionId, voterId) {
    const v = this._get(`VOTE_${electionId}_${voterId}`);
    if (!v) return null;
    const { encryptedTrusteeShares, submittedShares, ...safe } = v;
    // Include recovery progress
    safe.submittedShareCount = (submittedShares || []).length;
    return safe;
  }

  async getUnrevealedVoters(electionId) {
    const unrevealed = [];
    for (const [key, val] of this.state) {
      if (key.startsWith(`VOTE_${electionId}_`) && !val.revealed && !val.recovered) {
        unrevealed.push(val.voterId);
      }
    }
    return unrevealed;
  }

  async getMerkleProof(electionId, voterId) {
    const md = this.merkleData.get(electionId);
    if (!md) throw new Error('No Merkle tree for this election');
    const proof = md.proofs[voterId];
    if (!proof) throw new Error('Voter not in Merkle tree');
    return { proof, root: md.root };
  }

  async getStorageStats(electionId) {
    const election = this._get(`ELECTION_${electionId}`);
    if (!election) throw new Error('Election not found');

    const categories = {
      election: { keyCount: 0, keyBytes: 0, valueBytes: 0 },
      tally: { keyCount: 0, keyBytes: 0, valueBytes: 0 },
      votes: { keyCount: 0, keyBytes: 0, valueBytes: 0 },
    };

    for (const [key, value] of this.state.entries()) {
      let bucket = null;
      if (key === `ELECTION_${electionId}`) bucket = categories.election;
      else if (key === `TALLY_${electionId}`) bucket = categories.tally;
      else if (key.startsWith(`VOTE_${electionId}_`)) bucket = categories.votes;
      if (!bucket) continue;
      bucket.keyCount++;
      bucket.keyBytes += Buffer.byteLength(key);
      bucket.valueBytes += serializedBytes(value);
    }

    const keyBytes = Object.values(categories).reduce((sum, bucket) => sum + bucket.keyBytes, 0);
    const valueBytes = Object.values(categories).reduce((sum, bucket) => sum + bucket.valueBytes, 0);
    const keyCount = Object.values(categories).reduce((sum, bucket) => sum + bucket.keyCount, 0);

    return { categories, keyBytes, valueBytes, totalBytes: keyBytes + valueBytes, keyCount };
  }

  // ─────────────── Baseline Operations ───────────────────

  async baselineCreateElection(id, title, candidates) {
    return this._tx('Baseline.CreateElection', [id, title], async () => {
      const election = {
        id, title, candidates, phase: 'SETUP',
        totalVoters: 0, totalCommitted: 0, totalRevealed: 0,
        createdAt: new Date().toISOString(),
      };
      const tally = { finalized: false };
      candidates.forEach((c) => { tally[c] = 0; });
      this._put(`BELECTION_${id}`, election);
      this._put(`BTALLY_${id}`, tally);
      return election;
    });
  }

  async baselineRegisterVoters(electionId, voterIds) {
    return this._tx('Baseline.RegisterVoterBatch', [electionId, `${voterIds.length} voters`], async () => {
      const election = this._get(`BELECTION_${electionId}`);
      if (!election) throw new Error('Election not found');
      // O(N) writes — one per voter!
      for (const id of voterIds) {
        this._put(`BVOTER_${electionId}_${id}`, { registered: true });
      }
      election.totalVoters += voterIds.length;
      this._put(`BELECTION_${electionId}`, election);
      return { registered: voterIds.length, stateWrites: voterIds.length };
    });
  }

  async baselineSetPhase(electionId, phase) {
    return this._tx('Baseline.SetPhase', [electionId, phase], async () => {
      const PHASES = ['SETUP', 'COMMIT', 'REVEAL', 'TALLY'];
      const election = this._get(`BELECTION_${electionId}`);
      if (!election) throw new Error('Election not found');
      const cur = PHASES.indexOf(election.phase);
      const next = PHASES.indexOf(phase);
      if (next <= cur) throw new Error('Cannot go backward');
      election.phase = phase;
      this._put(`BELECTION_${electionId}`, election);
      return election;
    });
  }

  async baselineCommitVote(electionId, voterId, candidateId) {
    return this._tx('Baseline.CommitVote', [electionId, voterId], async () => {
      const election = this._get(`BELECTION_${electionId}`);
      if (!election) throw new Error('Election not found');
      if (election.phase !== 'COMMIT') throw new Error('Not in COMMIT phase');

      const voter = this._get(`BVOTER_${electionId}_${voterId}`);
      if (!voter) throw new Error('Voter not registered');
      if (this._get(`BVOTE_${electionId}_${voterId}`)) throw new Error('Already voted');

      const nonce = crypto.randomBytes(16).toString('hex');
      const commitment = this._hash(candidateId + '||' + nonce);

      this._put(`BVOTE_${electionId}_${voterId}`, {
        commitment, revealed: false, vote: null,
        committedAt: new Date().toISOString(),
      });
      election.totalCommitted++;
      this._put(`BELECTION_${electionId}`, election);

      return { success: true, voterId, nonce, commitment };
    });
  }

  async baselineRevealVote(electionId, voterId, candidateId, nonce) {
    return this._tx('Baseline.RevealVote', [electionId, voterId], async () => {
      const election = this._get(`BELECTION_${electionId}`);
      if (!election) throw new Error('Election not found');
      if (election.phase !== 'REVEAL') throw new Error('Not in REVEAL phase');

      const vote = this._get(`BVOTE_${electionId}_${voterId}`);
      if (!vote) throw new Error('No commitment');
      if (vote.revealed) throw new Error('Already revealed');

      const hash = this._hash(candidateId + '||' + nonce);
      if (hash !== vote.commitment) throw new Error('Hash mismatch');

      vote.revealed = true;
      vote.vote = candidateId;
      this._put(`BVOTE_${electionId}_${voterId}`, vote);

      const tally = this._get(`BTALLY_${electionId}`);
      tally[candidateId] = (tally[candidateId] || 0) + 1;
      this._put(`BTALLY_${electionId}`, tally);

      election.totalRevealed++;
      this._put(`BELECTION_${electionId}`, election);

      return { success: true, voterId, candidateId };
    });
  }

  async baselineGetTally(electionId) {
    return this._get(`BTALLY_${electionId}`);
  }

  async baselineGetStorageStats(electionId) {
    const election = this._get(`BELECTION_${electionId}`);
    if (!election) throw new Error('Election not found');

    const categories = {
      election: { keyCount: 0, keyBytes: 0, valueBytes: 0 },
      tally: { keyCount: 0, keyBytes: 0, valueBytes: 0 },
      voters: { keyCount: 0, keyBytes: 0, valueBytes: 0 },
      votes: { keyCount: 0, keyBytes: 0, valueBytes: 0 },
    };

    for (const [key, value] of this.state.entries()) {
      let bucket = null;
      if (key === `BELECTION_${electionId}`) bucket = categories.election;
      else if (key === `BTALLY_${electionId}`) bucket = categories.tally;
      else if (key.startsWith(`BVOTER_${electionId}_`)) bucket = categories.voters;
      else if (key.startsWith(`BVOTE_${electionId}_`)) bucket = categories.votes;
      if (!bucket) continue;
      bucket.keyCount++;
      bucket.keyBytes += Buffer.byteLength(key);
      bucket.valueBytes += serializedBytes(value);
    }

    const keyBytes = Object.values(categories).reduce((sum, bucket) => sum + bucket.keyBytes, 0);
    const valueBytes = Object.values(categories).reduce((sum, bucket) => sum + bucket.valueBytes, 0);
    const keyCount = Object.values(categories).reduce((sum, bucket) => sum + bucket.keyCount, 0);

    return { categories, keyBytes, valueBytes, totalBytes: keyBytes + valueBytes, keyCount };
  }

  // ─────────────── Metrics ───────────────────────────────

  getMetrics() {
    const txs = this.txLog;
    if (!txs.length) return { totalTx: 0, avgLatencyMs: 0, throughputTps: 0, stateSize: 0 };

    const avgLatency = txs.reduce((s, t) => s + t.latencyMs, 0) / txs.length;
    const timeSpanMs = txs.length > 1
      ? new Date(txs[txs.length - 1].timestamp) - new Date(txs[0].timestamp)
      : 1000;
    const tps = txs.length / (timeSpanMs / 1000);

    return {
      totalTx: txs.length,
      avgLatencyMs: Math.round(avgLatency),
      throughputTps: Math.round(tps * 100) / 100,
      stateSize: this.state.size,
      blockHeight: this.blockNumber,
    };
  }

  getTransactionLog(limit = 50) {
    return this.txLog.slice(-limit);
  }
}

// ═══════════════════════════════════════════════════════════════
// FabricStore — Real Hyperledger Fabric (used when USE_FABRIC=true)
// ═══════════════════════════════════════════════════════════════

class FabricStore {
  constructor(vivavoteContract, baselineContract) {
    this.vivavote = vivavoteContract;
    this.baseline = baselineContract;
    this.txLog = [];
    this.blockNumber = 0;
    this.listeners = [];
    this.merkleData = new Map();
  }

  onTransaction(cb) { this.listeners.push(cb); }
  _emit(tx) { this.listeners.forEach((cb) => cb(tx)); }

  async _submit(contract, func, ...args) {
    const start = Date.now();
    const result = await contract.submitTransaction(func, ...args);
    const tx = {
      txId: crypto.randomBytes(16).toString('hex'),
      function: func,
      args: args.filter((a) => a.length < 100),
      status: 'VALID',
      blockNumber: ++this.blockNumber,
      latencyMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    };
    this.txLog.push(tx);
    this._emit(tx);
    return { result: JSON.parse(Buffer.from(result).toString()), tx };
  }

  async _evaluate(contract, func, ...args) {
    const result = await contract.evaluateTransaction(func, ...args);
    return JSON.parse(Buffer.from(result).toString());
  }

  // VivaVote operations delegate to the chaincode
  async createElection(id, title, candidates, voters, trustees, trusteeThreshold, trusteePublicKeys = {}) {
    // Build Merkle tree from voter list (keep proofs client-side for eligibility checks)
    const overlap = voters.filter(v => trustees.includes(v));
    if (overlap.length > 0) throw new Error('Users cannot be both voter and trustee: ' + overlap.join(', '));

    const proofBuildStart = process.hrtime.bigint();
    const { root, proofs } = buildMerkleTree(voters);
    const proofBuildMs = elapsedMs(proofBuildStart);
    this.merkleData.set(id, { root, proofs, voterIds: [...voters] });

    const response = await this._submit(this.vivavote, 'CreateElection',
      id, title, JSON.stringify(candidates), root, String(voters.length),
      JSON.stringify(trustees), String(trusteeThreshold), JSON.stringify(trusteePublicKeys));
    return {
      ...response,
      result: {
        ...response.result,
        metrics: {
          proofBuildMs,
          merkleRootBytes: Buffer.from(root, 'hex').length,
        },
      },
    };
  }

  async setMerkleRoot(electionId, voterIds) {
    const proofBuildStart = process.hrtime.bigint();
    const { root, proofs } = buildMerkleTree(voterIds);
    const proofBuildMs = elapsedMs(proofBuildStart);
    this.merkleData.set(electionId, { root, proofs, voterIds: [...voterIds] });
    const response = await this._submit(this.vivavote, 'SetMerkleRoot', electionId, root, String(voterIds.length));
    return {
      ...response,
      result: {
        ...response.result,
        metrics: {
          proofBuildMs,
          merkleRootBytes: Buffer.from(root, 'hex').length,
        },
      },
    };
  }

  async setPhase(electionId, phase) {
    return this._submit(this.vivavote, 'SetPhase', electionId, phase);
  }

  async commitVote(electionId, voterId, commitment, encryptedShares, feldmanCommitments) {
    const md = this.merkleData.get(electionId);
    if (!md || !md.proofs[voterId]) throw new Error('Voter not eligible');

    const { tx } = await this._submit(this.vivavote, 'CommitVote',
      electionId, voterId, commitment,
      JSON.stringify(md.proofs[voterId]),
      JSON.stringify(encryptedShares),
      JSON.stringify(feldmanCommitments));

    return {
      result: {
        success: true,
        voterId,
        commitment,
        proofDepth: md.proofs[voterId].length,
      },
      tx,
    };
  }

  async revealVote(electionId, voterId, candidateId, nonce) {
    return this._submit(this.vivavote, 'RevealVote', electionId, voterId, candidateId, nonce);
  }

  async recoverVote(electionId, voterId) {
    const response = await this._submit(this.vivavote, 'TrusteeRecoverVote', electionId, voterId);
    return {
      ...response,
      result: {
        ...response.result,
        recoveryTxMs: response.tx?.latencyMs ?? null,
      },
    };
  }

  async submitRecoveryBundle(electionId, trusteeId, shares) {
    const response = await this._submit(
      this.vivavote,
      'SubmitRecoveryBundle',
      electionId,
      trusteeId,
      JSON.stringify(shares),
    );
    return {
      ...response,
      result: {
        ...response.result,
        recoveryTxMs: response.tx?.latencyMs ?? null,
      },
    };
  }

  async verifyVoterEligibility(electionId, voterId) {
    const md = this.merkleData.get(electionId);
    if (!md || !md.proofs[voterId]) throw new Error('Voter not eligible');
    const start = process.hrtime.bigint();
    const result = await this._evaluate(
      this.vivavote,
      'VerifyVoter',
      electionId,
      voterId,
      JSON.stringify(md.proofs[voterId])
    );
    return {
      ...result,
      proofVerificationMs: elapsedMs(start),
      proofDepth: md.proofs[voterId].length,
    };
  }

  async getRecoveryStatus(electionId, voterId, viewerId) {
    // Chaincode returns recovery status for all unrevealed voters; filter client-side if needed
    const allStatus = await this._evaluate(this.vivavote, 'GetRecoveryStatus', electionId, viewerId || '');
    if (voterId && allStatus[voterId]) {
      return allStatus[voterId];
    }
    return allStatus;
  }

  async getTrusteeAssignments(trusteeId) {
    const assignments = await this._evaluate(this.vivavote, 'GetTrusteeAssignments', trusteeId);
    // Normalize chaincode field "id" → "electionId" to match MockStore / frontend
    return assignments.map(a => ({ ...a, electionId: a.electionId || a.id }));
  }

  async getElection(electionId) {
    return this._evaluate(this.vivavote, 'GetElection', electionId);
  }

  async getAllElections() {
    return this._evaluate(this.vivavote, 'GetAllElections');
  }

  async getTally(electionId) {
    return this._evaluate(this.vivavote, 'GetTally', electionId);
  }

  async finalizeTally(electionId) {
    return this._submit(this.vivavote, 'FinalizeTally', electionId);
  }

  async getVoteStatus(electionId, voterId) {
    try {
      return await this._evaluate(this.vivavote, 'GetVote', electionId, voterId);
    } catch { return null; }
  }

  async getUnrevealedVoters(electionId) {
    return this._evaluate(this.vivavote, 'GetUnrevealedVoters', electionId);
  }

  async getMerkleProof(electionId, voterId) {
    const md = this.merkleData.get(electionId);
    if (!md) throw new Error('No Merkle tree');
    if (!md.proofs[voterId]) throw new Error('Voter not in tree');
    return { proof: md.proofs[voterId], root: md.root };
  }

  async getStorageStats(electionId) {
    return this._evaluate(this.vivavote, 'GetStorageStats', electionId);
  }

  // Baseline operations
  async baselineCreateElection(id, title, candidates) {
    return this._submit(this.baseline, 'CreateElection', id, title, JSON.stringify(candidates));
  }

  async baselineRegisterVoters(electionId, voterIds) {
    return this._submit(this.baseline, 'RegisterVoterBatch', electionId, JSON.stringify(voterIds));
  }

  async baselineSetPhase(electionId, phase) {
    return this._submit(this.baseline, 'SetPhase', electionId, phase);
  }

  async baselineCommitVote(electionId, voterId, candidateId) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const commitment = crypto.createHash('sha256').update(candidateId + '||' + nonce).digest('hex');
    const { tx } = await this._submit(this.baseline, 'CommitVote', electionId, voterId, commitment);
    return { result: { success: true, voterId, nonce, commitment }, tx };
  }

  async baselineRevealVote(electionId, voterId, candidateId, nonce) {
    return this._submit(this.baseline, 'RevealVote', electionId, voterId, candidateId, nonce);
  }

  async baselineGetTally(electionId) {
    return this._evaluate(this.baseline, 'GetTally', electionId);
  }

  async baselineGetStorageStats(electionId) {
    return this._evaluate(this.baseline, 'GetStorageStats', electionId);
  }

  getMetrics() {
    const txs = this.txLog;
    if (!txs.length) return { totalTx: 0, avgLatencyMs: 0, throughputTps: 0, stateSize: 0 };
    const avgLatency = txs.reduce((s, t) => s + t.latencyMs, 0) / txs.length;
    const timeSpanMs = txs.length > 1
      ? new Date(txs[txs.length - 1].timestamp) - new Date(txs[0].timestamp) : 1000;
    return {
      totalTx: txs.length,
      avgLatencyMs: Math.round(avgLatency),
      throughputTps: Math.round((txs.length / (timeSpanMs / 1000)) * 100) / 100,
      stateSize: 0, // would need CouchDB query in real Fabric
      blockHeight: this.blockNumber,
    };
  }

  getTransactionLog(limit = 50) {
    return this.txLog.slice(-limit);
  }
}

module.exports = { MockStore, FabricStore };
