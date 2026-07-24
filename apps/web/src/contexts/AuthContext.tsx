import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { authApi, type User } from '../services/api';

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  allowRegister: boolean;
  error: string;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [allowRegister, setAllowRegister] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const boot = await authApi.bootstrap();
        if (!cancelled) setAllowRegister(boot.allowRegister);
        const me = await authApi.me();
        if (!cancelled) setUser(me.user);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    setError('');
    try {
      const res = await authApi.login(username, password);
      setUser(res.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed');
      throw e;
    }
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    setError('');
    try {
      const res = await authApi.register(username, password);
      setUser(res.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Register failed');
      throw e;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      allowRegister,
      error,
      login,
      register,
      logout,
      clearError: () => setError(''),
    }),
    [user, loading, allowRegister, error, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside provider');
  return ctx;
}
