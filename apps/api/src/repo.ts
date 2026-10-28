import { pool } from './db/pool.js';

/**
 * Every read and write that touches client data lives here and takes the signed-in user's id.
 * Ownership is enforced in SQL (clients.user_id = $userId), so a guessed or edited id simply
 * matches no rows and the route answers 404, the same as for an id that does not exist.
 */

export const TIMEZONE = 'America/Toronto';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listClients(userId: string) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.website_url AS "websiteUrl", c.created_at AS "createdAt",
            (SELECT count(*)::int FROM pages p WHERE p.client_id = c.id) AS "pageCount",
            j.id AS "jobId", j.status AS "jobStatus", j.error AS "jobError"
     FROM clients c
     LEFT JOIN LATERAL (
       SELECT id, status, error FROM crawl_jobs WHERE client_id = c.id ORDER BY created_at DESC LIMIT 1
     ) j ON true
     WHERE c.user_id = $1
     ORDER BY c.name`,
    [userId],
  );
  return rows;
}

export interface PageListQuery { clientId?: string; q?: string; page: number; pageSize: number }

export async function listPages(userId: string, { clientId, q, page, pageSize }: PageListQuery) {
  const pattern = q ? `%${escapeLike(q)}%` : null;
  const { rows } = await pool.query(
    `WITH filtered AS (
       SELECT p.id, p.url, p.title, p.sitemap_position, c.id AS client_id, c.name AS client_name
       FROM pages p
       JOIN clients c ON c.id = p.client_id
       WHERE c.user_id = $1
         AND ($2::uuid IS NULL OR c.id = $2)
         AND ($3::text IS NULL
              OR p.url ILIKE $3
              OR EXISTS (SELECT 1 FROM page_keywords pk JOIN keywords k ON k.id = pk.keyword_id
                         WHERE pk.page_id = p.id AND k.term ILIKE $3))
     ),
     counted AS (SELECT *, count(*) OVER () AS total FROM filtered)
     SELECT f.id, f.url, f.title, f.client_id AS "clientId", f.client_name AS "clientName", f.total::int AS total,
            (SELECT count(*)::int FROM seo_issues i WHERE i.page_id = f.id) AS "issueCount",
            kw.keywords, kw.best_position AS "bestPosition", kw.captured_at AS "positionDate"
     FROM counted f
     LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object('term', k.term, 'position', pk.latest_position) ORDER BY pk.rank_order) AS keywords,
              min(pk.latest_position) AS best_position,
              max(pk.latest_captured_at) AS captured_at
       FROM page_keywords pk JOIN keywords k ON k.id = pk.keyword_id
       WHERE pk.page_id = f.id
     ) kw ON true
     ORDER BY f.client_name, f.sitemap_position
     LIMIT $4 OFFSET $5`,
    [userId, clientId ?? null, pattern, pageSize, (page - 1) * pageSize],
  );
  const total = rows[0]?.total ?? (page > 1 ? await countPages(userId, clientId, pattern) : 0);
  return { items: rows.map(({ total: _t, ...r }) => ({ ...r, keywords: r.keywords ?? [] })), total, page, pageSize };
}

async function countPages(userId: string, clientId: string | undefined, pattern: string | null): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages p JOIN clients c ON c.id = p.client_id
     WHERE c.user_id = $1 AND ($2::uuid IS NULL OR c.id = $2)
       AND ($3::text IS NULL OR p.url ILIKE $3 OR EXISTS (SELECT 1 FROM page_keywords pk JOIN keywords k
            ON k.id = pk.keyword_id WHERE pk.page_id = p.id AND k.term ILIKE $3))`,
    [userId, clientId ?? null, pattern],
  );
  return rows[0]!.n;
}

export async function getPage(userId: string, pageId: string) {
  const { rows: [page] } = await pool.query(
    `SELECT p.id, p.url, p.title, p.meta_description AS "metaDescription", p.h1, p.word_count AS "wordCount",
            p.status_code AS "statusCode", p.crawled_at AS "crawledAt",
            c.id AS "clientId", c.name AS "clientName"
     FROM pages p JOIN clients c ON c.id = p.client_id
     WHERE p.id = $1 AND c.user_id = $2`,
    [pageId, userId],
  );
  if (!page) return null;
  const [{ rows: keywords }, { rows: issues }] = await Promise.all([
    pool.query(
      `SELECT pk.id, k.term, pk.score, pk.latest_position AS "latestPosition", pk.latest_captured_at AS "latestCapturedAt"
       FROM page_keywords pk JOIN keywords k ON k.id = pk.keyword_id
       WHERE pk.page_id = $1 ORDER BY pk.rank_order`, [pageId]),
    pool.query(
      `SELECT id, code, severity, message, details FROM seo_issues WHERE page_id = $1
       ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, code`, [pageId]),
  ]);
  return { ...page, keywords, issues };
}

