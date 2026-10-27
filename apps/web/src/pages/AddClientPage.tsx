import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Client, type CrawlJob } from '../lib/api';

const STEP_LABEL: Record<CrawlJob['status'], string> = {
  queued: 'Waiting to start',
  discovering: 'Finding the blog sitemap',
  crawling: 'Crawling posts',
  done: 'Finished',
  failed: 'Failed',
};

function looksLikeUrl(value: string) {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.');
  } catch {
    return false;
  }
}

/** Turns "No usable sitemap found. Tried: a, b, c" into a short sentence plus an expandable list. */
function CrawlError({ message }: { message: string }) {
  const tried = message.match(/^No usable sitemap found\. Tried: (.*)$/)?.[1]?.split(', ');
  if (!tried) return <p className="text-sm">{message}</p>;
  return (
    <div className="text-sm">
      <p>This site doesn’t publish a sitemap in any of the usual places, so there was nothing to crawl.</p>
      <details className="mt-1 text-muted">
        <summary className="cursor-pointer">Locations checked ({tried.length})</summary>
        <ul className="mt-1 break-all">{tried.map((u) => <li key={u}>{u}</li>)}</ul>
      </details>
    </div>
  );
}

function JobProgress({ jobId }: { jobId: string }) {
  const qc = useQueryClient();
  const job = useQuery({
    queryKey: ['job', jobId],
    queryFn: async () => {
      const j = await api.get<CrawlJob>(`/crawl-jobs/${jobId}`);
      if (j.status === 'done' || j.status === 'failed') {
        void qc.invalidateQueries({ queryKey: ['clients'] });
        void qc.invalidateQueries({ queryKey: ['pages'] });
      }
      return j;
    },
    // Poll while the crawl runs; stop once it settles.
    refetchInterval: (q) => (q.state.data && ['done', 'failed'].includes(q.state.data.status) ? false : 1500),
  });
  if (!job.data) return <p className="text-muted">Starting crawl…</p>;
  const j = job.data;
  const pct = j.pagesFound ? Math.round((j.pagesDone / j.pagesFound) * 100) : 0;
  return (
    <div className="rounded-xl border border-line bg-surface p-4" aria-live="polite">
      <p className="font-semibold">{j.clientName} <span className="font-normal text-url">{j.websiteUrl.replace(/^https?:\/\//, '')}</span></p>
      <p className={j.status === 'failed' ? 'text-danger' : 'text-muted'}>
        {STEP_LABEL[j.status]}{j.status === 'crawling' && j.pagesFound ? `: ${j.pagesDone} of ${j.pagesFound}` : ''}
      </p>
      {(j.status === 'crawling' || j.status === 'discovering') && (
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-link transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {j.sitemapUrl && <p className="mt-2 break-all text-xs text-muted">Sitemap: {j.sitemapUrl}</p>}
      {j.status === 'failed' && j.error && <div className="mt-2"><CrawlError message={j.error} /></div>}
      {j.status === 'done' && (
        <p className="mt-2">
          Crawled {j.pagesDone} posts. <Link to={`/pages?client=${j.clientId}`} className="text-link underline">View pages</Link>
          <span className="block text-sm text-muted">Positions appear after the next seed run.</span>
        </p>
      )}
    </div>
  );
}

export function AddClientPage() {
  const [params, setParams] = useSearchParams();
  const jobId = params.get('job');
  const [name, setName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api.get<Client[]>('/clients') });
  const [rowError, setRowError] = useState<string | null>(null);

  const recrawl = async (c: Client) => {
    setRowError(null);
    try {
      const res = await api.post<{ jobId: string }>(`/clients/${c.id}/crawl`);
      setParams({ job: res.jobId });
      void qc.invalidateQueries({ queryKey: ['clients'] });
    } catch (err) { setRowError((err as Error).message); }
  };
  const remove = async (c: Client) => {
    if (!window.confirm(`Remove ${c.name} and all of its pages and rank history?`)) return;
    setRowError(null);
    try {
      await api.delete(`/clients/${c.id}`);
      if (jobId && c.jobId === jobId) setParams({});
      void qc.invalidateQueries({ queryKey: ['clients'] });
      void qc.invalidateQueries({ queryKey: ['pages'] });
    } catch (err) { setRowError((err as Error).message); }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Enter a client name.');
    if (!looksLikeUrl(websiteUrl.trim())) return setError('Enter a valid website URL, for example https://example.com.');
    setBusy(true);
    try {
      const res = await api.post<{ clientId: string; jobId: string }>('/clients', { name, websiteUrl });
      setParams({ job: res.jobId });
      setName('');
      setWebsiteUrl('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,420px)_1fr]">
      <div>
        <h1 className="mb-1 text-2xl font-bold tracking-tight">Add a client</h1>
        <p className="mb-6 text-muted">We’ll find the site’s blog sitemap and crawl its first 15 posts. This usually takes under a minute.</p>
        <form onSubmit={submit} noValidate className="space-y-4">
          <div>
            <label htmlFor="name" className="mb-1 block text-sm font-medium">Client name</label>
            <input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100}
              className="w-full rounded-md border border-line bg-surface px-3 py-2" />
          </div>
          <div>
            <label htmlFor="url" className="mb-1 block text-sm font-medium">Website URL</label>
            <input id="url" value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} placeholder="https://example.com"
              inputMode="url" className="w-full rounded-md border border-line bg-surface px-3 py-2" />
          </div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <button disabled={busy} className="rounded-md bg-link px-4 py-2 font-semibold text-surface disabled:opacity-60">
            {busy ? 'Adding…' : 'Add client and crawl'}
          </button>
        </form>
        {jobId && <div className="mt-6"><JobProgress key={jobId} jobId={jobId} /></div>}
      </div>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Your clients</h2>
        {rowError && <p role="alert" className="mb-2 text-sm text-danger">{rowError}</p>}
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {clients.data?.length === 0 && <li className="p-4 text-muted">No clients yet.</li>}
          {clients.data?.map((c) => (
            <li key={c.id} className="flex flex-wrap items-baseline gap-x-3 p-4">
              <Link to={`/pages?client=${c.id}`} className="font-semibold text-link hover:underline">{c.name}</Link>
              <span className="text-sm text-url">{c.websiteUrl.replace(/^https?:\/\//, '')}</span>
              <span className="ml-auto text-sm text-muted">
                {c.jobStatus === 'failed' ? <span className="text-danger">Crawl failed</span>
                  : c.jobStatus && c.jobStatus !== 'done' ? STEP_LABEL[c.jobStatus]
                  : `${c.pageCount} pages`}
              </span>
              {c.jobStatus === 'failed' && c.jobError && <div className="mt-1 w-full text-muted"><CrawlError message={c.jobError} /></div>}
              {(c.jobStatus === 'done' || c.jobStatus === 'failed' || !c.jobStatus) && (
                <div className="mt-2 flex w-full gap-2 text-sm">
                  <button onClick={() => recrawl(c)} className="rounded-md border border-line px-2.5 py-1 hover:bg-bg">
                    {c.jobStatus === 'failed' ? 'Retry crawl' : 'Crawl again'}
                  </button>
                  <button onClick={() => remove(c)} className="rounded-md border border-line px-2.5 py-1 text-danger hover:bg-bg">Remove</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
