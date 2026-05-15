import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { results as resApi, elections as elApi } from '../services/api';

const COLORS = ['#C4952F', '#1B7A6E', '#C2453B', '#D4862A', '#8A847A'];

const tooltipStyle = {
  backgroundColor: '#FFFFFF',
  border: '1px solid #DBD6CD',
  borderRadius: '4px',
  color: '#1A1815',
  fontSize: '12px',
};

export default function Results() {
  const { id } = useParams();
  const [tally, setTally] = useState(null);
  const [election, setElection] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([elApi.get(id), resApi.tally(id)])
      .then(([el, t]) => { setElection(el); setTally(t); })
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) return <p className="text-civic-coral text-center mt-20 text-sm">{error}</p>;
  if (!tally || !election) return <p className="text-civic-dim text-center mt-20 font-mono text-sm">Loading…</p>;

  const chartData = election.candidates.map((c) => ({ name: c, votes: tally[c] || 0 }));
  const totalVotes = chartData.reduce((s, d) => s + d.votes, 0);

  return (
    <div className="max-w-3xl mx-auto animate-fade-up">
      <p className="text-[11px] uppercase tracking-[0.2em] text-civic-dim mb-2 font-mono">Results</p>
      <h1 className="font-display text-3xl mb-1">{election.title}</h1>
      <div className="flex items-center gap-3 text-[11px] font-mono text-civic-dim mb-8">
        <span>Phase: <span className="text-civic-gold">{election.phase}</span></span>
        {tally.finalized && (
          <span className="text-civic-teal flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-civic-teal" /> Finalized
          </span>
        )}
      </div>

      {/* Chart */}
      <div className="civic-card p-6 mb-6 animate-fade-up stagger-1">
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={chartData} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#DBD6CD" />
            <XAxis dataKey="name" stroke="#7A756C" tick={{ fill: '#4A453E', fontSize: 12, fontFamily: 'DM Sans' }} />
            <YAxis allowDecimals={false} stroke="#DBD6CD" tick={{ fill: '#7A756C', fontSize: 11, fontFamily: 'JetBrains Mono' }} />
            <Tooltip contentStyle={tooltipStyle} cursor={{ fill: '#F5F3EF' }} />
            <Bar dataKey="votes" radius={[2, 2, 0, 0]}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-6 animate-fade-up stagger-2">
        {[
          ['Total', totalVotes, 'text-civic-text'],
          ['Committed', election.totalCommitted, 'text-civic-gold'],
          ['Revealed', election.totalRevealed, 'text-civic-teal'],
          ['Recovered', election.totalRecovered || 0, 'text-civic-amber'],
        ].map(([label, value, color]) => (
          <div key={label} className="civic-card p-4 text-center">
            <div className={`font-display text-2xl ${color}`}>{value}</div>
            <div className="text-[10px] text-civic-dim uppercase tracking-wider mt-1">{label}</div>
          </div>
        ))}
      </div>

      {/* Breakdown */}
      <div className="civic-card p-6 animate-fade-up stagger-3">
        <h3 className="font-display text-lg mb-5">Breakdown</h3>
        {chartData.map((d, i) => {
          const pct = totalVotes > 0 ? ((d.votes / totalVotes) * 100).toFixed(1) : 0;
          return (
            <div key={d.name} className="mb-4 last:mb-0">
              <div className="flex items-center justify-between text-sm mb-2">
                <span className="text-civic-text">{d.name}</span>
                <span className="text-civic-dim font-mono text-xs">{d.votes} ({pct}%)</span>
              </div>
              <div className="w-full h-1.5 bg-civic-elevated rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700 ease-out"
                  style={{ width: `${pct}%`, backgroundColor: COLORS[i % COLORS.length] }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Recovery callout */}
      {(election.totalRecovered || 0) > 0 && (
        <div className="mt-6 border-l-2 border-civic-gold pl-4 py-3 animate-fade-up stagger-4">
          <p className="text-[11px] uppercase tracking-[0.15em] text-civic-gold mb-1 font-mono">Trustee Recovery Impact</p>
          <p className="text-sm text-civic-muted">
            {election.totalRecovered} vote(s) recovered via Shamir's Secret Sharing.
            Without recovery, tally rate would be{' '}
            <span className="font-mono text-civic-coral">{Math.round((election.totalRevealed / election.totalCommitted) * 100)}%</span>
            {' '}instead of{' '}
            <span className="font-mono text-civic-teal">{Math.round(((election.totalRevealed + election.totalRecovered) / election.totalCommitted) * 100)}%</span>.
          </p>
        </div>
      )}

      <div className="mt-8 text-center">
        <Link to="/elections" className="text-xs text-civic-dim hover:text-civic-gold transition-colors">
          ← Back to Elections
        </Link>
      </div>
    </div>
  );
}
