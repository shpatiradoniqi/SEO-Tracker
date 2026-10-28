import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/auth/password.js';

// Runs against the database in DATABASE_URL with its own throwaway users (removed afterwards).
const tag = `t${Date.now()}`;
const A = { email: `a-${tag}@test.dev`, password: 'pw-a' };
const B = { email: `b-${tag}@test.dev`, password: 'pw-b' };
let app: FastifyInstance;
let cookieA = '';
let csrfA = '';
const ids = { bClient: '', bPage: '', bJob: '', aPage: '' };

async function makeUser(email: string, password: string, host: string) {
  const { rows: [u] } = await pool.query('INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id', [email, await hashPassword(password)]);
  const { rows: [c] } = await pool.query(
    'INSERT INTO clients(user_id, name, website_url, normalized_host) VALUES ($1, $2, $3, $4) RETURNING id',
    [u.id, host, `https://${host}`, host]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO pages(client_id, url, sitemap_position, title, status_code) VALUES ($1, $2, 1, 'T', 200) RETURNING id`,
    [c.id, `https://${host}/blog/post-${tag}/`]);
  const { rows: [k] } = await pool.query(
    `INSERT INTO keywords(term) VALUES ($1) ON CONFLICT (term) DO UPDATE SET term = EXCLUDED.term RETURNING id`, [`kw ${host} ${tag}`]);
  const { rows: [pk] } = await pool.query(
    'INSERT INTO page_keywords(page_id, keyword_id, score, rank_order) VALUES ($1, $2, 1, 1) RETURNING id', [p.id, k.id]);
  // 03:30 UTC on Jan 15 is 22:30 on Jan 14 in Toronto: the history must report it as Jan 14.
  await pool.query(`INSERT INTO rank_snapshots VALUES ($1, '2026-01-15T03:30:00Z', 7), ($1, '2026-07-15T03:30:00Z', 9)`, [pk.id]);
  const { rows: [j] } = await pool.query('INSERT INTO crawl_jobs(client_id, status) VALUES ($1, $2) RETURNING id', [c.id, 'done']);
  return { client: c.id as string, page: p.id as string, job: j.id as string };
}

beforeAll(async () => {
  await migrate();
  app = await buildApp();
  const a = await makeUser(A.email, A.password, `a-${tag}.test`);
  const b = await makeUser(B.email, B.password, `b-${tag}.test`);
  Object.assign(ids, { aPage: a.page, bClient: b.client, bPage: b.page, bJob: b.job });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: A });
  cookieA = String(res.headers['set-cookie']).split(';')[0]!;
  csrfA = res.json().csrfToken;
});

afterAll(async () => {
  await pool.query('DELETE FROM users WHERE email IN ($1, $2)', [A.email, B.email]);
  await pool.query(`DELETE FROM login_attempts WHERE key LIKE $1 OR key = 'ip:127.0.0.1'`, [`email:%${tag}%`]);
  await pool.query(`DELETE FROM keywords WHERE term LIKE $1`, [`%${tag}`]);
  await app.close();
  await pool.end();
});

