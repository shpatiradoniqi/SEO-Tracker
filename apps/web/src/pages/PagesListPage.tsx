import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type Client, type PageList } from '../lib/api';
import { RankBadge } from '../components/RankBadge';
import { formatTimestamp } from '../lib/dates';

const PAGE_SIZE = 25;

export function PagesListPage() {
  // Filters live in the URL so a refresh, the back button and shared links keep them.
  const [params, setParams] = useSearchParams();
  const clientId = params.get('client') ?? '';
  const q = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [search, setSearch] = useState(q);

  const update = (next: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) (v ? p.set(k, v) : p.delete(k));
    setParams(p, { replace: true });
  };

  useEffect(() => {
    const t = setTimeout(() => { if (search.trim() !== q) update({ q: search.trim(), page: '' }); }, 300);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api.get<Client[]>('/clients') });
  const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (clientId) qs.set('clientId', clientId);
  if (q) qs.set('q', q);
  const list = useQuery({
    queryKey: ['pages', clientId, q, page],
    queryFn: () => api.get<PageList>(`/pages?${qs}`),
    placeholderData: keepPreviousData,
  });

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(page * PAGE_SIZE, total);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <h1 className="mr-auto text-2xl font-bold tracking-tight">Pages</h1>
        <label className="text-sm">
          <span className="mb-1 block text-muted">Client</span>
          <select value={clientId} onChange={(e) => update({ client: e.target.value, page: '' })}
            className="rounded-md border border-line bg-surface px-3 py-2">
            <option value="">All clients</option>
            {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">Search URL or keyword</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. keyword research"
            className="w-64 rounded-md border border-line bg-surface px-3 py-2" />
        </label>
      </div>

      {list.isError && <p role="alert" className="text-danger">Couldn’t load pages: {(list.error as Error).message}</p>}

      <div className="rounded-xl border border-line bg-surface md:overflow-x-auto">
        <table className="block w-full text-left md:table md:min-w-[760px]">
          <thead className="hidden border-b border-line text-sm text-muted md:table-header-group">
            <tr>
              <th className="px-4 py-3 font-medium">Page</th>
              <th className="px-4 py-3 font-medium">Likely keywords</th>
              <th className="px-4 py-3 text-right font-medium">Issues</th>
              <th className="whitespace-nowrap px-4 py-3 text-right font-medium">Best position</th>
            </tr>
          </thead>
          <tbody className={`block md:table-row-group ${list.isPlaceholderData ? 'opacity-60' : ''}`}>
            {list.isLoading && <tr className="block md:table-row"><td colSpan={4} className="px-4 py-8 text-muted">Loading pages…</td></tr>}
            {list.data?.items.length === 0 && (
              <tr className="block md:table-row"><td colSpan={4} className="block px-4 py-8 text-muted md:table-cell">
                {q || clientId ? 'No pages match these filters.' : <>No pages yet. <Link className="text-link underline" to="/clients/new">Add a client</Link> to crawl its blog.</>}
              </td></tr>
            )}
            {list.data?.items.map((p) => (
              <tr key={p.id} className="grid grid-cols-[1fr_auto] border-b border-line align-top last:border-0 hover:bg-bg md:table-row">
                <td className="col-span-2 max-w-md px-4 pt-3 md:table-cell md:py-3">
                  <Link to={`/pages/${p.id}`} className="font-semibold text-link hover:underline">{p.title ?? p.url}</Link>
                  <div className="truncate text-sm text-url" title={p.url}>{p.url.replace(/^https?:\/\//, '')}</div>
                  {!clientId && <div className="text-xs text-muted">{p.clientName}</div>}
                </td>
                <td className="col-span-2 px-4 py-2 md:table-cell md:py-3">
                  <ul className="flex flex-wrap gap-1.5">
                    {p.keywords.map((k) => (
                      <li key={k.term} className="inline-flex items-center gap-1.5 rounded-full border border-line py-0.5 pl-2.5 pr-0.5 text-sm">
                        {k.term} <RankBadge position={k.position} size="sm" />
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="px-4 pb-3 md:table-cell md:py-3 md:text-right">
                  <span className="text-sm text-muted md:hidden">Issues: </span>
                  <span className={p.issueCount ? 'font-semibold text-danger' : 'text-muted'}>{p.issueCount}</span>
                </td>
                <td className="px-4 pb-3 text-right md:table-cell md:py-3">
                  <RankBadge position={p.bestPosition} />
                  <div className="whitespace-nowrap text-xs text-muted">{p.positionDate ? formatTimestamp(p.positionDate) : 'Not tracked yet'}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
        <span className="text-muted">{total ? `Showing ${first}–${last} of ${total}` : ''}</span>
        <div className="flex items-center gap-2">
          <button disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}
            className="rounded-md border border-line bg-surface px-3 py-1.5 disabled:opacity-40">Previous</button>
          <span>Page {page} of {pages}</span>
          <button disabled={page >= pages} onClick={() => update({ page: String(page + 1) })}
            className="rounded-md border border-line bg-surface px-3 py-1.5 disabled:opacity-40">Next</button>
        </div>
      </nav>
    </div>
  );
}
