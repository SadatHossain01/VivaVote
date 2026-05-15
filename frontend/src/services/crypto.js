const KEY_PREFIX = 'vivavote_recovery_key_';

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

function utf8Bytes(value) {
	return new TextEncoder().encode(value);
}

function utf8String(bytes) {
	return new TextDecoder().decode(bytes);
}

function bytesToHex(bytes) {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBigInt(bytes) {
	const hex = bytesToHex(bytes);
	return hex ? BigInt(`0x${hex}`) : 0n;
}

function bigIntToBytes(value) {
	if (value === 0n) return new Uint8Array();
	let hex = value.toString(16);
	if (hex.length % 2 !== 0) hex = `0${hex}`;
	const bytes = new Uint8Array(hex.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

function bytesToBase64(bytes) {
	let binary = '';
	bytes.forEach((byte) => {
		binary += String.fromCharCode(byte);
	});
	return btoa(binary);
}

function base64ToBytes(value) {
	const binary = atob(value);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
	return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
	return base64ToBytes(padded);
}

function normalizeShare(share) {
	return {
		x: Number(share.x),
		data: String(share.data),
	};
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

function randomScalar() {
	while (true) {
		const candidate = bytesToBigInt(crypto.getRandomValues(new Uint8Array(FIELD_ORDER_BYTES)));
		if (candidate > 0n && candidate < FIELD_ORDER) {
			return candidate;
		}
	}
}

function secretToScalar(secret) {
	const bytes = utf8Bytes(secret);
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
	return utf8String(bigIntToBytes(scalar));
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
	for (let index = 0; index < points.length; index += 1) {
		let numerator = 1n;
		let denominator = 1n;
		for (let inner = 0; inner < points.length; inner += 1) {
			if (index === inner) continue;
			numerator = mod(numerator * points[inner].x);
			denominator = mod(denominator * (points[inner].x - points[index].x));
		}
		const basis = mod(numerator * modInverse(denominator));
		secret = mod(secret + (points[index].value * basis));
	}
	return secret;
}

async function sha256Hex(value) {
	const digest = await crypto.subtle.digest('SHA-256', utf8Bytes(value));
	return bytesToHex(new Uint8Array(digest));
}

export function splitSecret(secret, shareCount, threshold) {
	return splitSecretWithCommitments(secret, shareCount, threshold).shares;
}

export function splitSecretWithCommitments(secret, shareCount, threshold) {
	if (threshold > shareCount) throw new Error('Threshold must be less than or equal to the share count');
	if (threshold < 2) throw new Error('Threshold must be at least 2');

	const coefficients = [secretToScalar(secret)];
	for (let index = 1; index < threshold; index += 1) {
		coefficients.push(randomScalar());
	}

	const shares = Array.from({ length: shareCount }, (_, index) => ({
		x: index + 1,
		data: bytesToBase64Url(bigIntToBytes(evalPolynomial(coefficients, BigInt(index + 1)))),
	}));

	const commitments = coefficients.map((coefficient) => modPow(GENERATOR, coefficient, PRIME).toString(16));
	return { shares, commitments };
}

export async function hashShare(share) {
	return sha256Hex(JSON.stringify(normalizeShare(share)));
}

export function verifyShare(share, commitments) {
	const normalizedShare = normalizeShare(share);
	const x = BigInt(normalizedShare.x);
	const y = bytesToBigInt(base64UrlToBytes(normalizedShare.data));
	const normalizedCommitments = normalizeCommitments(commitments);

	let rhs = 1n;
	let exponent = 1n;
	for (const commitment of normalizedCommitments) {
		rhs = (rhs * modPow(commitment.value, exponent, PRIME)) % PRIME;
		exponent = mod(exponent * x);
	}

	return modPow(GENERATOR, y, PRIME) === rhs;
}

export function combineShares(shares) {
	if (!Array.isArray(shares) || !shares.length) throw new Error('No shares provided');
	const points = shares.map((share) => {
		const normalizedShare = normalizeShare(share);
		return {
			x: BigInt(normalizedShare.x),
			value: bytesToBigInt(base64UrlToBytes(normalizedShare.data)),
		};
	});
	return scalarToSecret(interpolateAtZero(points));
}

export function generateNonce(byteLength = 16) {
	const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
	return bytesToHex(bytes);
}

export async function generateCommitment(candidateId, nonce) {
	return sha256Hex(`${candidateId}||${nonce}`);
}

async function exportKeyPair(keyPair) {
	const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
	const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
	return { publicKeyJwk, privateKeyJwk };
}

async function generateRecoveryKeyPair() {
	const keyPair = await crypto.subtle.generateKey(
		{
			name: 'RSA-OAEP',
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: 'SHA-256',
		},
		true,
		['encrypt', 'decrypt'],
	);

	return exportKeyPair(keyPair);
}

export async function getOrCreateRecoveryKeyPair(username) {
	const storageKey = `${KEY_PREFIX}${username}`;
	const existing = localStorage.getItem(storageKey);
	if (existing) {
		return JSON.parse(existing);
	}

	const generated = await generateRecoveryKeyPair();
	localStorage.setItem(storageKey, JSON.stringify(generated));
	return generated;
}

export async function ensureRecoveryKeyRegistered(username, registerPublicKey) {
	const keyPair = await getOrCreateRecoveryKeyPair(username);
	await registerPublicKey(keyPair.publicKeyJwk);
	return keyPair;
}

async function importPublicKey(publicKeyJwk) {
	return crypto.subtle.importKey(
		'jwk',
		publicKeyJwk,
		{ name: 'RSA-OAEP', hash: 'SHA-256' },
		true,
		['encrypt'],
	);
}

async function importPrivateKey(privateKeyJwk) {
	return crypto.subtle.importKey(
		'jwk',
		privateKeyJwk,
		{ name: 'RSA-OAEP', hash: 'SHA-256' },
		true,
		['decrypt'],
	);
}

export async function encryptShareForTrustee(share, publicKeyJwk) {
	const normalizedShare = normalizeShare(share);
	const key = await importPublicKey(publicKeyJwk);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'RSA-OAEP' },
		key,
		utf8Bytes(JSON.stringify(normalizedShare)),
	);

	return {
		ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
		hash: await hashShare(normalizedShare),
		algorithm: 'RSA-OAEP-SHA-256',
	};
}

export async function decryptAssignedShare(envelope, privateKeyJwk) {
	const key = await importPrivateKey(privateKeyJwk);
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'RSA-OAEP' },
		key,
		base64ToBytes(envelope.ciphertext),
	);

	return normalizeShare(JSON.parse(utf8String(new Uint8Array(plaintext))));
}

export async function buildCommitPayload({ candidateId, trusteeIds, trusteePublicKeys, threshold }) {
	if (!candidateId) throw new Error('candidateId is required');
	if (!Array.isArray(trusteeIds) || !trusteeIds.length) throw new Error('trusteeIds are required');

	const nonce = generateNonce();
	const secret = `${candidateId}||${nonce}`;
	const { shares, commitments } = splitSecretWithCommitments(secret, trusteeIds.length, threshold);
	const encryptedShares = {};

	for (let index = 0; index < trusteeIds.length; index += 1) {
		const trusteeId = trusteeIds[index];
		const publicKeyJwk = trusteePublicKeys?.[trusteeId];
		if (!publicKeyJwk) throw new Error(`Missing recovery key for trustee "${trusteeId}"`);
		encryptedShares[trusteeId] = await encryptShareForTrustee(shares[index], publicKeyJwk);
	}

	return {
		nonce,
		commitment: await generateCommitment(candidateId, nonce),
		feldmanCommitments: commitments,
		encryptedShares,
	};
}
