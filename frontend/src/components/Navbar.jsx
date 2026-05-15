import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Navbar({ onToggleInsight, insightOpen }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const navLink = (to, label) => {
    const active = location.pathname === to || location.pathname.startsWith(to + '/');
    return (
      <Link
        to={to}
        className={`text-[11px] uppercase tracking-[0.15em] font-semibold transition-colors duration-200 ${
          active ? 'text-civic-gold' : 'text-civic-muted hover:text-civic-text'
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <nav className="sticky top-0 z-40 bg-civic-bg/95 backdrop-blur-sm border-b border-civic-border">
      <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-3 group">
          <span className="w-px h-5 bg-civic-gold" />
          <span className="font-display text-xl tracking-tight text-gold-gradient">
            VivaVote
          </span>
        </Link>

        {/* Nav links */}
        <div className="flex items-center gap-6">
          {user && (
            <>
              {navLink('/elections', 'Elections')}
              {user.role === 'admin' && (
                <>
                  {navLink('/create', 'Create')}
                  {navLink('/admin', 'Admin')}
                </>
              )}
              {user.role !== 'admin' && navLink('/trustee', 'Trustee')}
              <span className="w-px h-4 bg-civic-border" />
            </>
          )}

          {/* Insight toggle */}
          <button
            onClick={onToggleInsight}
            className={`w-8 h-8 rounded flex items-center justify-center text-xs font-mono transition-all duration-200 ${
              insightOpen
                ? 'bg-civic-gold text-civic-bg'
                : 'bg-civic-elevated text-civic-dim hover:text-civic-gold border border-civic-border'
            }`}
            title="Backend Insight"
          >
            {'/>'}
          </button>

          {/* User info */}
          {user ? (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-civic-teal" />
                <span className="text-xs text-civic-muted font-mono">{user.username}</span>
                <span className="text-[9px] uppercase tracking-[0.2em] text-civic-dim border border-civic-border rounded px-1.5 py-0.5">
                  {user.role}
                </span>
              </div>
              <button
                onClick={handleLogout}
                className="text-[11px] text-civic-dim hover:text-civic-coral transition-colors"
              >
                Exit
              </button>
            </div>
          ) : (
            <Link to="/login" className="text-[11px] uppercase tracking-[0.15em] font-semibold text-civic-gold hover:text-civic-gold-light transition-colors">
              Enter
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}
