import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { trustee as trusteeApi, elections as elApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { decryptAssignedShare, getOrCreateRecoveryKeyPair } from '../services/crypto';

const PHASE_STYLE = {
  SETUP:   'border-civic-dim text-civic-dim',
  COMMIT:  'border-civic-teal text-civic-teal',
  REVEAL:  'border-civic-gold text-civic-gold',
  RECOVER: 'border-civic-amber text-civic-amber',
  TALLY:   'border-civic-teal text-civic-teal',
};

export default function TrusteeDashboard() {
  const { id: paramId } = useParams();
  const { user } = useAuth();
  const [assignments, setAssignments] = useState([]);
  const [selectedId, setSelectedId] = useState(paramId || '');
  const [election, setElection] = useState(null);
  const [recoveryStatuses, setRecoveryStatuses] = useState([]);
  const [loading, setLoading] = useState(false);
  const [bundleSubmitted, setBundleSubmitted] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  // Load trustee assignments
  useEffect(() => {
    trusteeApi.myElections()
      .then(setAssignments)
      .catch(() => setAssignments([]));
  }, []);

  // Load election + recovery status when selection changes
  const loadElection = useCallback(async () => {
    if (!selectedId) return;
    try {
      const el = await elApi.get(selectedId);
      setElection(el);
      if (['RECOVER', 'TALLY'].includes(el.phase)) {
        const { unrevealed, bundleSubmitted: alreadySubmitted } = await trusteeApi.status(selectedId);
        setRecoveryStatuses(unrevealed || []);
        setBundleSubmitted(Boolean(alreadySubmitted));
      } else {
        setRecoveryStatuses([]);
        setBundleSubmitted(false);
      }
    } catch (e) { setError(e.message); }
  }, [selectedId]);

  useEffect(() => { loadElection(); }, [loadElection]);

  // Auto-select if param provided
  useEffect(() => { if (paramId) setSelectedId(paramId); }, [paramId]);

  const handleSubmitAll = async () => {
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const { privateKeyJwk } = await getOrCreateRecoveryKeyPair(user.username);
      const shares = [];
      for (const status of recoveryStatuses) {
        if (!status.assignedEncryptedShare) {
          throw new Error(`Missing encrypted share assignment for ${status.voterId}`);
        }
        const share = await decryptAssignedShare(status.assignedEncryptedShare, privateKeyJwk);
        shares.push({ voterId: status.voterId, share });
      }

      const res = await trusteeApi.submitShare(selectedId, shares);
      setMessage(
        res.recoveredCount > 0
          ? `✓ Recovery bundle submitted. ${res.recoveredCount} vote(s) recovered.`
          : '✓ Recovery bundle submitted.',
      );
      await loadElection();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  if (assignments.length === 0 && !loading) {
    return (
      <div className="max-w-xl mx-auto mt-20 animate-fade-up text-center">
        <div className="w-16 h-16 rounded-full bg-civic-elevated border border-civic-border flex items-center justify-center mx-auto mb-6">
          <span className="text-civic-dim text-2xl">🔐</span>
        </div>
        <h2 className="font-display text-2xl mb-2">No Trustee Assignments</h2>
        <p className="text-sm text-civic-muted">
          You are not assigned as a trustee in any election.
          An admin must include you in the trustee list when creating an election.
        </p>
        <Link to="/elections" className="text-xs text-civic-gold mt-4 inline-block hover:text-civic-gold-light">
          ← Back to Elections
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto animate-fade-up">
      <p className="text-[11px] uppercase tracking-[0.2em] text-civic-dim mb-2 font-mono">Threshold Recovery</p>
      <h1 className="font-display text-3xl mb-8">Trustee Dashboard</h1>

      {/* Election selector */}
      <div className="mb-8">
        <label className="text-[11px] uppercase tracking-[0.15em] text-civic-dim block mb-2">
          Your Trustee Assignments
        </label>
        <div className="space-y-2">
          {assignments.map((a) => (
            <button
              key={a.electionId}
              onClick={() => { setSelectedId(a.electionId); setMessage(''); setError(''); }}
              className={`w-full p-4 rounded text-left transition-all flex items-center justify-between ${
                selectedId === a.electionId
                  ? 'bg-civic-gold/5 border border-civic-gold'
                  : 'bg-civic-surface border border-civic-border hover:border-civic-border-light'
              }`}
            >
              <div>
                <span className="font-display text-lg">{a.title}</span>
                <span className="text-[11px] font-mono text-civic-dim ml-3">{a.electionId}</span>
              </div>
              <span className={`text-[10px] uppercase tracking-[0.2em] font-mono border rounded px-2 py-1 ${PHASE_STYLE[a.phase] || 'border-civic-border text-civic-muted'}`}>
                {a.phase}
              </span>
            </button>
          ))}
        </div>
      </div>

      {message && (
        <div className="bg-civic-teal/10 border border-civic-teal/20 text-civic-teal text-sm rounded px-4 py-3 mb-6">
          {message}
        </div>
      )}
      {error && (
        <div className="bg-civic-coral/10 border border-civic-coral/20 text-civic-coral text-sm rounded px-4 py-3 mb-6">
          {error}
        </div>
      )}

      {election && (
        <div className="space-y-6">
          {/* Election info */}
          <div className="civic-card p-6 animate-fade-up stagger-1">
            <h3 className="font-display text-lg mb-4">{election.title}</h3>
            <div className="grid grid-cols-4 gap-3">
              {[
                ['Committed', election.totalCommitted, 'text-civic-gold'],
                ['Revealed', election.totalRevealed, 'text-civic-teal'],
                ['Recovered', election.totalRecovered || 0, 'text-civic-amber'],
                ['Threshold', `${election.trusteeThreshold}/${election.trusteeCount}`, 'text-civic-muted'],
              ].map(([label, value, color]) => (
                <div key={label} className="text-center">
                  <div className={`font-display text-xl ${color}`}>{value}</div>
                  <div className="text-[9px] text-civic-dim uppercase tracking-wider mt-1">{label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Phase gate */}
          {election.phase !== 'RECOVER' && (
            <div className="civic-card p-8 text-center animate-fade-up stagger-2">
              <p className="text-civic-muted text-sm">
                {election.phase === 'SETUP' && 'Election is being set up. No recovery needed yet.'}
                {election.phase === 'COMMIT' && 'Voters are committing. Recovery will happen after the reveal phase.'}
                {election.phase === 'REVEAL' && 'Voters are revealing. Wait for admin to advance to RECOVER phase.'}
                {election.phase === 'TALLY' && 'Election is finalized.'}
              </p>
              {election.phase === 'TALLY' && (
                <Link to={`/elections/${election.id}/results`} className="text-xs text-civic-gold mt-3 inline-block hover:text-civic-gold-light">
                  View Results →
                </Link>
              )}
            </div>
          )}

          {/* Recovery section */}
          {election.phase === 'RECOVER' && (
            <div className="animate-fade-up stagger-2">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="font-display text-lg text-civic-gold">Share Submission</h3>
                  <p className="text-xs text-civic-muted mt-1">
                    Submit one encrypted recovery bundle covering every unrevealed voter. Recovery triggers automatically when
                    {' '}<span className="font-mono text-civic-gold">{election.trusteeThreshold}</span> trustees submit full bundles.
                  </p>
                </div>
                {!bundleSubmitted && recoveryStatuses.length > 0 && (
                  <button
                    onClick={handleSubmitAll}
                    disabled={loading}
                    className="civic-btn-primary text-xs px-4 py-2 disabled:opacity-40"
                  >
                    {loading ? 'Submitting…' : 'Submit Recovery Bundle'}
                  </button>
                )}
              </div>

              {bundleSubmitted && (
                <p className="text-[10px] uppercase tracking-wider font-mono text-civic-teal mb-4">
                  Your recovery bundle has already been submitted for this election.
                </p>
              )}

              {recoveryStatuses.length === 0 ? (
                <div className="civic-card p-8 text-center">
                  <p className="text-civic-teal text-sm">✓ All voters have revealed or been recovered.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {recoveryStatuses.map((st) => {
                    const alreadySubmitted = st.submittedBy.includes(user.username);
                    const progress = st.submittedCount / election.trusteeThreshold;
                    return (
                      <div key={st.voterId} className="civic-card p-4">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <span className="font-mono text-sm text-civic-text">{st.voterId}</span>
                            {st.recovered && (
                              <span className="text-[9px] uppercase tracking-wider bg-civic-teal/10 text-civic-teal border border-civic-teal/20 px-2 py-0.5 rounded">
                                Recovered
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="font-mono text-xs text-civic-dim">
                              {st.submittedCount}/{election.trusteeThreshold} bundles
                            </span>
                            {!st.recovered && alreadySubmitted && (
                              <span className="text-[10px] text-civic-teal font-mono uppercase tracking-wider">
                                ✓ Included
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Progress bar */}
                        <div className="w-full h-1.5 bg-civic-elevated rounded-full overflow-hidden mb-2">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${Math.min(progress * 100, 100)}%`,
                              backgroundColor: st.recovered ? '#1B7A6E' : '#A67C2E',
                            }}
                          />
                        </div>

                        {/* Submitted trustees */}
                        <div className="flex flex-wrap gap-1.5">
                          {election.trustees.map((tid) => {
                            const submitted = st.submittedBy.includes(tid);
                            const isMe = tid === user.username;
                            return (
                              <span
                                key={tid}
                                className={`text-[9px] font-mono px-2 py-0.5 rounded border ${
                                  submitted
                                    ? 'bg-civic-teal/10 text-civic-teal border-civic-teal/20'
                                    : 'bg-civic-surface text-civic-dim border-civic-border'
                                } ${isMe ? 'ring-1 ring-civic-gold/30' : ''}`}
                              >
                                {tid}{isMe ? ' (you)' : ''}{submitted ? ' ✓' : ''}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
