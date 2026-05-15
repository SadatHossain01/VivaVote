/*
 * auth.js — Simple JWT Authentication Middleware
 *
 * This is a PROTOTYPE auth system.  In production, you'd integrate with
 * Fabric CA for proper identity enrollment.  Here we use JWT tokens
 * backed by a simple in-memory user store.
 */

'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'vivavote-dev-secret-change-in-production';

// In-memory user database (persists only while server is running)
const users = new Map();

function publicUser(user) {
  return {
    username: user.username,
    role: user.role,
    hasRecoveryKey: Boolean(user.recoveryPublicKey),
  };
}

// Pre-seed an admin account
users.set('admin', { username: 'admin', password: 'admin', role: 'admin' });

// Pre-seed 10 demo voter accounts for convenience
for (let i = 1; i <= 10; i++) {
  const username = `voter_${i}`;
  users.set(username, { username, password: '123', role: 'user' });
}

/**
 * Register a new user (always role='user').
 * Admin account is pre-seeded and cannot be registered.
 */
function registerUser(username, password) {
  if (users.has(username)) throw new Error('Username already taken');
  if (username.toLowerCase() === 'admin') throw new Error('Reserved username');
  const user = { username, password, role: 'user' };
  users.set(username, user);
  const token = jwt.sign({ username, role: 'user' }, JWT_SECRET, { expiresIn: '24h' });
  return { token, user: publicUser(user) };
}

/**
 * List all registered non-admin users (for admin to assign as voters/trustees).
 */
function getAllUsers() {
  const result = [];
  for (const [, user] of users) {
    if (user.role !== 'admin') result.push(publicUser(user));
  }
  return result;
}

function getUser(username) {
  return users.get(username) || null;
}

function setRecoveryPublicKey(username, recoveryPublicKey) {
  const user = users.get(username);
  if (!user) throw new Error('User not found');
  if (!recoveryPublicKey || typeof recoveryPublicKey !== 'object') {
    throw new Error('recoveryPublicKey must be a JWK object');
  }
  user.recoveryPublicKey = recoveryPublicKey;
  return publicUser(user);
}

function getUserPublicKeys(usernames) {
  const result = {};
  for (const username of usernames) {
    const user = users.get(username);
    if (user?.recoveryPublicKey) {
      result[username] = user.recoveryPublicKey;
    }
  }
  return result;
}

/**
 * Authenticate and return a JWT.
 */
function loginUser(username, password) {
  const user = users.get(username);
  if (!user || user.password !== password) throw new Error('Invalid credentials');
  const token = jwt.sign({ username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  return { token, user: publicUser(user) };
}

/**
 * Express middleware: verify JWT and attach user info to req.user
 */
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token provided' });

  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = users.get(decoded.username);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = publicUser(user);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Express middleware: require admin role.
 */
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = {
  registerUser,
  loginUser,
  getAllUsers,
  getUser,
  getUserPublicKeys,
  setRecoveryPublicKey,
  authMiddleware,
  adminOnly,
};
