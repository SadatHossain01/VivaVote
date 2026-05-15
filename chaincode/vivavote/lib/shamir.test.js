const test = require('node:test');
const assert = require('node:assert/strict');

const {
  splitSecretWithCommitments,
  combineShares,
  verifyShare,
} = require('./shamir');

test('Feldman shares verify and reconstruct at threshold', () => {
  const secret = 'Candidate A||nonce-1234567890abcdef';
  const { shares, commitments } = splitSecretWithCommitments(secret, 5, 3);

  assert.equal(shares.length, 5);
  assert.equal(commitments.length, 3);
  assert.ok(shares.every((share) => verifyShare(share, commitments)));
  assert.equal(combineShares(shares.slice(0, 3)), secret);
});

test('Feldman verification rejects tampered shares', () => {
  const secret = 'Candidate B||nonce-fedcba0987654321';
  const { shares, commitments } = splitSecretWithCommitments(secret, 4, 2);
  const shareBytes = Buffer.from(shares[0].data, 'base64url');
  shareBytes[shareBytes.length - 1] ^= 1;
  const tamperedShare = {
    ...shares[0],
    data: shareBytes.toString('base64url'),
  };

  assert.equal(verifyShare(tamperedShare, commitments), false);
});