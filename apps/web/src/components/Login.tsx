import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
  const { login, register, allowRegister, error, clearError } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    clearError();
    setBusy(true);
    try {
      if (mode === 'login') await login(username, password);
      else await register(username, password);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <h1>CSB Knowledge Portal</h1>
        <p className="subtitle">Private knowledge bases · upload, chunk, and ask with isolation per user</p>

        {(localError || error) && (
          <p className="error-text">{localError || error}</p>
        )}

        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            minLength={2}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            minLength={6}
          />
        </div>

        <div className="login-actions">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </div>

        {allowRegister && (
          <p style={{ marginTop: 16, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            {mode === 'login' ? (
              <>
                No account?{' '}
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setMode('register')}
                  style={{ padding: 0 }}
                >
                  Register
                </button>
              </>
            ) : (
              <>
                Already registered?{' '}
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setMode('login')}
                  style={{ padding: 0 }}
                >
                  Sign in
                </button>
              </>
            )}
          </p>
        )}
      </form>
    </div>
  );
}
