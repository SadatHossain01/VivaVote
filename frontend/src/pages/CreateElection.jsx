import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { elections as api, auth as authApi } from '../services/api';

export default function CreateElection() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [id, setId] = useState('');
  const [title, setTitle] = useState('');
  const [candidatesText, setCandidatesText] = useState('');
  const [trusteeThreshold, setTrusteeThreshold] = useState(2);

  // Registered users from backend
  const [allUsers, setAllUsers] = useState([]);
  const [selectedVoters, setSelectedVoters] = useState(new Set());
  const [selectedTrustees, setSelectedTrustees] = useState(new Set());

  const candidates = candidatesText.split('\n').map((s) => s.trim()).filter(Boolean);

  // Fetch registered users on mount
  useEffect(() => {
    authApi.users().then(setAllUsers).catch(() => {});
  }, []);

  const toggleVoter = (username) => {
    setSelectedVoters(prev => {
      const next = new Set(prev);
      if (next.has(username)) next.delete(username); else next.add(username);
      // Remove from trustees if added as voter
      setSelectedTrustees(t => { const n = new Set(t); n.delete(username); return n; });
      return next;
    });
  };

  const toggleTrustee = (username) => {
    setSelectedTrustees(prev => {
      const next = new Set(prev);
      if (next.has(username)) next.delete(username); else next.add(username);
      // Remove from voters if added as trustee
      setSelectedVoters(v => { const n = new Set(v); n.delete(username); return n; });
      return next;
    });
  };

  const voters = [...selectedVoters];
  const trustees = [...selectedTrustees];

  const handleCreate = async () => {
    setError('');
    setLoading(true);
    try {
      await api.create({ id, title, candidates, voters, trustees, trusteeThreshold });
      navigate(`/admin/${id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const stepLabels = ['Details', 'Participants', 'Review'];

  return (
    <div className="max-w-xl mx-auto animate-fade-up">
      <p className="text-[11px] uppercase tracking-[0.2em] text-civic-dim mb-2 font-mono">
        New Election
      </p>
      <h1 className="font-display text-3xl mb-8">Create</h1>

      {error && (
        <div className="bg-civic-coral/10 border border-civic-coral/20 text-civic-coral text-sm rounded px-4 py-3 mb-6">
          {error}
        </div>
      )}

      {/* Step indicator — connected dots */}
      <div className="flex items-center gap-0 mb-10">
        {stepLabels.map((label, i) => {
          const s = i + 1;
          const active = step === s;
          const done = step > s;
          return (
            <div key={s} className="flex items-center flex-1 last:flex-none">
              <div className="flex flex-col items-center">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-mono transition-all ${
                  active ? 'bg-civic-gold text-civic-bg ring-4 ring-civic-gold/10'
                    : done ? 'bg-civic-teal/20 text-civic-teal border border-civic-teal/30'
                    : 'bg-civic-surface text-civic-dim border border-civic-border'
                }`}>
                  {done ? '✓' : s}
                </div>
                <span className={`text-[10px] mt-2 tracking-wider uppercase ${
                  active ? 'text-civic-gold' : 'text-civic-dim'
                }`}>{label}</span>
              </div>
              {s < 3 && (
                <div className={`flex-1 h-px mx-3 mb-5 ${done ? 'bg-civic-teal/30' : 'bg-civic-border'}`} />
              )}
            </div>
          );
        })}
      </div>

      <div className="civic-card p-6 space-y-5">
        {/* Step 1: Details */}
        {step === 1 && (
          <>
            <div>
              <label className="text-[11px] uppercase tracking-[0.15em] text-civic-dim block mb-2">Election ID</label>
              <input value={id} onChange={(e) => setId(e.target.value)}
                placeholder="e.g. election-2026" className="civic-input font-mono" />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-[0.15em] text-civic-dim block mb-2">Title</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Student Council Election 2026" className="civic-input" />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-[0.15em] text-civic-dim block mb-2">
                Candidates <span className="text-civic-dim normal-case tracking-normal">— one per line</span>
              </label>
              <textarea value={candidatesText} onChange={(e) => setCandidatesText(e.target.value)}
                rows={4} placeholder={"Alice\nBob\nCharlie"} className="civic-input font-mono" />
            </div>
            <button onClick={() => setStep(2)}
              disabled={!id || !title || candidates.length < 2}
              className="w-full civic-btn-primary py-3 disabled:opacity-30">
              Continue →
            </button>
          </>
        )}

        {/* Step 2: Participants — select voters and trustees from registered users */}
        {step === 2 && (
          <>
            {allUsers.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-civic-muted text-sm mb-2">No registered users yet.</p>
                <p className="text-civic-dim text-xs">Users must register first, then you can assign them as voters or trustees.</p>
              </div>
            ) : (
              <>
                <p className="text-xs text-civic-dim mb-4">
                  Assign each user as a <span className="text-civic-teal">voter</span> or <span className="text-civic-gold">trustee</span>.
                  A user cannot be both. Trustees perform threshold recovery for absent voters.
                </p>

                <div className="flex gap-2 mb-3">
                  <button
                    onClick={() => {
                      const all = new Set(allUsers.map(u => u.username));
                      // remove anyone already selected as trustee
                      selectedTrustees.forEach(t => all.delete(t));
                      setSelectedVoters(all);
                    }}
                    className="text-[10px] uppercase tracking-wider font-mono px-3 py-1.5 rounded border border-civic-teal/30 text-civic-teal hover:bg-civic-teal/10 transition-all"
                  >
                    Select All as Voter
                  </button>
                  <button
                    onClick={() => { setSelectedVoters(new Set()); setSelectedTrustees(new Set()); }}
                    className="text-[10px] uppercase tracking-wider font-mono px-3 py-1.5 rounded border border-civic-border text-civic-dim hover:border-civic-coral/30 hover:text-civic-coral transition-all"
                  >
                    Clear All
                  </button>
                </div>

                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                  {allUsers.map(({ username, hasRecoveryKey }) => {
                    const isVoter = selectedVoters.has(username);
                    const isTrustee = selectedTrustees.has(username);
                    return (
                      <div key={username} className="flex items-center justify-between bg-civic-surface rounded px-4 py-2.5 border border-civic-border">
                        <div>
                          <span className="font-mono text-sm text-civic-text">{username}</span>
                          {!hasRecoveryKey && (
                            <p className="text-[9px] uppercase tracking-wider text-civic-coral mt-1">
                              Trustee key not registered yet
                            </p>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => toggleVoter(username)}
                            className={`text-[10px] uppercase tracking-wider font-mono px-3 py-1 rounded border transition-all ${
                              isVoter
                                ? 'bg-civic-teal/10 border-civic-teal/30 text-civic-teal'
                                : 'border-civic-border text-civic-dim hover:border-civic-teal/30 hover:text-civic-teal'
                            }`}
                          >
                            {isVoter ? '✓ Voter' : 'Voter'}
                          </button>
                          <button
                            onClick={() => toggleTrustee(username)}
                            disabled={!hasRecoveryKey}
                            className={`text-[10px] uppercase tracking-wider font-mono px-3 py-1 rounded border transition-all ${
                              isTrustee
                                ? 'bg-civic-gold/10 border-civic-gold/30 text-civic-gold'
                                : !hasRecoveryKey
                                  ? 'border-civic-border text-civic-dim opacity-40 cursor-not-allowed'
                                  : 'border-civic-border text-civic-dim hover:border-civic-gold/30 hover:text-civic-gold'
                            }`}
                          >
                            {isTrustee ? '✓ Trustee' : 'Trustee'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-center gap-4 text-[11px] font-mono text-civic-dim mt-3">
                  <span>Voters: <span className="text-civic-teal">{voters.length}</span></span>
                  <span className="text-civic-border">│</span>
                  <span>Trustees: <span className="text-civic-gold">{trustees.length}</span></span>
                </div>

                {/* Threshold config */}
                {trustees.length >= 2 && (
                  <div className="mt-2">
                    <label className="text-[11px] uppercase tracking-[0.15em] text-civic-dim block mb-2">
                      Recovery Threshold (T of {trustees.length})
                    </label>
                    <input type="number" min={2} max={trustees.length}
                      value={trusteeThreshold} onChange={(e) => setTrusteeThreshold(Math.min(+e.target.value, trustees.length))}
                      className="civic-input font-mono w-24" />
                    <p className="text-[10px] text-civic-dim mt-1">
                      {trusteeThreshold} of {trustees.length} trustees must submit shares to recover a vote
                    </p>
                    <p className="text-[10px] text-civic-dim mt-1">
                      Trustees must log in once before being selected so their browser can register a recovery public key.
                    </p>
                  </div>
                )}
              </>
            )}
            <div className="flex gap-3">
              <button onClick={() => setStep(1)} className="civic-btn-secondary">← Back</button>
              <button onClick={() => setStep(3)} disabled={voters.length === 0 || trustees.length < 2}
                className="flex-1 civic-btn-primary py-3 disabled:opacity-30">
                Continue →
              </button>
            </div>
          </>
        )}

        {/* Step 3: Review */}
        {step === 3 && (
          <>
            <h3 className="font-display text-xl mb-4">Review</h3>
            <div className="space-y-3 text-sm">
              {[
                ['ID', id, 'font-mono'],
                ['Title', title],
                ['Candidates', candidates.join(' · ')],
                ['Voters', `${voters.length} user(s)`],
                ['Trustees', trustees.join(', ')],
                ['Threshold', `${trusteeThreshold}-of-${trustees.length}`],
              ].map(([label, value, cls]) => (
                <div key={label} className="flex justify-between items-center py-2 border-b border-civic-border/50">
                  <span className="text-civic-dim text-[11px] uppercase tracking-wider">{label}</span>
                  <span className={cls || ''}>{value}</span>
                </div>
              ))}
            </div>

            {/* Cost comparison */}
            <div className="mt-6 bg-civic-bg rounded p-4 border border-civic-border">
              <p className="text-[10px] uppercase tracking-[0.2em] text-civic-dim mb-3">On-Chain State Writes</p>
              <div className="grid grid-cols-2 gap-4">
                <div className="text-center">
                  <span className="font-display text-3xl text-civic-teal">2</span>
                  <p className="text-[10px] text-civic-dim mt-1 uppercase tracking-wider">VivaVote</p>
                  <p className="text-[10px] text-civic-dim">election + tally</p>
                </div>
                <div className="text-center">
                  <span className="font-display text-3xl text-civic-coral">{2 + voters.length}</span>
                  <p className="text-[10px] text-civic-dim mt-1 uppercase tracking-wider">Baseline</p>
                  <p className="text-[10px] text-civic-dim">election + tally + each voter</p>
                </div>
              </div>
            </div>

            <div className="flex gap-3 mt-4">
              <button onClick={() => setStep(2)} className="civic-btn-secondary">← Back</button>
              <button onClick={handleCreate} disabled={loading}
                className="flex-1 civic-btn-primary py-3 disabled:opacity-40">
                {loading ? 'Creating…' : 'Create Election'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
