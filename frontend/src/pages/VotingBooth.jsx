import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { elections as elApi, vote as voteApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { buildCommitPayload } from '../services/crypto';

/* localStorage key for persisting the commit receipt across page reloads */
const receiptKey = (electionId, username) => `vivavote_receipt_${electionId}_${username}`;

export default function VotingBooth() {
  const { id } = useParams();
  const { user } = useAuth();
  const [election, setElection] = useState(null);
  const [eligibility, setEligibility] = useState({ checked: false, eligible: false });
  const [selected, setSelected] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /* Fields for the reveal form (may be auto-filled from saved receipt) */
  const [revealCandidate, setRevealCandidate] = useState('');
  const [revealNonce, setRevealNonce] = useState('');

  /* ── Load election + voter status + saved receipt ── */
  useEffect(() => {
    let cancelled = false;

    async function loadElectionContext() {
      try {
        const loadedElection = await elApi.get(id);
        if (cancelled) return;
        setElection(loadedElection);

        if (!user) return;
        if (user.role === 'admin' || loadedElection.trustees?.includes(user.username)) {
          setEligibility({ checked: true, eligible: false });
          return;
        }

        try {
          await elApi.getMerkleProof(id, user.username);
          if (!cancelled) setEligibility({ checked: true, eligible: true });
        } catch {
          if (!cancelled) setEligibility({ checked: true, eligible: false });
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    }

    loadElectionContext();

    if (user) {
      // Fetch server-side status first, then reconcile with localStorage
      voteApi.status(id, user.username)
        .then((serverStatus) => {
          setStatus(serverStatus);

          // Restore receipt from localStorage
          try {
            const saved = localStorage.getItem(receiptKey(id, user.username));
            if (saved) {
              const parsed = JSON.parse(saved);
              // If server has no commitment, this receipt is stale (server restarted) — discard it
              if (!serverStatus?.commitment) {
                localStorage.removeItem(receiptKey(id, user.username));
              } else {
                setReceipt(parsed);
                setSelected(parsed.candidateId || '');
                setRevealCandidate(parsed.candidateId || '');
                setRevealNonce(parsed.nonce || '');
              }
            }
          } catch { /* ignore corrupt data */ }
        })
        .catch(() => {});
    }

      return () => { cancelled = true; };
  }, [id, user]);

  /* ── COMMIT handler ── */
  const handleCommit = async () => {
    setError('');
    setLoading(true);
    try {
      const payload = await buildCommitPayload({
        candidateId: selected,
        trusteeIds: election.trustees,
        trusteePublicKeys: election.trusteePublicKeys,
        threshold: election.trusteeThreshold,
      });
      const data = await voteApi.commit(id, payload.commitment, payload.encryptedShares, payload.feldmanCommitments);
      const savedReceipt = {
        ...data,
        candidateId: selected,
        nonce: payload.nonce,
      };
      setReceipt(savedReceipt);
      setRevealCandidate(selected);
      setRevealNonce(payload.nonce);

      // Persist so the voter can reveal even after navigating away
      localStorage.setItem(receiptKey(id, user.username), JSON.stringify(savedReceipt));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  /* ── REVEAL handler ── */
  const handleReveal = async () => {
    if (!revealCandidate || !revealNonce) {
      setError('Candidate and nonce are required to reveal.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await voteApi.reveal(id, revealCandidate, revealNonce);
      setStatus({ revealed: true, vote: revealCandidate });
      setReceipt(null);
      localStorage.removeItem(receiptKey(id, user.username));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!election || !eligibility.checked) return <p className="text-civic-dim text-center mt-20 font-mono text-sm">Loading…</p>;

  /* ── Access control: admin and trustees cannot vote ── */
  const isAdmin = user?.role === 'admin';
  const isTrustee = election.trustees?.includes(user?.username);
  const isVoter = eligibility.eligible;
  const isNonVoter = isAdmin || isTrustee || !isVoter;

  if (isNonVoter) {
    // During TALLY, everyone can see results
    if (election.phase === 'TALLY') {
      return (
        <div className="max-w-md mx-auto mt-20 animate-fade-up">
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-civic-teal/10 border border-civic-teal/20 flex items-center justify-center mx-auto mb-6">
              <span className="text-civic-teal text-2xl">✓</span>
            </div>
            <h2 className="font-display text-2xl mb-2">Election Finalized</h2>
            <p className="text-sm text-civic-muted mb-4">
              This election has concluded. View the final results below.
            </p>
            <Link to={`/elections/${id}/results`} className="civic-btn-primary inline-block px-6 py-2">
              View Results →
            </Link>
          </div>
        </div>
      );
    }

    return (
      <div className="max-w-md mx-auto mt-20 animate-fade-up">
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-civic-surface border border-civic-border flex items-center justify-center mx-auto mb-6">
            <span className="text-civic-dim text-2xl">⊘</span>
          </div>
          <h2 className="font-display text-2xl mb-2">Not a Voter</h2>
          <p className="text-sm text-civic-muted">
            {isAdmin && 'Admins cannot vote in elections.'}
            {isTrustee && 'Trustees are responsible for vote recovery, not voting.'}
            {!isAdmin && !isTrustee && 'You are not in the voter list for this election.'}
          </p>
        </div>
      </div>
    );
  }

  /* ── Already voted (revealed or recovered) ── */
  if (status?.revealed || status?.recovered) {
    return (
      <div className="max-w-md mx-auto mt-20 animate-fade-up">
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-civic-teal/10 border border-civic-teal/20 flex items-center justify-center mx-auto mb-6">
            <span className="text-civic-teal text-2xl">✓</span>
          </div>
          <h2 className="font-display text-2xl mb-2">Vote Recorded</h2>
          <p className="text-sm text-civic-muted mb-2">
            Your vote for <span className="text-civic-gold font-mono">{status.vote}</span> has been
            {status.recovered ? ' recovered by trustees' : ' revealed'} and counted.
          </p>
          <Link to={`/elections/${id}/results`} className="text-xs text-civic-gold hover:text-civic-gold-light transition-colors">
            View Results →
          </Link>
        </div>
      </div>
    );
  }

  /* Has this voter already committed? (from server status) */
  const hasCommitted = !!(status?.commitment);

  return (
    <div className="max-w-xl mx-auto animate-fade-up">
      <p className="text-[11px] uppercase tracking-[0.2em] text-civic-dim mb-2 font-mono">Voting Booth</p>
      <h1 className="font-display text-3xl mb-2">{election.title}</h1>
      <div className="flex items-center gap-4 text-[11px] font-mono text-civic-dim mb-8">
        <span>Phase: <span className="text-civic-gold">{election.phase}</span></span>
        <span className="text-civic-border">│</span>
        <span>Voter: <span className="text-civic-muted">{user?.username}</span></span>
      </div>

      {error && (
        <div className="bg-civic-coral/10 border border-civic-coral/20 text-civic-coral text-sm rounded px-4 py-3 mb-6">
          {error}
        </div>
      )}

      {/* ── Phase gate: SETUP / RECOVER / TALLY ── */}
      {election.phase !== 'COMMIT' && election.phase !== 'REVEAL' && (
        <div className="civic-card p-8 text-center">
          <p className="text-civic-muted text-sm">
            {election.phase === 'SETUP' && 'Voting has not started. Waiting for COMMIT phase.'}
            {election.phase === 'RECOVER' && 'Reveal phase is over. Trustee recovery in progress.'}
            {election.phase === 'TALLY' && 'Election is finalized.'}
          </p>
          {election.phase === 'TALLY' && (
            <Link to={`/elections/${id}/results`} className="text-xs text-civic-gold mt-3 inline-block hover:text-civic-gold-light">
              View Results →
            </Link>
          )}
        </div>
      )}

      {/* ── COMMIT: Select candidate ── */}
      {election.phase === 'COMMIT' && !receipt && !hasCommitted && (
        <>
          <p className="text-[11px] uppercase tracking-[0.15em] text-civic-dim mb-4">Select Your Candidate</p>
          <div className="space-y-2 mb-6">
            {election.candidates.map((c) => (
              <button
                key={c}
                onClick={() => setSelected(c)}
                className={`w-full p-4 rounded text-left transition-all flex items-center gap-4 ${
                  selected === c
                    ? 'bg-civic-gold/5 border border-civic-gold'
                    : 'bg-civic-surface border border-civic-border hover:border-civic-border-light'
                }`}
              >
                <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                  selected === c ? 'border-civic-gold' : 'border-civic-border'
                }`}>
                  {selected === c && <span className="w-2 h-2 rounded-full bg-civic-gold" />}
                </span>
                <span className={`font-display text-lg ${selected === c ? 'text-civic-gold' : 'text-civic-text'}`}>
                  {c}
                </span>
              </button>
            ))}
          </div>
          <button onClick={handleCommit} disabled={!selected || loading}
            className="w-full civic-btn-primary py-3 disabled:opacity-30">
            {loading ? 'Committing…' : 'Commit Vote'}
          </button>
          <p className="text-[10px] text-civic-dim mt-3 text-center font-mono">
            Commitment and trustee-recovery shares are generated in your browser. You must reveal in the next phase.
          </p>
        </>
      )}

      {/* ── Receipt shown right after commit (during COMMIT phase) ── */}
      {receipt && election.phase === 'COMMIT' && (
        <div className="civic-card p-6 border-civic-teal/30 space-y-4">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-civic-teal" />
            <h3 className="font-display text-lg text-civic-teal">Vote Committed</h3>
          </div>
          <p className="text-xs text-civic-muted">
            Your receipt has been saved automatically. Keep the nonce safe because the API does not retain it.
          </p>
          <div className="bg-civic-bg rounded p-4 font-mono text-xs space-y-3 border border-civic-border">
            <div>
              <span className="text-civic-dim text-[10px] uppercase tracking-wider">Commitment Hash</span>
              <p className="text-civic-amber break-all mt-1">{receipt.commitment}</p>
            </div>
            <div className="gold-rule w-full" />
            <div>
              <span className="text-civic-dim text-[10px] uppercase tracking-wider">Your Nonce</span>
              <p className="text-civic-teal break-all mt-1">{receipt.nonce}</p>
            </div>
          </div>
          <p className="text-[10px] text-civic-dim text-center font-mono">
            Wait for admin to advance to REVEAL phase, then return here to reveal.
          </p>
        </div>
      )}

      {/* ── COMMIT phase but voter already committed (page refresh / return) ── */}
      {election.phase === 'COMMIT' && !receipt && hasCommitted && (
        <div className="civic-card p-6 space-y-3 text-center">
          <div className="flex items-center justify-center gap-2">
            <span className="w-2 h-2 rounded-full bg-civic-teal" />
            <h3 className="font-display text-lg text-civic-teal">Already Committed</h3>
          </div>
          <p className="text-sm text-civic-muted">
            Your vote has been committed. Return during the REVEAL phase to reveal it.
          </p>
        </div>
      )}

      {/* ── REVEAL phase ── */}
      {election.phase === 'REVEAL' && (hasCommitted || receipt) && (
        <div className="civic-card p-6 space-y-5">
          <h3 className="font-display text-xl">Reveal Your Vote</h3>
          <p className="text-sm text-civic-muted">
            {receipt
              ? 'Your saved receipt has been loaded. Click Reveal to count your vote.'
              : 'Enter the candidate you voted for and the nonce from your receipt.'}
          </p>

          {/* Candidate selector */}
          <div>
            <label className="text-[11px] uppercase tracking-[0.15em] text-civic-dim block mb-2">
              Candidate
            </label>
            <div className="space-y-2">
              {election.candidates.map((c) => (
                <button
                  key={c}
                  onClick={() => setRevealCandidate(c)}
                  className={`w-full p-3 rounded text-left transition-all flex items-center gap-3 ${
                    revealCandidate === c
                      ? 'bg-civic-gold/5 border border-civic-gold'
                      : 'bg-civic-surface border border-civic-border hover:border-civic-border-light'
                  }`}
                >
                  <span className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                    revealCandidate === c ? 'border-civic-gold' : 'border-civic-border'
                  }`}>
                    {revealCandidate === c && <span className="w-1.5 h-1.5 rounded-full bg-civic-gold" />}
                  </span>
                  <span className={`font-display ${revealCandidate === c ? 'text-civic-gold' : 'text-civic-text'}`}>
                    {c}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Nonce input */}
          <div>
            <label className="text-[11px] uppercase tracking-[0.15em] text-civic-dim block mb-2">
              Nonce
            </label>
            <input
              type="text"
              value={revealNonce}
              onChange={(e) => setRevealNonce(e.target.value)}
              placeholder="Paste your nonce from the commit receipt"
              className="civic-input font-mono text-xs"
            />
          </div>

          <button onClick={handleReveal} disabled={loading || !revealCandidate || !revealNonce}
            className="w-full civic-btn-primary py-3 disabled:opacity-30">
            {loading ? 'Revealing…' : 'Reveal Vote'}
          </button>
          <p className="text-[10px] text-civic-dim text-center font-mono">
            The blockchain will verify SHA-256(candidate ∥ nonce) matches your commitment.
          </p>
        </div>
      )}

      {/* ── REVEAL phase but voter never committed ── */}
      {election.phase === 'REVEAL' && !hasCommitted && !receipt && (
        <div className="civic-card p-8 text-center">
          <p className="text-civic-muted text-sm">
            You did not commit a vote during the COMMIT phase.
          </p>
        </div>
      )}
    </div>
  );
}
