import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, ApiError, type History, type PageDetail } from '../lib/api';
import { RankBadge } from '../components/RankBadge';
import { addDays, formatDay, torontoToday } from '../lib/dates';

const LINE_COLORS = ['#1a4fd6', '#0d7a4c', '#a86a12', '#8e3fbf', '#c2410c', '#0e7490', '#be185d', '#4d7c0f'];
const PRESETS = [7, 30, 90, 365] as const;
const SEVERITY_STYLE = { high: 'text-danger', medium: 'text-page2', low: 'text-muted' } as const;

export function PageDetailPage() {
  const { id } = useParams();
  const today = torontoToday();
  const [range, setRange] = useState({ from: addDays(today, -29), to: today });
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [hidden, setHidden] = useState<Set<number>>(new Set());

  const page = useQuery({ queryKey: ['page', id], queryFn: () => api.get<PageDetail>(`/pages/${id}`) });
  const history = useQuery({
    queryKey: ['history', id, range.from, range.to],
    queryFn: () => api.get<History>(`/pages/${id}/history?from=${range.from}&to=${range.to}`),
    enabled: !!page.data && range.from <= range.to,
    placeholderData: keepPreviousData,
  });

  // Pivot to one row per Toronto date with a column per keyword id, which is what the chart and table need.
  const rows = useMemo(() => {
    const byDate = new Map<string, Record<string, number | string>>();
    for (const p of history.data?.points ?? []) {
      const row = byDate.get(p.date) ?? byDate.set(p.date, { date: p.date }).get(p.date)!;
      row[`k${p.keywordId}`] = p.position;
    }
    return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [history.data]);

  // Clean ticks at 1, 10, 20, ... up to the worst position shown, rounded up to a multiple of 10.
  const worst = Math.max(10, ...(history.data?.points ?? []).map((pt) => pt.position));
  const yMax = Math.min(100, Math.ceil(worst / 10) * 10);
  const yTicks = [1, ...Array.from({ length: yMax / 10 }, (_, i) => (i + 1) * 10)];

  if (page.isLoading) return <p className="text-muted">Loading page…</p>;
  if (page.error) {
    return (
      <div>
        <p className="mb-2 text-lg font-semibold">{page.error instanceof ApiError && page.error.status === 404 ? 'This page doesn’t exist or isn’t one of yours.' : (page.error as Error).message}</p>
        <Link to="/pages" className="text-link underline">Back to pages</Link>
      </div>
    );
  }
  const p = page.data!;
  const keywords = p.keywords;
  const activePreset = PRESETS.find((d) => range.to === today && range.from === addDays(today, -(d - 1)));
  const toggle = (kid: number) => setHidden((h) => { const n = new Set(h); n.has(kid) ? n.delete(kid) : n.add(kid); return n; });

  return (
    <div>
      <Link to={`/pages?client=${p.clientId}`} className="text-sm text-muted hover:text-ink">‹ {p.clientName} pages</Link>
      <h1 className="mt-1 text-2xl font-bold tracking-tight text-link">{p.title ?? p.url}</h1>
      <a href={p.url} target="_blank" rel="noreferrer" className="break-all text-url hover:underline">{p.url}</a>
      {p.metaDescription && <p className="mt-1 max-w-3xl text-muted">{p.metaDescription}</p>}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <section className="min-w-0 rounded-xl border border-line bg-surface p-4">
          <div className="mb-3 flex items-center gap-3">
            <h2 className="mr-auto text-lg font-semibold">Position history</h2>
            <div className="flex gap-1" role="group" aria-label="View">
              {(['chart', 'table'] as const).map((v) => (
                <button key={v} onClick={() => setView(v)} aria-pressed={view === v}
                  className={`rounded-md border px-2.5 py-1 text-sm capitalize ${view === v ? 'border-link text-link' : 'border-line'}`}>{v}</button>
              ))}
            </div>
          </div>
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex gap-1" role="group" aria-label="Date range">
              {PRESETS.map((d) => (
                <button key={d} onClick={() => setRange({ from: addDays(today, -(d - 1)), to: today })} aria-pressed={activePreset === d}
                  className={`rounded-md border px-2.5 py-1 text-sm ${activePreset === d ? 'border-link text-link' : 'border-line'}`}>
                  {d === 365 ? '1 year' : `${d} days`}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-sm">
              <label><span className="sr-only">From</span>
                <input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))}
                  className="rounded-md border border-line bg-surface px-2 py-1" /></label>
              <span className="text-muted">to</span>
              <label><span className="sr-only">To</span>
                <input type="date" value={range.to} min={range.from} max={today} onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))}
                  className="rounded-md border border-line bg-surface px-2 py-1" /></label>
            </div>
          </div>
          <p className="mb-3 text-xs text-muted">Dates are Toronto time.</p>

          {history.isError && <p role="alert" className="text-danger">{(history.error as Error).message}</p>}
          {!history.isLoading && rows.length === 0 && (
            <p className="py-12 text-center text-muted">
              {keywords.length === 0 ? 'No keywords were found on this page.' : 'No positions in this range. New pages get rank data the next time the seed runs.'}
            </p>
          )}

          {rows.length > 0 && view === 'chart' && (
            <div className={`h-80 ${history.isPlaceholderData ? 'opacity-60' : ''}`}>
              <ResponsiveContainer>
                <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: -12 }}>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={(d: string) => formatDay(d, { month: 'short', day: 'numeric' })} stroke="var(--muted)" fontSize={12} minTickGap={24} />
                  {/* Position 1 is best, so it sits at the top. */}
                  <YAxis reversed domain={[1, yMax]} ticks={yTicks} allowDecimals={false} stroke="var(--muted)" fontSize={12} />
                  {yMax > 10 && (
                    <ReferenceLine y={10.5} stroke="var(--page1)" strokeDasharray="4 4"
                      label={{ value: 'End of page 1', position: 'insideTopRight', fill: 'var(--page1)', fontSize: 11 }} />
                  )}
                  <Tooltip
                    labelFormatter={(d) => formatDay(String(d))}
                    contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8 }}
                  />
                  <Legend onClick={(e) => toggle(Number(String(e.dataKey).slice(1)))} wrapperStyle={{ cursor: 'pointer', fontSize: 13 }} />
                  {keywords.map((k, i) => (
                    <Line key={k.id} type="monotone" dataKey={`k${k.id}`} name={k.term} hide={hidden.has(k.id)}
                      stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={2} dot={rows.length <= 31} isAnimationActive={false} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {rows.length > 0 && view === 'table' && (
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface text-muted">
                  <tr>
                    <th className="px-2 py-2 text-left font-medium">Date</th>
                    {keywords.map((k) => <th key={k.id} className="px-2 py-2 text-right font-medium">{k.term}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {[...rows].reverse().map((r) => (
                    <tr key={String(r.date)} className="border-t border-line">
                      <td className="whitespace-nowrap px-2 py-1.5">{formatDay(String(r.date))}</td>
                      {keywords.map((k) => <td key={k.id} className="px-2 py-1.5 text-right">{r[`k${k.id}`] ?? '–'}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="space-y-6">
          <section className="rounded-xl border border-line bg-surface p-4">
            <h2 className="mb-3 text-lg font-semibold">Keywords</h2>
            {keywords.length === 0 && <p className="text-muted">None found.</p>}
            <ul className="space-y-2">
              {keywords.map((k) => (
                <li key={k.id} className="flex items-center justify-between gap-3">
                  <span>{k.term}</span>
                  <RankBadge position={k.latestPosition} />
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-xl border border-line bg-surface p-4">
            <h2 className="mb-3 text-lg font-semibold">SEO issues <span className="text-muted">({p.issues.length})</span></h2>
            {p.issues.length === 0 && <p className="text-muted">No issues found on this page.</p>}
            <ul className="space-y-3">
              {p.issues.map((i) => (
                <li key={i.id}>
                  <span className={`text-sm font-semibold capitalize ${SEVERITY_STYLE[i.severity]}`}>{i.severity}</span>
                  <p className="text-sm">{i.message}</p>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
