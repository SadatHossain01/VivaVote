'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { MockStore } = require('./store');
const { splitSecretWithCommitments } = require('./shamir');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function generateTrusteeKeys(trustees) {
  const publicKeys = {};
  const privateKeys = {};

  for (const trusteeId of trustees) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    publicKeys[trusteeId] = publicKey;
    privateKeys[trusteeId] = privateKey;
  }

  return { publicKeys, privateKeys };
}

function encryptShare(share, publicKey) {
  const serialized = JSON.stringify(share);
  const ciphertext = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(serialized, 'utf8'),
  ).toString('base64');

  return {
    ciphertext,
    hash: sha256Hex(JSON.stringify(share)),
    algorithm: 'RSA-OAEP-SHA-256',
    plaintextBytes: Buffer.byteLength(serialized),
  };
}

function decryptShare(envelope, privateKey) {
  const plaintext = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(envelope.ciphertext, 'base64'),
  ).toString('utf8');

  return JSON.parse(plaintext);
}

function tamperShare(share) {
  const bytes = Buffer.from(share.data, 'base64url');
  bytes[bytes.length - 1] ^= 1;
  return {
    ...share,
    data: bytes.toString('base64url'),
  };
}

async function createCommittedElection({ electionId, mutateTrusteeId = null }) {
  const store = new MockStore({ simulateLatency: false });
  const trustees = ['trustee1', 'trustee2', 'trustee3'];
  const { publicKeys, privateKeys } = generateTrusteeKeys(trustees);

  await store.createElection(
    electionId,
    'Feldman Validation',
    ['candA', 'candB'],
    ['voter1'],
    trustees,
    2,
    publicKeys,
  );
  await store.setPhase(electionId, 'COMMIT');

  const nonce = `${electionId}-nonce`;
  const secret = `candA||${nonce}`;
  const commitment = sha256Hex(secret);
  const { shares, commitments } = splitSecretWithCommitments(secret, trustees.length, 2);
  const encryptedShares = {};

  trustees.forEach((trusteeId, index) => {
    const share = trusteeId === mutateTrusteeId ? tamperShare(shares[index]) : shares[index];
    encryptedShares[trusteeId] = encryptShare(share, publicKeys[trusteeId]);
  });

  assert.ok(
    Object.values(encryptedShares).every((entry) => entry.plaintextBytes < 190),
    'serialized shares must fit RSA-OAEP-2048',
  );

  await store.commitVote(electionId, 'voter1', commitment, encryptedShares, commitments);
  await store.setPhase(electionId, 'REVEAL');
  await store.setPhase(electionId, 'RECOVER');

  return { store, trustees, privateKeys, encryptedShares };
}

test('MockStore rejects committed shares that fail Feldman verification', async () => {
  const { store, privateKeys, encryptedShares } = await createCommittedElection({
    electionId: 'feldman-invalid',
    mutateTrusteeId: 'trustee1',
  });

  await assert.rejects(
    () => store.submitRecoveryBundle('feldman-invalid', 'trustee1', [{
      voterId: 'voter1',
      share: decryptShare(encryptedShares.trustee1, privateKeys.trustee1),
    }]),
    /Feldman verification/,
  );
});

test('MockStore recovers valid Feldman shares at threshold', async () => {
  const { store, privateKeys, encryptedShares } = await createCommittedElection({
    electionId: 'feldman-valid',
  });

  const firstBundle = await store.submitRecoveryBundle('feldman-valid', 'trustee1', [{
    voterId: 'voter1',
    share: decryptShare(encryptedShares.trustee1, privateKeys.trustee1),
  }]);
  assert.equal(firstBundle.result.recovered, false);

  const secondBundle = await store.submitRecoveryBundle('feldman-valid', 'trustee2', [{
    voterId: 'voter1',
    share: decryptShare(encryptedShares.trustee2, privateKeys.trustee2),
  }]);
  assert.equal(secondBundle.result.recovered, true);
  assert.equal(secondBundle.result.recoveredCount, 1);

  const tally = await store.getTally('feldman-valid');
  assert.equal(tally.candA, 1);
  assert.equal(tally.candB, 0);
});