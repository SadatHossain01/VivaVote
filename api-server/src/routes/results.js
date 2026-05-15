/*
 * results.routes.js — Election Results & Tally
 *
 * GET  /api/elections/:id/results          — Get current tally
 * POST /api/elections/:id/results/finalize — Finalize the tally (admin)
 */

'use strict';

const { Router } = require('express');
const { authMiddleware, adminOnly } = require('../middleware/auth');

module.exports = function createResultsRoutes(store) {
  const router = Router();

  // Get current tally
  router.get('/:id/results', async (req, res) => {
    try {
      const tally = await store.getTally(req.params.id);
      res.json(tally);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // Finalize tally
  router.post('/:id/results/finalize', authMiddleware, adminOnly, async (req, res) => {
    try {
      const { result } = await store.finalizeTally(req.params.id);
      res.json({ message: 'Tally finalized!', tally: result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