/** Ranges longer than this read the daily rollup instead of raw snapshots. */
export const ROLLUP_AFTER_DAYS = 92;

/**
 * Daily positions for one page between two Toronto calendar dates (inclusive).
 * Short ranges read raw snapshots: bounds are converted from Toronto midnight to UTC in SQL (so DST
 * is handled by Postgres), rows are grouped by Toronto date, and the day's latest snapshot wins.
 * Long ranges read rank_daily, which holds exactly that per day already, so the cost doesn't
 * depend on how many raw captures each day has. Both return the same points.
 */
export async function getHistory(userId: string, pageId: string, from: string, to: string) {
  const { rows: owned } = await pool.query(
    'SELECT 1 FROM pages p JOIN clients c ON c.id = p.client_id WHERE p.id = $1 AND c.user_id = $2', [pageId, userId]);
  if (!owned.length) return null;
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  const source = days > ROLLUP_AFTER_DAYS ? 'rollup' : 'raw';
  const { rows } = await pool.query<{ keyword_id: number; date: string; position: number }>(
    source === 'rollup'
      ? `SELECT pk.id AS keyword_id, to_char(d.day, 'YYYY-MM-DD') AS date, d.position
         FROM page_keywords pk
         JOIN rank_daily d ON d.page_keyword_id = pk.id
         WHERE pk.page_id = $1 AND d.day BETWEEN $2::date AND $3::date
         ORDER BY pk.id, d.day`
      : `SELECT DISTINCT ON (pk.id, day) pk.id AS keyword_id, to_char(day, 'YYYY-MM-DD') AS date, s.position
         FROM page_keywords pk
         JOIN rank_snapshots s ON s.page_keyword_id = pk.id
         CROSS JOIN LATERAL (SELECT (s.captured_at AT TIME ZONE '${TIMEZONE}')::date AS day) d
         WHERE pk.page_id = $1
           AND s.captured_at >= ($2::date)::timestamp AT TIME ZONE '${TIMEZONE}'
           AND s.captured_at <  ($3::date + 1)::timestamp AT TIME ZONE '${TIMEZONE}'
         ORDER BY pk.id, day, s.captured_at DESC`,
    [pageId, from, to],
  );
  return { from, to, timezone: TIMEZONE, source, points: rows.map((r) => ({ keywordId: r.keyword_id, date: r.date, position: r.position })) };
}

/** Returns null when the user already has a client for this host (unique constraint). */
export async function createClientWithJob(userId: string, name: string, websiteUrl: string, host: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [c] } = await client.query<{ id: string }>(
      `INSERT INTO clients(user_id, name, website_url, normalized_host) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, normalized_host) DO NOTHING RETURNING id`,
      [userId, name, websiteUrl, host],
    );
    if (!c) { await client.query('ROLLBACK'); return null; }
    const { rows: [j] } = await client.query<{ id: string }>(
      'INSERT INTO crawl_jobs(client_id) VALUES ($1) RETURNING id', [c.id]);
    await client.query('COMMIT');
    return { clientId: c.id, jobId: j!.id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getJob(userId: string, jobId: string) {
  const { rows: [job] } = await pool.query(
    `SELECT j.id, j.client_id AS "clientId", c.name AS "clientName", c.website_url AS "websiteUrl", j.status,
            j.pages_found AS "pagesFound", j.pages_done AS "pagesDone", j.sitemap_url AS "sitemapUrl",
            j.error, j.created_at AS "createdAt", j.finished_at AS "finishedAt"
     FROM crawl_jobs j JOIN clients c ON c.id = j.client_id
     WHERE j.id = $1 AND c.user_id = $2`,
    [jobId, userId],
  );
  return job ?? null;
}

/** Queues a new crawl for one of the user's clients unless one is already running. */
export async function requeueCrawl(userId: string, clientId: string) {
  const { rows: [owned] } = await pool.query('SELECT id FROM clients WHERE id = $1 AND user_id = $2', [clientId, userId]);
  if (!owned) return { status: 'not_found' as const };
  const { rows: [job] } = await pool.query<{ id: string }>(
    `INSERT INTO crawl_jobs(client_id)
     SELECT $1 WHERE NOT EXISTS (
       SELECT 1 FROM crawl_jobs WHERE client_id = $1 AND status IN ('queued', 'discovering', 'crawling'))
     RETURNING id`,
    [clientId],
  );
  return job ? { status: 'queued' as const, jobId: job.id } : { status: 'busy' as const };
}

/** Deletes a client and, through ON DELETE CASCADE, its pages, keywords links, issues, snapshots and jobs. */
export async function deleteClient(userId: string, clientId: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM clients WHERE id = $1 AND user_id = $2', [clientId, userId]);
  return (rowCount ?? 0) > 0;
}
