/*
 * merkle.js — Off-chain Merkle Tree Builder
 *
 * HOW IT'S USED:
 *   1. Admin uploads a list of eligible voter IDs
 *   2. This module builds a Merkle tree from those IDs
 *   3. The ROOT is stored on-chain (just 32 bytes!)
 *   4. Individual PROOFS are cached so each voter can fetch theirs
 *
 * The tree is built using SHA-256.  Each leaf is SHA256(voterId).
 * merkletreejs handles the tree construction and proof generation.
 */

'use strict';

const crypto = require('crypto');
const { MerkleTree } = require('merkletreejs');

/** SHA-256 hash returning a Buffer */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * Build a Merkle tree from a list of voter IDs and return the root
 * plus individual proofs for each voter.
 *
 * @param {string[]} voterIds — Array of voter ID strings
 * @returns {{ root: string, proofs: Object, tree: MerkleTree }}
 *   root   — hex-encoded Merkle root (stored on-chain)
 *   proofs — { voterId: [{position, hash}, ...] } for each voter
 */
function buildMerkleTree(voterIds) {
  if (!voterIds.length) throw new Error('Voter list is empty');

  // Hash each voter ID to get leaf nodes
  const leaves = voterIds.map((id) => sha256(Buffer.from(id)));

  // Build the tree (sortPairs=false for deterministic order)
  const tree = new MerkleTree(leaves, sha256, { sortPairs: false });
  const root = tree.getRoot().toString('hex');

  // Generate and cache a proof for each voter
  const proofs = {};
  for (const id of voterIds) {
    const leaf = sha256(Buffer.from(id));
    const proof = tree.getProof(leaf);

    // Convert to a JSON-friendly format: [{position, hash}, ...]
    proofs[id] = proof.map((step) => ({
      position: step.position,              // 'left' or 'right'
      hash: step.data.toString('hex'),      // sibling hash as hex
    }));
  }

  return { root, proofs, tree };
}

/**
 * Verify a Merkle proof (mirrors the chaincode's on-chain verification).
 * Useful for client-side pre-checks before submitting to the blockchain.
 */
function verifyProof(voterId, proof, root) {
  let hash = sha256(Buffer.from(voterId));

  for (const step of proof) {
    const sibling = Buffer.from(step.hash, 'hex');
    if (step.position === 'right') {
      hash = sha256(Buffer.concat([hash, sibling]));
    } else {
      hash = sha256(Buffer.concat([sibling, hash]));
    }
  }

  return hash.toString('hex') === root;
}

module.exports = { buildMerkleTree, verifyProof, sha256 };
