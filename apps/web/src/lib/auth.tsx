import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { api, ApiError, setCsrfToken, type User } from './api';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<User>('/auth/me')
      .then((user) => { setCsrfToken(user.csrfToken); return user; })
      .catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))),
    staleTime: 5 * 60_000,
  });
}

/** Gate for every signed-in screen. The session lives in an httpOnly cookie, so a refresh just asks /auth/me. */
export function RequireAuth() {
  const { data: me, isLoading } = useMe();
  const location = useLocation();
  if (isLoading) return <p className="p-8 text-muted">Loading…</p>;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}
