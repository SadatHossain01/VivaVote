/*
 * auth.routes.js — Authentication endpoints
 *
 * POST /api/auth/register  — Create a new account
 * POST /api/auth/login     — Get a JWT token
 * GET  /api/auth/me        — Check current session
 */

'use strict';

const { Router } = require('express');
const {
  registerUser,
  loginUser,
  getAllUsers,
  getUser,
  setRecoveryPublicKey,
  authMiddleware,
  adminOnly,
} = require('../middleware/auth');

const router = Router();

router.post('/register', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const data = registerUser(username, password);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const data = loginUser(username, password);
    res.json(data);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

router.get('/me', authMiddleware, (req, res) => {
  const user = getUser(req.user.username);
  res.json({ user: user ? {
    username: user.username,
    role: user.role,
    hasRecoveryKey: Boolean(user.recoveryPublicKey),
  } : req.user });
});

router.post('/recovery-key', authMiddleware, (req, res) => {
  try {
    const { publicKeyJwk } = req.body;
    const user = setRecoveryPublicKey(req.user.username, publicKeyJwk);
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// List all registered users (admin only — for selecting voters/trustees)
router.get('/users', authMiddleware, adminOnly, (req, res) => {
  res.json(getAllUsers());
});

module.exports = router;
