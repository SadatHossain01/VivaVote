/*
 * merkle.js — On-chain Merkle Proof Verification
 *
 * HOW IT WORKS:
 *   1. An admin builds a Merkle tree of voter IDs OFF-CHAIN and stores only
 *      the 32-byte root hash on the blockchain (O(1) storage).
 *   2. When a voter wants to cast a ballot, they present their voter ID along
 *      with a Merkle proof — a list of sibling hashes from their leaf up to
 *      the root.
 *   3. This module recomputes the root from the leaf + proof and checks it
 *      against the stored root.  If they match, the voter is eligible.
 *
 * COMPLEXITY:
 *   - Storing N voters on-chain the naive way: O(N) writes  ← expensive
 *   - Storing one Merkle root on-chain:        O(1) write   ← our approach
 *   - Verifying one voter's proof:             O(log N) hashes ← fast
 */

'use strict';

const crypto = require('crypto');

/**
 * Compute SHA-256 of arbitrary data and return the raw Buffer (32 bytes).
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * Verify a Merkle proof.
 *
 * @param {string} leaf        — The raw voter ID string (e.g. "voter_42")
 * @param {Array}  proof       — Array of { position: 'left'|'right', hash: 'hex' }
 * @param {string} expectedRoot — The Merkle root stored on-chain (hex string)
 * @returns {boolean}          — true if the proof is valid
 *
 * The algorithm:
 *   hash = SHA256(leaf)
 *   for each sibling in the proof:
 *     if sibling is on the RIGHT → hash = SHA256(hash + sibling)
 *     if sibling is on the LEFT  → hash = SHA256(sibling + hash)
 *   return (hash === expectedRoot)
 */
function verifyMerkleProof(leaf, proof, expectedRoot) {
  // Step 1: Hash the raw leaf (voter ID) to get the leaf node
  let hash = sha256(Buffer.from(leaf));

  // Step 2: Walk up the tree, combining with each sibling
  for (const step of proof) {
    const sibling = Buffer.from(step.hash, 'hex');

    if (step.position === 'right') {
      // Our node is LEFT, sibling is RIGHT
      hash = sha256(Buffer.concat([hash, sibling]));
    } else {
      // Sibling is LEFT, our node is RIGHT
      hash = sha256(Buffer.concat([sibling, hash]));
    }
  }

  // Step 3: The final hash should equal the stored root
  return hash.toString('hex') === expectedRoot;
}

module.exports = { sha256, verifyMerkleProof, buildMerkleTree };

/**
 * Build a Merkle tree from a list of voter IDs and return the root hash.
 * This is a minimal on-chain implementation — only produces the root,
 * not individual proofs (those are built off-chain by the API server).
 *
 * @param {string[]} voterIds — Array of voter ID strings
 * @returns {{ root: string }} — hex-encoded Merkle root
 */
function buildMerkleTree(voterIds) {
  if (!voterIds || !voterIds.length) return { root: '' };

  // Hash each voter ID to get leaf nodes
  let level = voterIds.map((id) => sha256(Buffer.from(id)));

  // Build tree bottom-up: pair adjacent nodes and hash together
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(sha256(Buffer.concat([level[i], level[i + 1]])));
      } else {
        // Odd node — promote as-is
        next.push(level[i]);
      }
    }
    level = next;
  }

  return { root: level[0].toString('hex') };
}
