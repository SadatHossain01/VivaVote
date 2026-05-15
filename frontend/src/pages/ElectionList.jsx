import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { elections as api } from '../services/api';
import { useAuth } from '../context/AuthContext';

const PHASE_STYLE = {
  SETUP:   'border-civic-dim text-civic-dim',
  COMMIT:  'border-civic-teal text-civic-teal',
  REVEAL:  'border-civic-gold text-civic-gold',
  RECOVER: 'border-civic-amber text-civic-amber',
  TALLY:   'border-civic-teal text-civic-teal',
};

export default function ElectionList() {
  const { user } = useAuth();
  const [electionList, setElectionList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.list()
      .then(setElectionList)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-civic-dim text-center mt-20 font-mono text-sm">Loading…</p>;
  if (error) return <p className="text-civic-coral text-center mt-20 text-sm">{error}</p>;

  return (
    <div className="animate-fade-up">
      <div className="flex items-end justify-between mb-10">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-civic-dim mb-2 font-mono">
            Active Elections
          </p>
          <h1 className="font-display text-3xl">Elections</h1>
        </div>
        {user?.role === 'admin' && (
          <Link to="/create" className="civic-btn-primary">
            + New
          </Link>
        )}
      </div>

      {electionList.length === 0 ? (
        <div className="text-center py-24">
          <p className="font-display text-4xl text-civic-dim mb-3">∅</p>
          <p className="text-civic-muted text-sm">No elections yet. Create one to begin.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {electionList.map((el, i) => (
            <Link
              key={el.id}
              to={`/elections/${el.id}`}
              className={`block civic-card p-5 animate-fade-up stagger-${Math.min(i + 1, 8)}`}
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-display text-lg">{el.title}</h3>
                  <span className="text-[11px] font-mono text-civic-dim">{el.id}</span>
                </div>
                <span className={`text-[10px] uppercase tracking-[0.2em] font-mono border rounded px-2 py-1 ${PHASE_STYLE[el.phase] || 'border-civic-border text-civic-muted'}`}>
                  {el.phase === 'TALLY' ? '✓ ' : ''}{el.phase}
                </span>
              </div>
              <div className="flex gap-6 text-[11px] text-civic-dim font-mono">
                <span>Candidates: <span className="text-civic-muted">{el.candidates?.join(' · ')}</span></span>
                <span className="text-civic-border">│</span>
                <span>Voters <span className="text-civic-muted">{el.totalVoters || 0}</span></span>
                <span>Committed <span className="text-civic-muted">{el.totalCommitted || 0}</span></span>
                <span>Revealed <span className="text-civic-muted">{el.totalRevealed || 0}</span></span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
