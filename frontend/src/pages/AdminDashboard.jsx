import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { elections as elApi, vote as voteApi, trustee as trusteeApi } from '../services/api';

const PHASES = ['SETUP', 'COMMIT', 'REVEAL', 'RECOVER', 'TALLY'];

export default function AdminDashboard() {
  const { id: paramId } = useParams();
  const [elections, setElections] = useState([]);
  const [selectedId, setSelectedId] = useState(paramId || '');
  const [election, setElection] = useState(null);
  const [unrevealed, setUnrevealed] = useState([]);
  const [trusteeStatus, setTrusteeStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { elApi.list().then(setElections).catch(() => {}); }, []);
  useEffect(() => { if (selectedId) loadElection(); }, [selectedId]);

  const loadElection = async () => {
    try {
      const el = await elApi.get(selectedId);
      setElection(el);
      if (['REVEAL', 'RECOVER'].includes(el.phase)) {
        const { unrevealed: u } = await voteApi.unrevealed(selectedId);
        setUnrevealed(u);
        // Load trustee recovery status
        try {
          const ts = await trusteeApi.status(selectedId);
          setTrusteeStatus(ts);
        } catch { setTrusteeStatus(null); }
      } else {
        setUnrevealed([]);
        setTrusteeStatus(null);
      }
    } catch (e) { setError(e.message); }
  };

  const advancePhase = async () => {
    if (!election) return;
    const curIdx = PHASES.indexOf(election.phase);
    if (curIdx >= PHASES.length - 1) return;
    const nextPhase = PHASES[curIdx + 1];
    setLoading(true); setError(''); setMessage('');
    try {
      await elApi.setPhase(selectedId, nextPhase);
      setMessage(`Phase advanced to ${nextPhase}`);
      await loadElection();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="max-w-3xl mx-auto animate-fade-up">
      <p className="text-[11px] uppercase tracking-[0.2em] text-civic-dim mb-2 font-mono">Control Panel</p>
      <h1 className="font-display text-3xl mb-8">Admin</h1>

      {/* Election selector */}
      <div className="mb-8">
        <label className="text-[11px] uppercase tracking-[0.15em] text-civic-dim block mb-2">
          Select Election
        </label>
        <select
          value={selectedId}
          onChange={(e) => { setSelectedId(e.target.value); setMessage(''); setError(''); }}
          className="civic-input font-mono"
        >
          <option value="">— Select —</option>
          {elections.map((el) => (
            <option key={el.id} value={el.id}>{el.title} ({el.id})</option>
          ))}
        </select>
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
          {/* Phase stepper */}
          <div className="civic-card p-6 animate-fade-up stagger-1">
            <h3 className="font-display text-lg mb-5">Phase Control</h3>
            <div className="flex items-center gap-0 mb-6">
              {PHASES.map((p, i) => {
                const curIdx = PHASES.indexOf(election.phase);
                const isActive = i === curIdx;
                const isDone = i < curIdx;
                return (
                  <div key={p} className="flex items-center flex-1 last:flex-none">
                    <div className="flex flex-col items-center">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-mono transition-all ${
                        isActive ? 'bg-civic-gold text-civic-bg ring-4 ring-civic-gold/10 phase-active'
                          : isDone ? 'bg-civic-teal/10 text-civic-teal border border-civic-teal/30'
                          : 'bg-civic-surface text-civic-dim border border-civic-border'
                      }`}>
                        {isDone ? '✓' : i + 1}
                      </div>
                      <span className={`text-[9px] mt-1.5 uppercase tracking-wider ${
                        isActive ? 'text-civic-gold' : isDone ? 'text-civic-teal' : 'text-civic-dim'
                      }`}>{p}</span>
                    </div>
                    {i < PHASES.length - 1 && (
                      <div className={`flex-1 h-px mx-2 mb-4 ${isDone ? 'bg-civic-teal/30' : 'bg-civic-border'}`} />
                    )}
                  </div>
                );
              })}
            </div>
            <button
              onClick={advancePhase}
              disabled={loading || election.phase === 'TALLY'}
              className="w-full civic-btn-primary py-2.5 disabled:opacity-30"
            >
              {loading ? 'Advancing…' : election.phase === 'TALLY'
                ? 'Election Complete'
                : `Advance → ${PHASES[PHASES.indexOf(election.phase) + 1]}`
              }
            </button>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-5 gap-3 animate-fade-up stagger-2">
            {[
              ['Voters', election.totalVoters],
              ['Committed', election.totalCommitted],
              ['Revealed', election.totalRevealed],
              ['Recovered', election.totalRecovered || 0],
              ['Unrevealed', unrevealed.length],
            ].map(([label, value]) => (
              <div key={label} className="civic-card p-3 text-center">
                <div className="font-display text-xl">{value}</div>
                <div className="text-[9px] text-civic-dim uppercase tracking-wider mt-1">{label}</div>
              </div>
            ))}
          </div>

          {/* Trustee Recovery Status */}
          {election.phase === 'RECOVER' && unrevealed.length > 0 && (
            <div className="border-l-2 border-civic-gold pl-5 py-2 animate-fade-up stagger-3">
              <h3 className="font-display text-lg text-civic-gold mb-2">Trustee Recovery</h3>
              <p className="text-sm text-civic-muted mb-4">
                {unrevealed.length} voter(s) did not reveal. Trustees must submit full recovery bundles
                ({election.trusteeThreshold}-of-{election.trustees?.length || '?'} threshold) before the election can move to TALLY.
              </p>

              {trusteeStatus && Object.keys(trusteeStatus).length > 0 ? (
                <div className="space-y-2">
                  {Object.entries(trusteeStatus).map(([voterId, info]) => (
                    <div key={voterId} className="bg-civic-surface rounded px-4 py-3 border border-civic-border">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-mono text-sm text-civic-muted">{voterId}</span>
                        <span className={`text-[10px] uppercase tracking-wider font-mono ${
                          info.recovered ? 'text-civic-teal' : 'text-civic-dim'
                        }`}>
                          {info.recovered ? '✓ Recovered' : `${info.submittedCount || 0}/${election.trusteeThreshold} bundles`}
                        </span>
                      </div>
                      {/* Progress bar */}
                      <div className="w-full bg-civic-border/30 rounded-full h-1.5">
                        <div
                          className={`h-1.5 rounded-full transition-all ${info.recovered ? 'bg-civic-teal' : 'bg-civic-gold'}`}
                          style={{ width: `${Math.min(100, ((info.submittedCount || 0) / election.trusteeThreshold) * 100)}%` }}
                        />
                      </div>
                      {info.submittedBy && info.submittedBy.length > 0 && (
                        <p className="text-[10px] text-civic-dim mt-1.5 font-mono">
                          Submitted by: {info.submittedBy.join(', ')}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-civic-dim">No trustee shares submitted yet. Trustees must access their dashboard to submit.</p>
              )}

              <button onClick={loadElection} className="mt-4 text-xs text-civic-gold hover:text-civic-gold-light transition-colors font-mono">
                ↻ Refresh Status
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
