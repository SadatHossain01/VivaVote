/*
 * elections.routes.js — Election CRUD & Lifecycle
 *
 * POST /api/elections                      — Create election (admin)
 * GET  /api/elections                      — List all elections
 * GET  /api/elections/:id                  — Get one election
 * POST /api/elections/:id/merkle-root      — Upload voter list & build Merkle tree (admin)
 * POST /api/elections/:id/phase            — Advance election phase (admin)
 * GET  /api/elections/:id/merkle-proof/:voterId — Get a voter's Merkle proof
 */

'use strict';

const { Router } = require('express');
const { authMiddleware, adminOnly, getUserPublicKeys } = require('../middleware/auth');

module.exports = function createElectionRoutes(store) {
  const router = Router();

  // Create a new election (with voters and trustees)
  router.post('/', authMiddleware, adminOnly, async (req, res) => {
    try {
      const { id, title, candidates, voters = [], trustees = [], trusteeThreshold = 2 } = req.body;
      if (!id || !title || !candidates?.length) {
        return res.status(400).json({ error: 'id, title, and candidates[] required' });
      }
      if (!voters.length) {
        return res.status(400).json({ error: 'voters[] required' });
      }
      if (!trustees.length) {
        return res.status(400).json({ error: 'trustees[] required' });
      }
      const trusteePublicKeys = getUserPublicKeys(trustees);
      const missingTrusteeKeys = trustees.filter((trustee) => !trusteePublicKeys[trustee]);
      if (missingTrusteeKeys.length) {
        return res.status(400).json({
          error: `Trustees must register recovery keys before election creation: ${missingTrusteeKeys.join(', ')}`,
        });
      }
      const { result } = await store.createElection(
        id,
        title,
        candidates,
        voters,
        trustees,
        trusteeThreshold,
        trusteePublicKeys,
      );
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // List all elections
  router.get('/', async (req, res) => {
    try {
      const elections = await store.getAllElections();
      res.json(elections);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get single election
  router.get('/:id', async (req, res) => {
    try {
      const election = await store.getElection(req.params.id);
      res.json(election);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // Upload voter list → build Merkle tree → store root on-chain
  // This is the O(1) registration step!
  router.post('/:id/merkle-root', authMiddleware, adminOnly, async (req, res) => {
    try {
      const { voterIds } = req.body;
      if (!voterIds?.length) return res.status(400).json({ error: 'voterIds[] required' });
      const { result } = await store.setMerkleRoot(req.params.id, voterIds);
      res.json({
        message: `Merkle tree built for ${voterIds.length} voters. Only the root is stored on-chain!`,
        election: result,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Advance election phase
  router.post('/:id/phase', authMiddleware, adminOnly, async (req, res) => {
    try {
      const { phase } = req.body;
      if (!phase) return res.status(400).json({ error: 'phase required' });
      const { result } = await store.setPhase(req.params.id, phase);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Get a voter's Merkle proof
  router.get('/:id/merkle-proof/:voterId', async (req, res) => {
    try {
      const data = await store.getMerkleProof(req.params.id, req.params.voterId);
      res.json(data);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  return router;
};
