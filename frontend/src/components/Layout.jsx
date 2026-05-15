import { useState } from 'react';
import Navbar from './Navbar';
import BackendInsightPanel from './BackendInsightPanel';

export default function Layout({ children }) {
  const [insightOpen, setInsightOpen] = useState(false);

  return (
    <div className="min-h-screen bg-civic-bg relative">
      <Navbar
        onToggleInsight={() => setInsightOpen(!insightOpen)}
        insightOpen={insightOpen}
      />
      <main className={`transition-all duration-300 ${insightOpen ? 'mr-[380px]' : ''}`}>
        <div className="max-w-5xl mx-auto px-6 py-8">
          {children}
        </div>
      </main>
      <BackendInsightPanel open={insightOpen} />
    </div>
  );
}
