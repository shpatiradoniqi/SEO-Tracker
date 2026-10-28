import type { PoolClient } from 'pg';
import { TIMEZONE } from '../repo.js';

/** Deterministic PRNG so a re-seed produces the same history for the same page_keyword id. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Invented rank history: a bounded random walk per (page, keyword).
 * Starts between 1 and 80, moves -3..+3 most days, jumps up to ±10 on ~3% of days, clamped to 1..100.
 */
export function randomWalk(seed: number, days: number): number[] {
  const rand = mulberry32(seed);
  const out: number[] = [];
  let pos = 1 + Math.floor(rand() * 80);
  for (let d = 0; d < days; d++) {
    const jump = rand() < 0.03;
    const step = jump ? Math.round((rand() - 0.5) * 20) : Math.round((rand() - 0.5) * 6);
    pos = Math.min(100, Math.max(1, pos + step));
    out.push(pos);
  }
  return out;
}

// 06:00 UTC is 01:00 (EST) or 02:00 (EDT) in Toronto, so each snapshot falls on the same calendar day in both.
export const SNAPSHOT_HOUR_UTC = 6;
const MIN_ROWS = 50_000;
const BATCH = 20_000;

/**
 * Rebuilds rank_snapshots for every page_keyword in the database (seeded and app-added clients alike),
 * one row per day ending today. History length is at least `minDays`, and longer if needed to reach 50k rows.
 * Bulk-inserted with unnest() in batches, then latest_position is denormalized onto page_keywords
 * and the daily rollup is rebuilt.
 */
export async function regenerateSnapshots(db: PoolClient, minDays = 365): Promise<{ rows: number; days: number }> {
  const { rows: pks } = await db.query<{ id: number }>('SELECT id FROM page_keywords ORDER BY id');
  await db.query('TRUNCATE rank_snapshots, rank_daily');
  if (pks.length === 0) return { rows: 0, days: 0 };

  const days = Math.max(minDays, Math.ceil(MIN_ROWS / pks.length));
  const DAY = 86_400_000;
  const now = new Date();
  let lastDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SNAPSHOT_HOUR_UTC);
  if (lastDay > now.getTime()) lastDay -= DAY; // never write a snapshot in the future
  const firstDay = lastDay - (days - 1) * DAY;
  // Monthly partitions must exist before rows arrive (rank_snapshots is partitioned by captured_at).
  await db.query('SELECT ensure_rank_snapshot_partitions($1, $2)', [new Date(firstDay), new Date(lastDay)]);

  let ids: number[] = [], times: string[] = [], positions: number[] = [];
  let total = 0;
  const flush = async () => {
    if (!ids.length) return;
    await db.query(
      `INSERT INTO rank_snapshots(page_keyword_id, captured_at, position)
       SELECT unnest($1::int[]), unnest($2::timestamptz[]), unnest($3::smallint[])`,
      [ids, times, positions],
    );
    total += ids.length;
    ids = []; times = []; positions = [];
  };

  for (const { id } of pks) {
    const walk = randomWalk(id, days);
    for (let d = 0; d < days; d++) {
      ids.push(id);
      times.push(new Date(lastDay - (days - 1 - d) * DAY).toISOString());
      positions.push(walk[d]!);
    }
    if (ids.length >= BATCH) await flush();
  }
  await flush();

  await db.query(`
    UPDATE page_keywords pk
    SET latest_position = s.position, latest_captured_at = s.captured_at
    FROM (
      SELECT DISTINCT ON (page_keyword_id) page_keyword_id, position, captured_at
      FROM rank_snapshots ORDER BY page_keyword_id, captured_at DESC
    ) s
    WHERE pk.id = s.page_keyword_id`);
  await db.query(
    `SELECT refresh_rank_daily(($1::timestamptz AT TIME ZONE '${TIMEZONE}')::date, ($2::timestamptz AT TIME ZONE '${TIMEZONE}')::date)`,
    [new Date(firstDay), new Date(lastDay)]);
  await db.query('ANALYZE rank_snapshots, rank_daily');
  return { rows: total, days };
}
