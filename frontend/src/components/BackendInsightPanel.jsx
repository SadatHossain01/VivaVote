import { useWebSocket } from '../context/WebSocketContext';

export default function BackendInsightPanel({ open }) {
  const { connected, mode, transactions, clearTransactions } = useWebSocket();

  return (
    <div
      className={`fixed top-0 right-0 h-full w-[380px] bg-civic-bg border-l border-civic-border
        transform transition-transform duration-300 z-50 flex flex-col
        ${open ? 'translate-x-0' : 'translate-x-full'}`}
    >
      {/* Header */}
      <div className="p-5 border-b border-civic-border">
        <div className="flex items-center gap-2 mb-3">
          <span className="w-px h-4 bg-civic-gold" />
          <h2 className="font-display text-lg">Insight</h2>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-civic-teal phase-active' : 'bg-civic-coral'}`} />
            <span className="text-civic-muted">{connected ? 'Live' : 'Offline'}</span>
          </span>
          <span className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-widest ${
            mode === 'fabric'
              ? 'bg-civic-teal/10 text-civic-teal border border-civic-teal/20'
              : 'bg-civic-amber/10 text-civic-amber border border-civic-amber/20'
          }`}>
            {mode}
          </span>
          <span className="text-civic-dim ml-auto font-mono text-[10px]">{transactions.length} txns</span>
        </div>
      </div>

      {/* Transaction feed */}
      <div className="flex-1 overflow-y-auto insight-scroll p-4 space-y-2">
        {transactions.length === 0 && (
          <div className="text-center mt-16">
            <p className="text-civic-dim text-xs leading-relaxed">
              No transactions yet.<br />
              <span className="text-civic-muted">Activity will appear here in real-time.</span>
            </p>
          </div>
        )}
        {[...transactions].reverse().map((tx, i) => (
          <div key={i} className="bg-civic-surface rounded p-3 text-xs space-y-2 border border-civic-border">
            {/* Function + status */}
            <div className="flex items-center justify-between">
              <span className="font-mono font-bold text-civic-gold text-[11px]">{tx.function}</span>
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wider ${
                tx.status === 'VALID'
                  ? 'bg-civic-teal/10 text-civic-teal'
                  : 'bg-civic-coral/10 text-civic-coral'
              }`}>
                {tx.status}
              </span>
            </div>
            {/* Args */}
            {tx.args?.length > 0 && (
              <div className="text-civic-dim font-mono text-[10px] truncate">
                [{tx.args.join(', ')}]
              </div>
            )}
            {/* Journey */}
            <div className="flex items-center gap-1 text-[9px]">
              <span className="text-civic-teal bg-civic-teal/5 px-1.5 py-0.5 rounded font-mono">ENDORSE</span>
              <span className="text-civic-dim">→</span>
              <span className="text-civic-gold bg-civic-gold/5 px-1.5 py-0.5 rounded font-mono">ORDER</span>
              <span className="text-civic-dim">→</span>
              <span className="text-civic-teal bg-civic-teal/5 px-1.5 py-0.5 rounded font-mono">COMMIT</span>
            </div>
            {/* Metadata */}
            <div className="flex items-center justify-between text-civic-dim font-mono text-[10px]">
              <span>BLK {tx.blockNumber}</span>
              <span>{tx.latencyMs}ms</span>
              <span>{tx.txId?.slice(0, 10)}…</span>
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-civic-border">
        <button
          onClick={clearTransactions}
          className="w-full py-2 text-[11px] uppercase tracking-widest text-civic-dim hover:text-civic-text bg-civic-surface border border-civic-border rounded transition-colors"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
