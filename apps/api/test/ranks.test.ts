import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { refreshRanks, urlKey } from '../src/services/ranks/refresh.js';
import { serpApiProvider, SerpApiError, type RankProvider } from '../src/services/ranks/serpapi.js';

// Own throwaway user/client with two pages sharing one keyword; removed afterwards.
const tag = `r${Date.now()}`;
let clientId = '';
const pk: Record<string, number> = {};

beforeAll(async () => {
  await migrate();
  const { rows: [u] } = await pool.query(`INSERT INTO users(email, password_hash) VALUES ($1, 'x') RETURNING id`, [`${tag}@test.dev`]);
  const { rows: [c] } = await pool.query(
    `INSERT INTO clients(user_id, name, website_url, normalized_host) VALUES ($1, 'R', 'https://www.r.test', $2) RETURNING id`, [u.id, `${tag}.test`]);
  clientId = c.id;
  const kw = async (term: string) => (await pool.query(
    `INSERT INTO keywords(term) VALUES ($1) ON CONFLICT (term) DO UPDATE SET term = EXCLUDED.term RETURNING id`, [term])).rows[0].id;
  const shared = await kw(`shared ${tag}`), solo = await kw(`solo ${tag}`);
  for (const [name, url, kwId] of [['a', 'https://www.r.test/blog/a/', shared], ['b', 'https://www.r.test/blog/b/', shared], ['c', 'https://www.r.test/blog/c/', solo]] as const) {
    const { rows: [p] } = await pool.query(
      `INSERT INTO pages(client_id, url, sitemap_position, title, status_code) VALUES ($1, $2, 1, 'T', 200) RETURNING id`, [clientId, url]);
    pk[name] = (await pool.query(
      `INSERT INTO page_keywords(page_id, keyword_id, score, rank_order, latest_position) VALUES ($1, $2, 1, 1, 50) RETURNING id`, [p.id, kwId])).rows[0].id;
  }
});

afterAll(async () => {
  await pool.query('DELETE FROM users WHERE email = $1', [`${tag}@test.dev`]);
  await pool.query('DELETE FROM keywords WHERE term LIKE $1', [`%${tag}`]);
  await pool.end();
});

describe('refreshRanks', () => {
  it('searches each keyword once, records ranked pages and clears unranked ones', async () => {
    const search = vi.fn(async (q: string) => q.startsWith('shared')
      ? [{ position: 3, url: 'https://other.test/x' }, { position: 4, url: 'http://r.test/blog/b' }]   // b ranks, a doesn't
      : [{ position: 12, url: 'https://www.r.test/blog/c/?utm=1' }]);
    const provider: RankProvider = { name: 'fake', search };
    const now = new Date('2026-10-28T14:00:00Z');
    const result = await refreshRanks(provider, { clientId, now });

    expect(search).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ queries: 2, ranked: 2, notRanked: 1 });
    const { rows } = await pool.query(
      `SELECT id, latest_position FROM page_keywords WHERE id = ANY($1) ORDER BY id`, [[pk.a, pk.b, pk.c]]);
    expect(rows.map((r) => r.latest_position)).toEqual([null, 4, 12]);
    const { rows: snaps } = await pool.query(
      `SELECT page_keyword_id, position FROM rank_snapshots WHERE page_keyword_id = ANY($1) ORDER BY page_keyword_id`, [[pk.a, pk.b, pk.c]]);
    expect(snaps.map((s) => [s.page_keyword_id, s.position])).toEqual([[pk.b, 4], [pk.c, 12]]);
    const { rows: daily } = await pool.query(
      `SELECT day::text, position FROM rank_daily WHERE page_keyword_id = $1`, [pk.b]);
    expect(daily).toEqual([{ day: '2026-10-28', position: 4 }]);
  });

  it('respects --limit', async () => {
    const search = vi.fn(async () => []);
    expect((await refreshRanks({ name: 'fake', search }, { clientId, limit: 1 })).queries).toBe(1);
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe('urlKey', () => {
  it('ignores scheme, www, trailing slash, query and fragment', () => {
    expect(urlKey('https://www.Example.com/blog/post/?a=1#x')).toBe(urlKey('http://example.com/blog/post'));
    expect(urlKey('https://example.com/blog/post-2/')).not.toBe(urlKey('https://example.com/blog/post/'));
  });
});

describe('serpApiProvider', () => {
  const respond = (status: number, body: object) => vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status }));

  it('asks for 100 Google results and returns positions and links', async () => {
    const fetchImpl = respond(200, { organic_results: [{ position: 1, link: 'https://a.com/' }, { position: 2 }, { position: 3, link: 'https://b.com/' }] });
    const results = await serpApiProvider({ apiKey: 'k', fetchImpl: fetchImpl as never }).search('seo tips');
    expect(results).toEqual([{ position: 1, url: 'https://a.com/' }, { position: 3, url: 'https://b.com/' }]);
    const url = new URL(fetchImpl.mock.calls[0]![0]);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ engine: 'google', q: 'seo tips', num: '100', gl: 'us', hl: 'en' });
  });

  it('treats "no results" as nothing ranking and other errors as failures', async () => {
    const empty = respond(200, { error: "Google hasn't returned any results for this query." });
    expect(await serpApiProvider({ apiKey: 'k', fetchImpl: empty as never }).search('x')).toEqual([]);
    const bad = respond(401, { error: 'Invalid API key.' });
    await expect(serpApiProvider({ apiKey: 'k', fetchImpl: bad as never }).search('x')).rejects.toThrow(SerpApiError);
  });
});
