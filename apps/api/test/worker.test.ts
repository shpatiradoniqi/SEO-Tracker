import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { crawlSite } from '@seo/crawler';
import { pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { claim, reapStale, runJob, MAX_ATTEMPTS } from '../src/worker.js';

// Uses its own throwaway user and client; claims are scoped to that client so other queued jobs are untouched.
const tag = `w${Date.now()}`;
let clientId = '';
const noLog = () => {};

const fakeCrawl = (async () => ({
  discovery: { sitemapUrl: 'https://w.test/sitemap.xml', strategy: 'blog-sitemap', urls: [], tried: [] },
  pages: [{
    position: 1,
    page: { url: `https://w.test/blog/${tag}/`, title: 'T', metaDescription: null, h1: ['T'], status: 200, wordCount: 500 },
    keywords: [{ term: `kw ${tag}`, score: 1 }],
    issues: [],
  }],
})) as unknown as typeof crawlSite;

const queueJob = async () =>
  (await pool.query<{ id: string }>('INSERT INTO crawl_jobs(client_id) VALUES ($1) RETURNING id', [clientId])).rows[0]!.id;
const job = async (id: string) => (await pool.query('SELECT * FROM crawl_jobs WHERE id = $1', [id])).rows[0];

beforeAll(async () => {
  await migrate();
  const { rows: [u] } = await pool.query(`INSERT INTO users(email, password_hash) VALUES ($1, 'x') RETURNING id`, [`${tag}@test.dev`]);
  const { rows: [c] } = await pool.query(
    `INSERT INTO clients(user_id, name, website_url, normalized_host) VALUES ($1, 'W', 'https://w.test', $2) RETURNING id`,
    [u.id, `${tag}.test`]);
  clientId = c.id;
});

beforeEach(async () => { await pool.query('DELETE FROM crawl_jobs WHERE client_id = $1', [clientId]); });

afterAll(async () => {
  await pool.query('DELETE FROM users WHERE email = $1', [`${tag}@test.dev`]);
  await pool.query('DELETE FROM keywords WHERE term LIKE $1', [`%${tag}`]);
  await pool.end();
});

describe('crawl queue', () => {
  it('never hands the same job to two workers', async () => {
    const ids = [await queueJob(), await queueJob()];
    const [a, b, c] = await Promise.all([claim('w-a', clientId), claim('w-b', clientId), claim('w-c', clientId)]);
    const claimed = [a, b, c].filter(Boolean).map((j) => j!.id);
    expect(claimed.sort()).toEqual(ids.sort());
    expect((await job(a?.id ?? b!.id)).attempts).toBe(1);
  });

  it('re-queues a job whose worker stopped sending heartbeats, but not a healthy one', async () => {
    const stale = await queueJob();
    const healthy = await queueJob();
    await claim('w-dead', clientId);
    await claim('w-alive', clientId);
    await pool.query(`UPDATE crawl_jobs SET heartbeat_at = now() - interval '5 minutes' WHERE id = $1`, [stale]);
    await reapStale();
    expect((await job(stale)).status).toBe('queued');
    expect((await job(stale)).worker_id).toBeNull();
    expect((await job(healthy)).status).toBe('discovering');
  });

  it('gives up after repeated interruptions', async () => {
    const id = await queueJob();
    await pool.query(
      `UPDATE crawl_jobs SET status = 'crawling', worker_id = 'w-x', attempts = $2, heartbeat_at = now() - interval '5 minutes' WHERE id = $1`,
      [id, MAX_ATTEMPTS]);
    await reapStale();
    expect((await job(id)).status).toBe('failed');
    expect((await job(id)).error).toMatch(/interrupted/);
  });

  it('stores the result for the owning worker', async () => {
    await queueJob();
    const claimed = (await claim('w-owner', clientId))!;
    await runJob(claimed, 'w-owner', noLog, fakeCrawl);
    expect((await job(claimed.id)).status).toBe('done');
    const { rows } = await pool.query('SELECT url FROM pages WHERE client_id = $1', [clientId]);
    expect(rows.map((r) => r.url)).toEqual([`https://w.test/blog/${tag}/`]);
  });

  it('discards the result of a worker that lost the job to another worker', async () => {
    await pool.query('DELETE FROM pages WHERE client_id = $1', [clientId]);
    await queueJob();
    const claimed = (await claim('w-slow', clientId))!;
    await pool.query(`UPDATE crawl_jobs SET worker_id = 'w-other' WHERE id = $1`, [claimed.id]);
    await runJob(claimed, 'w-slow', noLog, fakeCrawl);
    expect((await job(claimed.id)).status).toBe('discovering');
    const { rows } = await pool.query('SELECT 1 FROM pages WHERE client_id = $1', [clientId]);
    expect(rows).toHaveLength(0);
  });
});
