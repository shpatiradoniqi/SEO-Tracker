import { pool, tx } from '../../db/pool.js';
import type { RankProvider, SerpResult } from './serpapi.js';

/** Compares URLs the way a results page should: ignores scheme, "www.", trailing slash, query and fragment. */
export function urlKey(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return raw;
  }
}

export interface RefreshOptions { clientId?: string; limit?: number; now?: Date; log?: (msg: string) => void }
export interface RefreshResult { queries: number; ranked: number; notRanked: number }

interface Target { page_keyword_id: number; term: string; url: string }

/**
 * Captures the current real position for every tracked (page, keyword) pair, or one client's.
 * Each distinct keyword is searched once; a pair is ranked when its page's URL appears in the
 * results. Ranked pairs get a snapshot; pairs outside the top 100 get no snapshot and their
 * latest position is cleared, so the UI shows "no data" instead of a stale number.
 * All searches run first; the writes then happen in one short transaction.
 */
export async function refreshRanks(provider: RankProvider, opts: RefreshOptions = {}): Promise<RefreshResult> {
  const { clientId, limit, now = new Date(), log = () => {} } = opts;
  const { rows: targets } = await pool.query<Target>(
    `SELECT pk.id AS page_keyword_id, k.term, p.url
     FROM page_keywords pk
     JOIN keywords k ON k.id = pk.keyword_id
     JOIN pages p ON p.id = pk.page_id
     WHERE ($1::uuid IS NULL OR p.client_id = $1)
     ORDER BY k.term, pk.id`,
    [clientId ?? null],
  );
  const terms = [...new Set(targets.map((t) => t.term))].slice(0, limit ?? Infinity);

  const results = new Map<string, SerpResult[]>();
  for (const [i, term] of terms.entries()) {
    results.set(term, await provider.search(term));
    log(`  [${i + 1}/${terms.length}] ${term}`);
  }

  const ranked: Array<{ id: number; position: number }> = [];
  const notRanked: number[] = [];
  for (const t of targets) {
    const serp = results.get(t.term);
    if (!serp) continue; // beyond --limit
    const hit = serp.find((r) => urlKey(r.url) === urlKey(t.url));
    if (hit && hit.position >= 1 && hit.position <= 100) ranked.push({ id: t.page_keyword_id, position: hit.position });
    else notRanked.push(t.page_keyword_id);
  }

  await tx(async (db) => {
    await db.query('SELECT ensure_rank_snapshot_partitions($1, $1)', [now]);
    if (ranked.length) {
      await db.query(
        `INSERT INTO rank_snapshots(page_keyword_id, captured_at, position)
         SELECT unnest($1::int[]), $2, unnest($3::smallint[])
         ON CONFLICT (page_keyword_id, captured_at) DO UPDATE SET position = EXCLUDED.position`,
        [ranked.map((r) => r.id), now, ranked.map((r) => r.position)],
      );
      await db.query(
        `UPDATE page_keywords pk SET latest_position = r.position, latest_captured_at = $3
         FROM unnest($1::int[], $2::smallint[]) AS r(id, position) WHERE pk.id = r.id`,
        [ranked.map((r) => r.id), ranked.map((r) => r.position), now],
      );
    }
    if (notRanked.length) {
      await db.query('UPDATE page_keywords SET latest_position = NULL, latest_captured_at = $2 WHERE id = ANY($1)', [notRanked, now]);
    }
    const touched = [...ranked.map((r) => r.id), ...notRanked];
    if (touched.length) {
      await db.query(
        `SELECT refresh_rank_daily(($2::timestamptz AT TIME ZONE 'America/Toronto')::date,
                                   ($2::timestamptz AT TIME ZONE 'America/Toronto')::date, $1)`,
        [touched, now],
      );
    }
  });
  return { queries: terms.length, ranked: ranked.length, notRanked: notRanked.length };
}
