import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { crawlSite, SitemapNotFoundError, NoPostsFoundError, BlockedHostError } from '@seo/crawler';
import { pool, tx } from './db/pool.js';
import { replaceClientPages } from './services/persist.js';

/**
 * Postgres-backed job queue, run by the standalone worker service (src/worker-main.ts).
 * Workers claim jobs with FOR UPDATE SKIP LOCKED, so any number of them can run without
 * picking the same job. No Redis to install.
 *
 * Each running job carries its owner (worker_id) and a heartbeat. A job whose heartbeat goes
 * stale (the worker crashed or lost its connection) is re-queued by whichever worker notices,
 * up to MAX_ATTEMPTS. A worker that lost ownership of a job can no longer write its results.
 */

export interface ClaimedJob { id: string; client_id: string; website_url: string }
type Crawl = typeof crawlSite;

const ACTIVE = `('discovering', 'crawling')`;
export const HEARTBEAT_MS = 10_000;
export const STALE_AFTER_MS = 60_000;
export const MAX_ATTEMPTS = 3;

export const newWorkerId = () => `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;

/** Claims the oldest queued job. `clientId` narrows the queue to one client (used by tests). */
export async function claim(workerId: string, clientId?: string): Promise<ClaimedJob | null> {
  const { rows } = await pool.query<ClaimedJob>(
    `UPDATE crawl_jobs j
     SET status = 'discovering', started_at = now(), worker_id = $1, heartbeat_at = now(), attempts = j.attempts + 1
     FROM clients c
     WHERE j.id = (SELECT id FROM crawl_jobs WHERE status = 'queued' AND ($2::uuid IS NULL OR client_id = $2)
                   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       AND c.id = j.client_id
     RETURNING j.id, j.client_id, c.website_url`,
    [workerId, clientId ?? null],
  );
  return rows[0] ?? null;
}

/** Re-queues jobs whose worker stopped checking in; gives up on jobs that keep getting interrupted. */
export async function reapStale(staleAfterMs = STALE_AFTER_MS): Promise<{ requeued: number; failed: number }> {
  const { rows } = await pool.query<{ status: string }>(
    `UPDATE crawl_jobs
     SET status = CASE WHEN attempts >= $2 THEN 'failed'::crawl_status ELSE 'queued'::crawl_status END,
         error = CASE WHEN attempts >= $2 THEN 'Crawl was interrupted too many times. Try again later.' ELSE error END,
         finished_at = CASE WHEN attempts >= $2 THEN now() ELSE NULL END,
         worker_id = NULL, heartbeat_at = NULL
     WHERE status IN ${ACTIVE} AND COALESCE(heartbeat_at, started_at, created_at) < now() - make_interval(secs => $1 / 1000.0)
     RETURNING status`,
    [staleAfterMs, MAX_ATTEMPTS],
  );
  return { requeued: rows.filter((r) => r.status === 'queued').length, failed: rows.filter((r) => r.status === 'failed').length };
}

function friendlyError(err: unknown): string {
  if (err instanceof SitemapNotFoundError) return err.message;
  if (err instanceof NoPostsFoundError) return err.message;
  if (err instanceof BlockedHostError) return 'That address points to a private or reserved network and cannot be crawled.';
  return `Crawl failed: ${err instanceof Error ? err.message : String(err)}`;
}

class LostOwnershipError extends Error {}

export async function runJob(job: ClaimedJob, workerId: string, log: (msg: string) => void, crawl: Crawl = crawlSite): Promise<void> {
  try {
    const { discovery, pages } = await crawl(job.website_url, {
      onProgress: async (p) => {
        await pool.query(
          `UPDATE crawl_jobs SET status = $3, pages_found = $4, pages_done = $5, sitemap_url = COALESCE($6, sitemap_url),
                  heartbeat_at = now()
           WHERE id = $1 AND worker_id = $2`,
          [job.id, workerId, p.phase, p.found, p.done, p.sitemapUrl ?? null],
        );
      },
    });
    await tx(async (db) => {
      // Mark done first: if another worker took the job over, nothing is written.
      const { rowCount } = await db.query(
        `UPDATE crawl_jobs SET status = 'done', pages_done = $3, sitemap_url = $4, finished_at = now(), heartbeat_at = NULL
         WHERE id = $1 AND worker_id = $2 AND status IN ${ACTIVE}`,
        [job.id, workerId, pages.length, discovery.sitemapUrl],
      );
      if (!rowCount) throw new LostOwnershipError();
      await replaceClientPages(db, job.client_id, pages);
    });
    log(`crawl job ${job.id}: ${pages.length} pages from ${discovery.sitemapUrl}`);
  } catch (err) {
    if (err instanceof LostOwnershipError) {
      log(`crawl job ${job.id}: taken over by another worker, result discarded`);
      return;
    }
    await pool.query(
      `UPDATE crawl_jobs SET status = 'failed', error = $3, finished_at = now(), heartbeat_at = NULL
       WHERE id = $1 AND worker_id = $2`,
      [job.id, workerId, friendlyError(err)]).catch(() => {}); // client may have been deleted mid-crawl
    log(`crawl job ${job.id} failed: ${(err as Error).message}`);
  }
}

export interface WorkerOptions { concurrency?: number; pollMs?: number; workerId?: string; crawl?: Crawl }

export function startWorker(log: (msg: string) => void, opts: WorkerOptions = {}) {
  const { concurrency = 2, pollMs = 1000, workerId = newWorkerId(), crawl = crawlSite } = opts;
  const running = new Set<Promise<void>>();
  let stopped = false;
  let polling = false;

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      while (!stopped && running.size < concurrency) {
        const job = await claim(workerId).catch(() => null);
        if (!job) return;
        const p = runJob(job, workerId, log, crawl).finally(() => running.delete(p));
        running.add(p);
      }
    } finally {
      polling = false;
    }
  };

  const pollTimer = setInterval(() => void poll(), pollMs);
  const heartbeatTimer = setInterval(() => {
    void pool.query(`UPDATE crawl_jobs SET heartbeat_at = now() WHERE worker_id = $1 AND status IN ${ACTIVE}`, [workerId])
      .catch(() => {});
    void reapStale()
      .then((r) => { if (r.requeued || r.failed) log(`re-queued ${r.requeued} stale job(s), gave up on ${r.failed}`); })
      .catch(() => {});
  }, HEARTBEAT_MS);
  void reapStale().catch(() => {});

  /** Stops claiming, waits up to `graceMs` for running jobs, then hands unfinished ones back to the queue. */
  return async function stop(graceMs = 20_000): Promise<void> {
    stopped = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    await Promise.race([Promise.allSettled([...running]), new Promise((r) => setTimeout(r, graceMs))]);
    await pool.query(
      `UPDATE crawl_jobs SET status = 'queued', worker_id = NULL, heartbeat_at = NULL WHERE worker_id = $1 AND status IN ${ACTIVE}`,
      [workerId]).catch(() => {});
  };
}
