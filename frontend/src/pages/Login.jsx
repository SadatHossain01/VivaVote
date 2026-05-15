import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { login, register } = useAuth();
  const navigate = useNavigate();

  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (isRegister) {
        await register(username, password);
      } else {
        await login(username, password);
      }
      navigate('/elections');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[70vh] flex items-center justify-center">
      <div className="w-full max-w-sm animate-fade-up">
        {/* Gold accent line */}
        <div className="gold-rule w-16 mb-8" />

        <h1 className="font-display text-3xl mb-1">
          {isRegister ? 'Create Account' : 'Welcome'}
        </h1>
        <p className="text-sm text-civic-dim mb-8">
          {isRegister
            ? 'Register to participate in blockchain elections. Your browser will create a recovery key pair automatically.'
            : 'Sign in to continue. Demo admin: admin / admin'}
        </p>

        {error && (
          <div className="bg-civic-coral/10 border border-civic-coral/20 text-civic-coral text-sm rounded px-4 py-3 mb-6">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="text-[11px] uppercase tracking-[0.15em] text-civic-dim block mb-2">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="civic-input"
              placeholder="Enter username"
              required
            />
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-[0.15em] text-civic-dim block mb-2">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="civic-input"
              placeholder="Enter password"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full civic-btn-primary py-3 disabled:opacity-40"
          >
            {loading ? '···' : isRegister ? 'Create Account' : 'Sign In'}
          </button>
        </form>

        <div className="mt-8 text-center">
          <button
            onClick={() => { setIsRegister(!isRegister); setError(''); }}
            className="text-xs text-civic-dim hover:text-civic-gold transition-colors"
          >
            {isRegister ? '← Back to sign in' : 'Need an account? Register'}
          </button>
        </div>
      </div>
    </div>
  );
}
