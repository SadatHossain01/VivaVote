/*
 * api.js — API service for communicating with the VivaVote backend
 */

const BASE = '/api';

/** Get the stored auth token */
function getToken() {
  return localStorage.getItem('vivavote_token');
}

/** Make an authenticated fetch request */
async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'API error');
  return data;
}

// ─── Auth ────────────────────────────────────
export const auth = {
  register: (username, password) =>
    apiFetch('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username, password) =>
    apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  me: () => apiFetch('/auth/me'),
  setRecoveryKey: (publicKeyJwk) =>
    apiFetch('/auth/recovery-key', { method: 'POST', body: JSON.stringify({ publicKeyJwk }) }),
  users: () => apiFetch('/auth/users'),
};

// ─── Elections ───────────────────────────────
export const elections = {
  list: () => apiFetch('/elections'),
  get: (id) => apiFetch(`/elections/${id}`),
  create: (data) =>
    apiFetch('/elections', { method: 'POST', body: JSON.stringify(data) }),
  setPhase: (id, phase) =>
    apiFetch(`/elections/${id}/phase`, { method: 'POST', body: JSON.stringify({ phase }) }),
  getMerkleProof: (id, voterId) =>
    apiFetch(`/elections/${id}/merkle-proof/${voterId}`),
};

// ─── Voting ──────────────────────────────────
export const vote = {
  commit: (electionId, commitment, encryptedShares, feldmanCommitments) =>
    apiFetch(`/elections/${electionId}/vote/commit`, {
      method: 'POST', body: JSON.stringify({ commitment, encryptedShares, feldmanCommitments }),
    }),
  reveal: (electionId, candidateId, nonce) =>
    apiFetch(`/elections/${electionId}/vote/reveal`, {
      method: 'POST', body: JSON.stringify({ candidateId, nonce }),
    }),
  status: (electionId, voterId) =>
    apiFetch(`/elections/${electionId}/vote/status/${voterId}`),
  unrevealed: (electionId) =>
    apiFetch(`/elections/${electionId}/vote/unrevealed`),
};

// ─── Trustee ─────────────────────────────────
export const trustee = {
  myElections: () =>
    apiFetch('/elections/trustee/my-elections'),
  status: (electionId) =>
    apiFetch(`/elections/${electionId}/trustee/status`),
  submitShare: (electionId, shares) =>
    apiFetch(`/elections/${electionId}/trustee/submit-share`, {
      method: 'POST', body: JSON.stringify({ shares }),
    }),
};

// ─── Results ─────────────────────────────────
export const results = {
  tally: (electionId) => apiFetch(`/elections/${electionId}/results`),
  finalize: (electionId) =>
    apiFetch(`/elections/${electionId}/results/finalize`, { method: 'POST' }),
};

// ─── Health ──────────────────────────────────
export const health = () => apiFetch('/health');
