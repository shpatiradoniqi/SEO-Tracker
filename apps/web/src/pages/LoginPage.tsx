import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, setCsrfToken, type User } from '../lib/api';
import { useMe } from '../lib/auth';

export function LoginPage() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/pages';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await api.post<User>('/auth/login', { email, password });
      setCsrfToken(user.csrfToken);
      qc.setQueryData(['me'], user);
      navigate(from, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-line bg-surface p-6" noValidate>
        <h1 className="text-2xl font-bold tracking-tight">Rank Tracker</h1>
        <p className="mb-6 text-muted">Sign in to see your clients’ pages and positions.</p>
        <label className="mb-1 block text-sm font-medium" htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)}
          className="mb-4 w-full rounded-md border border-line bg-surface px-3 py-2" />
        <label className="mb-1 block text-sm font-medium" htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)}
          className="mb-4 w-full rounded-md border border-line bg-surface px-3 py-2" />
        {error && <p role="alert" className="mb-4 text-sm text-danger">{error}</p>}
        <button disabled={busy} className="w-full rounded-md bg-link px-4 py-2 font-semibold text-surface disabled:opacity-60">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
