/*
 * app.js — VivaVote API Server Entry Point
 *
 * This is the main Express application that serves the REST API
 * and WebSocket connections for the VivaVote voting system.
 *
 * MODES:
 *   - Mock mode (default):  USE_FABRIC is not set → uses in-memory store
 *   - Fabric mode:          USE_FABRIC=true → connects to Hyperledger Fabric
 *
 * Both modes expose the same API and emit the same WebSocket events,
 * so the frontend works identically in either mode.
 */

'use strict';

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');

const { MockStore, FabricStore } = require('./services/store');

// Route factories
const authRoutes = require('./routes/auth');
const createElectionRoutes = require('./routes/elections');
const createVoteRoutes = require('./routes/vote');
const createResultsRoutes = require('./routes/results');

const PORT = process.env.PORT || 4000;
const USE_FABRIC = process.env.USE_FABRIC === 'true';

async function main() {
  // ─── Initialize Store ─────────────────────────────────
  let store;

  if (USE_FABRIC) {
    console.log('🔗 Connecting to Hyperledger Fabric...');
    const { connectToFabric } = require('./config/connection');
    const { vivavoteContract, baselineContract } = await connectToFabric();
    store = new FabricStore(vivavoteContract, baselineContract);
    console.log('✅ Fabric mode active');
  } else {
    store = new MockStore();
    console.log('🧪 Mock mode active (set USE_FABRIC=true for blockchain)');
  }

  // ─── Express App ──────────────────────────────────────
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      mode: USE_FABRIC ? 'fabric' : 'mock',
      uptime: process.uptime(),
    });
  });

  // Mount routes
  app.use('/api/auth', authRoutes);
  app.use('/api/elections', createElectionRoutes(store));
  app.use('/api/elections', createVoteRoutes(store));
  app.use('/api/elections', createResultsRoutes(store));

  // ─── HTTP + WebSocket Server ──────────────────────────
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Track connected WebSocket clients
  const clients = new Set();
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({
      type: 'connected',
      mode: USE_FABRIC ? 'fabric' : 'mock',
      timestamp: new Date().toISOString(),
    }));
    ws.on('close', () => clients.delete(ws));
  });

  // Forward transaction events to all WebSocket clients
  store.onTransaction((tx) => {
    const message = JSON.stringify({ type: 'transaction', data: tx });
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(message); // 1 = OPEN
    }
  });

  // ─── Start Server ────────────────────────────────────
  server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════╗
║                 🗳️  VivaVote API                  ║
╠═══════════════════════════════════════════════════╣
║  REST API:    http://localhost:${PORT}/api          ║
║  WebSocket:   ws://localhost:${PORT}/ws             ║
║  Mode:        ${(USE_FABRIC ? 'Hyperledger Fabric' : 'Mock (in-memory) ').padEnd(22)}       ║
║  Health:      http://localhost:${PORT}/api/health   ║
╚═══════════════════════════════════════════════════╝
    `);
  });
}

main().catch((err) => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});
