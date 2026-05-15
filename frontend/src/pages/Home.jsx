import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const features = [
  {
    num: '01',
    title: 'Merkle Whitelisting',
    accent: 'O(1) on-chain registration',
    desc: 'Instead of storing every voter individually on-chain, we build a Merkle tree off-chain and store only the 32-byte root. Voters prove eligibility with a compact O(log N) proof at commit time.',
  },
  {
    num: '02',
    title: 'Commit-Reveal Voting',
    accent: 'Privacy-preserving ballots',
    desc: 'Voters first commit a blinded SHA-256 hash of their vote, then reveal it later. Nobody can observe your choice until the reveal phase opens — preventing vote-buying and coercion.',
  },
  {
    num: '03',
    title: 'Trustee Recovery',
    accent: 'Shamir Secret Sharing over GF(256)',
    desc: 'If a voter disappears after committing, trustees reconstruct the nonce using threshold secret sharing and count the vote. No deposits needed, no votes lost.',
  },
  {
    num: '04',
    title: 'Permissioned Deployment',
    accent: 'Mock and Fabric execution paths',
    desc: 'The application supports fast mock-mode workflows for development and a real Hyperledger Fabric path for end-to-end execution on a permissioned ledger with trustee governance.',
  },
];

export default function Home() {
  const { user } = useAuth();

  return (
    <div className="max-w-4xl mx-auto">
      {/* ── Hero ── */}
      <section className="pt-16 pb-20 animate-fade-up">
        <p className="text-[11px] uppercase tracking-[0.3em] text-civic-dim mb-8 font-mono">
          CSE6608 — Blockchain Technology · BUET
        </p>

        <h1 className="font-display leading-[0.9] mb-6">
          <span className="block text-7xl md:text-8xl text-gold-gradient">Viva</span>
          <span className="block text-7xl md:text-8xl text-civic-text mt-1">Vote</span>
        </h1>

        <div className="gold-rule w-24 my-8" />

        <p className="text-lg text-civic-muted max-w-lg leading-relaxed">
          Scalable and liveness-resilient blockchain voting
          on Hyperledger Fabric — where every ballot counts,
          even when voters disappear.
        </p>

        <div className="flex gap-3 mt-10">
          {user ? (
            <>
              <Link to="/elections" className="civic-btn-primary">
                View Elections
              </Link>
            </>
          ) : (
            <Link to="/login" className="civic-btn-primary">
              Enter System →
            </Link>
          )}
        </div>
      </section>

      {/* ── Features ── */}
      <section className="pb-20">
        {features.map((f, i) => (
          <div
            key={f.num}
            className={`animate-fade-up stagger-${i + 2}`}
          >
            <div className="gold-rule w-full mb-8" />
            <div className="grid md:grid-cols-[80px_1fr] gap-4 mb-10">
              <span className="font-display text-4xl text-civic-gold opacity-40">{f.num}</span>
              <div>
                <h3 className="font-display text-2xl mb-1">{f.title}</h3>
                <p className="text-xs uppercase tracking-[0.2em] text-civic-gold mb-3 font-mono">{f.accent}</p>
                <p className="text-sm text-civic-muted leading-relaxed max-w-lg">{f.desc}</p>
              </div>
            </div>
          </div>
        ))}
      </section>

      {/* ── Architecture ── */}
      <section className="pb-20 animate-fade-up stagger-7">
        <div className="gold-rule w-full mb-8" />
        <div className="grid md:grid-cols-[80px_1fr] gap-4">
          <span className="font-display text-4xl text-civic-gold opacity-40">⚙</span>
          <div>
            <h3 className="font-display text-2xl mb-6">System Architecture</h3>
            <div className="bg-civic-surface border border-civic-border rounded p-6 overflow-x-auto">
              <pre className="text-[11px] text-civic-muted font-mono leading-relaxed">{`
┌────────────────┐     ┌────────────────┐     ┌─────────────────────────────┐
│                │     │                │     │   Hyperledger Fabric        │
│   React UI     │────▶│  Express API   │────▶│                             │
│   (Vite)       │ WS  │  + WebSocket   │gRPC │  ┌──────────┐ ┌─────────┐  │
│                │◀────│                │◀────│  │ vivavote │ │baseline │  │
└────────────────┘     └───────┬────────┘     │  │ chaincode│ │chaincode│  │
                               │              │  └──────────┘ └─────────┘  │
                        ┌──────┴───────┐      │                             │
                        │  Off-chain   │      │  Org: ElectionCommission    │
                        │  • Merkle    │      │  Org: TrusteeOrg            │
                        │  • Shamir    │      └─────────────────────────────┘
                        └──────────────┘`.trim()}</pre>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
