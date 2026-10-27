import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-md font-medium ${isActive ? 'bg-bg text-ink' : 'text-muted hover:text-ink'}`;

export function Layout() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const signOut = async () => {
    await api.post('/auth/logout');
    qc.clear();
    navigate('/login', { replace: true });
  };
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3">
          <span className="mr-4 text-lg font-bold tracking-tight">Rank Tracker</span>
          <nav className="flex gap-1">
            <NavLink to="/pages" className={linkClass}>Pages</NavLink>
            <NavLink to="/clients/new" className={linkClass}>Add client</NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-muted">{me?.email}</span>
            <button onClick={signOut} className="rounded-md border border-line px-3 py-1.5 hover:bg-bg">Sign out</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