const asA = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie: cookieA, 'x-csrf-token': csrfA } });
const login = (email: string, password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

describe('auth', () => {
  it('rejects a wrong password and unauthenticated requests', async () => {
    expect((await login(A.email, 'nope')).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/pages' })).statusCode).toBe(401);
  });
  it('restores the session from the cookie', async () => {
    const me = await asA('GET', '/api/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe(A.email);
    expect(me.json().csrfToken).toBe(csrfA);
  });
});

describe('CSRF', () => {
  const addClient = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/api/clients', payload: { name: 'X', websiteUrl: 'not a url' }, headers });
  it('rejects state-changing requests without the session\'s token', async () => {
    expect((await addClient({ cookie: cookieA })).statusCode).toBe(403);
    expect((await addClient({ cookie: cookieA, 'x-csrf-token': 'forged' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/clients/${ids.bClient}`, headers: { cookie: cookieA } })).statusCode).toBe(403);
  });
  it('does not accept another session\'s token', async () => {
    const other = await login(A.email, A.password);
    expect((await addClient({ cookie: cookieA, 'x-csrf-token': other.json().csrfToken })).statusCode).toBe(403);
  });
  it('lets reads through without a token and accepts the right one', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/clients', headers: { cookie: cookieA } })).statusCode).toBe(200);
    expect((await addClient({ cookie: cookieA, 'x-csrf-token': csrfA })).statusCode).toBe(400); // passed CSRF, failed validation
  });
});

describe('login rate limiting', () => {
  it('locks an email after 5 failures, even for the right password, and says when to retry', async () => {
    const email = `locked-${tag}@test.dev`;
    await pool.query('INSERT INTO users(email, password_hash) VALUES ($1, $2)', [email, await hashPassword('right')]);
    for (let i = 0; i < 5; i++) expect((await login(email, 'wrong')).statusCode).toBe(401);
    const locked = await login(email, 'right');
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(locked.json().error).toMatch(/Try again in 15 minutes/);
    await pool.query('DELETE FROM users WHERE email = $1', [email]);
  });
  it('a successful sign-in resets the account\'s counter', async () => {
    for (let i = 0; i < 4; i++) await login(B.email, 'wrong');
    expect((await login(B.email, B.password)).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login(B.email, 'wrong')).statusCode).toBe(401);
    expect((await login(B.email, B.password)).statusCode).toBe(200);
  });
});

describe('tenancy: user A cannot reach user B data by any route', () => {
  it.each([
    () => `/api/pages/${ids.bPage}`,
    () => `/api/pages/${ids.bPage}/history?from=2026-01-01&to=2026-12-31`,
    () => `/api/crawl-jobs/${ids.bJob}`,
  ])('GET %s answers 404', async (url) => {
    expect((await asA('GET', url())).statusCode).toBe(404);
  });
  it('filtering by B\'s client id returns nothing', async () => {
    const res = await asA('GET', `/api/pages?clientId=${ids.bClient}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });
  it('searching for B\'s URL or keyword returns nothing', async () => {
    expect((await asA('GET', `/api/pages?q=b-${tag}`)).json().items).toEqual([]);
    expect((await asA('GET', `/api/clients`)).json().map((c: { id: string }) => c.id)).not.toContain(ids.bClient);
  });
  it('cannot recrawl or delete B\'s client', async () => {
    expect((await asA('POST', `/api/clients/${ids.bClient}/crawl`)).statusCode).toBe(404);
    expect((await asA('DELETE', `/api/clients/${ids.bClient}`)).statusCode).toBe(404);
    const { rows } = await pool.query('SELECT 1 FROM clients WHERE id = $1', [ids.bClient]);
    expect(rows).toHaveLength(1);
  });
  it('malformed ids answer 404, not 500', async () => {
    expect((await asA('GET', '/api/pages/not-a-uuid')).statusCode).toBe(404);
  });
});

describe('pages and history', () => {
  it('lists A\'s page with keywords and latest position fields', async () => {
    const res = (await asA('GET', `/api/pages?q=a-${tag}`)).json();
    expect(res.total).toBe(1);
    expect(res.items[0].keywords[0].term).toContain(`a-${tag}`);
  });
  it('treats LIKE wildcards in search as literal text', async () => {
    expect((await asA('GET', '/api/pages?q=%25')).json().total).toBe(0);
  });
  it('groups snapshots by Toronto calendar date, not UTC date', async () => {
    const res = (await asA('GET', `/api/pages/${ids.aPage}/history?from=2026-01-14&to=2026-01-14`)).json();
    expect(res.points).toEqual([expect.objectContaining({ date: '2026-01-14', position: 7 })]);
    const empty = (await asA('GET', `/api/pages/${ids.aPage}/history?from=2026-01-15&to=2026-01-15`)).json();
    expect(empty.points).toEqual([]);
  });
  it('rejects an inverted date range', async () => {
    expect((await asA('GET', `/api/pages/${ids.aPage}/history?from=2026-02-01&to=2026-01-01`)).statusCode).toBe(400);
  });
});

describe('add client', () => {
  it.each(['not a url', 'ftp://x.com', 'http://127.0.0.1', 'http://localhost:3000'])('rejects %j with 400', async (websiteUrl) => {
    expect((await asA('POST', '/api/clients', { name: 'X', websiteUrl })).statusCode).toBe(400);
  });
  it('rejects the same website twice for the same user, ignoring www and trailing slash', async () => {
    const first = await asA('POST', '/api/clients', { name: 'Example', websiteUrl: 'https://example.com' });
    expect(first.statusCode).toBe(202);
    const second = await asA('POST', '/api/clients', { name: 'Example again', websiteUrl: 'www.EXAMPLE.com/' });
    expect(second.statusCode).toBe(409);
    const job = await asA('GET', `/api/crawl-jobs/${first.json().jobId}`);
    expect(job.json().status).toBe('queued');
    // A second crawl cannot be queued while one is pending; deleting frees the host for re-adding.
    expect((await asA('POST', `/api/clients/${first.json().clientId}/crawl`)).statusCode).toBe(409);
    const del = await asA('DELETE', `/api/clients/${first.json().clientId}`);
    expect(del.statusCode).toBe(204);
  });
});
