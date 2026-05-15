import { createContext, useContext, useState, useEffect } from 'react';
import { auth as authApi } from '../services/api';
import { ensureRecoveryKeyRegistered } from '../services/crypto';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const syncRecoveryKey = async (sessionUser) => {
    await ensureRecoveryKeyRegistered(sessionUser.username, authApi.setRecoveryKey);
    return { ...sessionUser, hasRecoveryKey: true };
  };

  // Check for existing session on mount
  useEffect(() => {
    const token = localStorage.getItem('vivavote_token');
    if (token) {
      authApi.me()
        .then((data) => syncRecoveryKey(data.user))
        .then(setUser)
        .catch(() => localStorage.removeItem('vivavote_token'))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (username, password) => {
    const data = await authApi.login(username, password);
    localStorage.setItem('vivavote_token', data.token);
    const syncedUser = await syncRecoveryKey(data.user);
    setUser(syncedUser);
    return { ...data, user: syncedUser };
  };

  const register = async (username, password) => {
    const data = await authApi.register(username, password);
    localStorage.setItem('vivavote_token', data.token);
    const syncedUser = await syncRecoveryKey(data.user);
    setUser(syncedUser);
    return { ...data, user: syncedUser };
  };

  const logout = () => {
    localStorage.removeItem('vivavote_token');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
