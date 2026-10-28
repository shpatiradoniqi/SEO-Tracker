export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// CSRF token for the current session, from the login and /auth/me responses. Kept in memory only:
// a refresh re-reads it from /auth/me, which every signed-in screen calls first.
let csrfToken: string | null = null;
export const setCsrfToken = (token: string | null) => { csrfToken = token; };

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(`/api${url}`, {
    method,
    credentials: 'same-origin',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  delete: <T>(url: string) => request<T>('DELETE', url),
};

export interface User { id: string; email: string; csrfToken: string }
export interface Client {
  id: string; name: string; websiteUrl: string; pageCount: number;
  jobId: string | null; jobStatus: JobStatus | null; jobError: string | null;
}
export type JobStatus = 'queued' | 'discovering' | 'crawling' | 'done' | 'failed';
export interface CrawlJob {
  id: string; clientId: string; clientName: string; websiteUrl: string; status: JobStatus;
  pagesFound: number; pagesDone: number; sitemapUrl: string | null; error: string | null;
}
export interface PageRow {
  id: string; url: string; title: string | null; clientId: string; clientName: string; issueCount: number;
  keywords: Array<{ term: string; position: number | null }>; bestPosition: number | null; positionDate: string | null;
}
export interface PageList { items: PageRow[]; total: number; page: number; pageSize: number }
export interface PageDetail {
  id: string; url: string; title: string | null; metaDescription: string | null; h1: string | null; wordCount: number;
  clientId: string; clientName: string; crawledAt: string;
  keywords: Array<{ id: number; term: string; score: number; latestPosition: number | null; latestCapturedAt: string | null }>;
  issues: Array<{ id: number; code: string; severity: 'high' | 'medium' | 'low'; message: string }>;
}
export interface History { from: string; to: string; timezone: string; points: Array<{ keywordId: number; date: string; position: number }> }
