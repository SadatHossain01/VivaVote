/*
 * shamir.js — Feldman-verifiable secret sharing helpers
 *
 * Shares are generated with Shamir secret sharing over a large prime field
 * so the chaincode can validate each trustee share against Feldman
 * commitments before reconstruction.
 */

'use strict';

const crypto = require('crypto');

// 1024-bit safe-prime group keeps share envelopes small enough for RSA-OAEP-2048.
const PRIME_HEX = [
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E08',
  '8A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B',
  '302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9',
  'A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE6',
  '49286651ECE65381FFFFFFFFFFFFFFFF',
].join('');

const PRIME = BigInt(`0x${PRIME_HEX}`);
const FIELD_ORDER = (PRIME - 1n) / 2n;
const GENERATOR = 4n;
const FIELD_ORDER_BYTES = Math.ceil(FIELD_ORDER.toString(16).length / 2);
const MAX_SECRET_BYTES = Math.floor((FIELD_ORDER.toString(2).length - 1) / 8);

function mod(value, modulus = FIELD_ORDER) {
  const reduced = value % modulus;
  return reduced >= 0n ? reduced : reduced + modulus;
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let factor = mod(base, modulus);
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = (result * factor) % modulus;
    factor = (factor * factor) % modulus;
    power >>= 1n;
  }
  return result;
}

function modInverse(value, modulus = FIELD_ORDER) {
  let t = 0n;
  let newT = 1n;
  let r = modulus;
  let newR = mod(value, modulus);

  while (newR !== 0n) {
    const quotient = r / newR;
    [t, newT] = [newT, t - quotient * newT];
    [r, newR] = [newR, r - quotient * newR];
  }

  if (r !== 1n) throw new Error('Value is not invertible');
  return t < 0n ? t + modulus : t;
}

function bytesToBigInt(bytes) {
  const hex = Buffer.from(bytes).toString('hex');
  return hex ? BigInt(`0x${hex}`) : 0n;
}

function bigIntToBuffer(value) {
  if (value === 0n) return Buffer.alloc(0);
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  return Buffer.from(hex, 'hex');
}

function shareValueToString(value) {
  return bigIntToBuffer(value).toString('base64url');
}

function shareStringToValue(data) {
  if (!/^[A-Za-z0-9_-]+$/u.test(data)) throw new Error('Share data must be base64url-encoded');
  return bytesToBigInt(Buffer.from(data, 'base64url'));
}

function randomScalar() {
  while (true) {
    const candidate = bytesToBigInt(crypto.randomBytes(FIELD_ORDER_BYTES));
    if (candidate > 0n && candidate < FIELD_ORDER) {
      return candidate;
    }
  }
}

function secretToScalar(secret) {
  const bytes = Buffer.from(secret, 'utf8');
  if (!bytes.length) throw new Error('Secret must not be empty');
  if (bytes.length > MAX_SECRET_BYTES) {
    throw new Error(`Secret is too large for Feldman sharing (max ${MAX_SECRET_BYTES} bytes)`);
  }
  const scalar = bytesToBigInt(bytes);
  if (scalar <= 0n || scalar >= FIELD_ORDER) {
    throw new Error('Secret does not fit in the sharing field');
  }
  return scalar;
}

function scalarToSecret(scalar) {
  return bigIntToBuffer(scalar).toString('utf8');
}

function normalizeShare(share) {
  if (!share || typeof share !== 'object') throw new Error('Share must be an object');
  const x = BigInt(share.x);
  const data = String(share.data || '');
  if (x < 1n || x >= FIELD_ORDER) throw new Error('Share x is out of range');
  const value = shareStringToValue(data);
  if (value >= FIELD_ORDER) throw new Error('Share value is out of range');
  return { x, data, value };
}

function normalizeCommitments(commitments) {
  if (!Array.isArray(commitments) || !commitments.length) {
    throw new Error('Feldman commitments are required');
  }
  return commitments.map((commitment) => {
    const hex = String(commitment || '').toLowerCase();
    if (!/^[0-9a-f]+$/i.test(hex)) throw new Error('Commitment must be hex-encoded');
    const value = BigInt(`0x${hex}`);
    if (value <= 1n || value >= PRIME) throw new Error('Commitment is out of range');
    if (modPow(value, FIELD_ORDER, PRIME) !== 1n) {
      throw new Error('Commitment is not in the expected subgroup');
    }
    return { hex, value };
  });
}

function evalPolynomial(coefficients, x) {
  let result = 0n;
  for (let index = coefficients.length - 1; index >= 0; index -= 1) {
    result = mod(coefficients[index] + (result * x));
  }
  return result;
}

function interpolateAtZero(points) {
  let secret = 0n;
  for (let i = 0; i < points.length; i += 1) {
    let numerator = 1n;
    let denominator = 1n;
    for (let j = 0; j < points.length; j += 1) {
      if (i === j) continue;
      numerator = mod(numerator * points[j].x);
      denominator = mod(denominator * (points[j].x - points[i].x));
    }
    const basis = mod(numerator * modInverse(denominator));
    secret = mod(secret + (points[i].value * basis));
  }
  return secret;
}

function splitSecretWithCommitments(secret, n, t) {
  if (t > n) throw new Error('Threshold (t) must be ≤ total shares (n)');
  if (t < 2) throw new Error('Threshold must be ≥ 2');

  const coefficients = [secretToScalar(secret)];
  for (let index = 1; index < t; index += 1) {
    coefficients.push(randomScalar());
  }

  const shares = Array.from({ length: n }, (_, index) => {
    const x = BigInt(index + 1);
    return {
      x: index + 1,
      data: shareValueToString(evalPolynomial(coefficients, x)),
    };
  });

  const commitments = coefficients.map((coefficient) => modPow(GENERATOR, coefficient, PRIME).toString(16));
  return { shares, commitments };
}

/**
 * Split a secret string into N shares with a reconstruction threshold of T.
 *
 * @param {string} secret  — The secret to protect (e.g. "CandidateA||abc123nonce")
 * @param {number} n       — Total number of shares to create  (e.g. 5)
 * @param {number} t       — Minimum shares to reconstruct     (e.g. 3)
 * @returns {Array<{ x: number, data: string }>}
 *   Each share has:
 *     x    — the evaluation point (1, 2, ..., N)
 *     data — base64url-encoded field element
 */
function splitSecret(secret, n, t) {
  return splitSecretWithCommitments(secret, n, t).shares;
}

/**
 * Reconstruct the secret from T or more shares.
 *
 * @param {Array<{ x: number, data: string }>} shares — At least T shares
 * @returns {string} The original secret string
 */
function combineShares(shares) {
  if (shares.length === 0) throw new Error('No shares provided');

  const points = shares.map((share) => normalizeShare(share));
  return scalarToSecret(interpolateAtZero(points));
}

function verifyShare(share, commitments) {
  const normalizedShare = normalizeShare(share);
  const normalizedCommitments = normalizeCommitments(commitments);

  let rhs = 1n;
  let exponent = 1n;
  for (const commitment of normalizedCommitments) {
    rhs = (rhs * modPow(commitment.value, exponent, PRIME)) % PRIME;
    exponent = mod(exponent * normalizedShare.x);
  }

  const lhs = modPow(GENERATOR, normalizedShare.value, PRIME);
  return lhs === rhs;
}

module.exports = {
  MAX_SECRET_BYTES,
  splitSecret,
  splitSecretWithCommitments,
  combineShares,
  verifyShare,
};
