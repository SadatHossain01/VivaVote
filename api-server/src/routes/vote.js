/*
 * vote.routes.js — Voting & Trustee Endpoints
 *
 * POST /api/elections/:id/vote/commit      — Submit blinded vote commitment
 * POST /api/elections/:id/vote/reveal      — Reveal your vote
 * GET  /api/elections/:id/vote/status/:v   — Check a voter's status
 * GET  /api/elections/:id/vote/unrevealed  — List voters who haven't revealed
 * POST /api/elections/:id/trustee/submit-share  — Trustee submits their election-wide recovery bundle
 * GET  /api/elections/:id/trustee/status        — Recovery status for all unrevealed voters
 * GET  /api/elections/trustee/my-elections       — Elections where user is trustee
 */

'use strict';

const { Router } = require('express');
const { authMiddleware, adminOnly } = require('../middleware/auth');

module.exports = function createVoteRoutes(store) {
  const router = Router();

  // ─── Trustee assignments (must be before /:id routes) ──────
  router.get('/trustee/my-elections', authMiddleware, async (req, res) => {
    try {
      const assignments = await store.getTrusteeAssignments(req.user.username);
      res.json(assignments);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── COMMIT: Voter submits a blinded vote ──────────────────
  router.post('/:id/vote/commit', authMiddleware, async (req, res) => {
    try {
      const { commitment, encryptedShares, feldmanCommitments } = req.body;
      const voterId = req.user.username;
      if (!commitment || !encryptedShares || !feldmanCommitments) {
        return res.status(400).json({ error: 'commitment, encryptedShares, and feldmanCommitments required' });
      }

      const { result } = await store.commitVote(req.params.id, voterId, commitment, encryptedShares, feldmanCommitments);
      res.json({
        message: 'Vote committed. Keep your local receipt for the reveal phase.',
        commitment: result.commitment,
        voterId: result.voterId,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── REVEAL: Voter proves their vote ───────────────────────
  router.post('/:id/vote/reveal', authMiddleware, async (req, res) => {
    try {
      const { candidateId, nonce } = req.body;
      const voterId = req.user.username;
      if (!candidateId || !nonce) {
        return res.status(400).json({ error: 'candidateId and nonce required' });
      }
      const { result } = await store.revealVote(req.params.id, voterId, candidateId, nonce);
      res.json({ message: 'Vote revealed and counted!', ...result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── TRUSTEE: Submit share for a voter's recovery ──────────
  router.post('/:id/trustee/submit-share', authMiddleware, async (req, res) => {
    try {
      const { shares } = req.body;
      const trusteeId = req.user.username;
      if (!Array.isArray(shares) || !shares.length) {
        return res.status(400).json({ error: 'shares[] required' });
      }
      const { result } = await store.submitRecoveryBundle(req.params.id, trusteeId, shares);
      res.json({ message: 'Recovery bundle submitted successfully', ...result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── TRUSTEE: Get recovery status for unrevealed voters ────
  router.get('/:id/trustee/status', authMiddleware, async (req, res) => {
    try {
      const unrevealed = await store.getUnrevealedVoters(req.params.id);
      const statuses = [];
      for (const vid of unrevealed) {
        const status = await store.getRecoveryStatus(req.params.id, vid, req.user.username);
        statuses.push({ voterId: vid, ...status });
      }
      const election = await store.getElection(req.params.id);
      res.json({
        unrevealed: statuses,
        trusteeId: req.user.username,
        bundleSubmitted: (election.submittedRecoveryBundles || []).includes(req.user.username),
        recoveryTargetCount: (election.recoveryTargetVoters || []).length,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── Check a voter's status ────────────────────────────────
  router.get('/:id/vote/status/:voterId', authMiddleware, async (req, res) => {
    try {
      const status = await store.getVoteStatus(req.params.id, req.params.voterId);
      res.json(status || { committed: false });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // ─── List unrevealed voters ────────────────────────────────
  router.get('/:id/vote/unrevealed', authMiddleware, async (req, res) => {
    try {
      const unrevealed = await store.getUnrevealedVoters(req.params.id);
      res.json({ unrevealed, count: unrevealed.length });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
