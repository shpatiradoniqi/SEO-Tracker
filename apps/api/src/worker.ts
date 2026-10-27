import { crawlSite, SitemapNotFoundError, NoPostsFoundError, BlockedHostError } from '@seo/crawler';
import { pool, tx } from './db/pool.js';
import { replaceClientPages } from './services/persist.js';

/**
 * Minimal Postgres-backed job queue. Workers claim jobs with FOR UPDATE SKIP LOCKED, so several
 * API processes can run this loop without picking the same job. No Redis to install.
 */

interface ClaimedJob { id: string; client_id: string; website_url: string }

async function claim(): Promise<ClaimedJob | null> {
  const { rows } = await pool.query<ClaimedJob>(
    `UPDATE crawl_jobs j SET status = 'discovering', started_at = now()
     FROM clients c
     WHERE j.id = (SELECT id FROM crawl_jobs WHERE status = 'queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       AND c.id = j.client_id
     RETURNING j.id, j.client_id, c.website_url`,
  );
  return rows[0] ?? null;
}

function friendlyError(err: unknown): string {
  if (err instanceof SitemapNotFoundError) return err.message;
  if (err instanceof NoPostsFoundError) return err.message;
  if (err instanceof BlockedHostError) return 'That address points to a private or reserved network and cannot be crawled.';
  return `Crawl failed: ${err instanceof Error ? err.message : String(err)}`;
}

export async function runJob(job: ClaimedJob, log: (msg: string) => void): Promise<void> {
  try {
    const { discovery, pages } = await crawlSite(job.website_url, {
      onProgress: async (p) => {
        await pool.query(
          `UPDATE crawl_jobs SET status = $2, pages_found = $3, pages_done = $4, sitemap_url = COALESCE($5, sitemap_url)
           WHERE id = $1`,
          [job.id, p.phase, p.found, p.done, p.sitemapUrl ?? null],
        );
      },
    });
    await tx(async (db) => {
      await replaceClientPages(db, job.client_id, pages);
      await db.query(
        `UPDATE crawl_jobs SET status = 'done', pages_done = $2, sitemap_url = $3, finished_at = now() WHERE id = $1`,
        [job.id, pages.length, discovery.sitemapUrl],
      );
    });
    log(`crawl job ${job.id}: ${pages.length} pages from ${discovery.sitemapUrl}`);
  } catch (err) {
    await pool.query(`UPDATE crawl_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
      [job.id, friendlyError(err)]).catch(() => {}); // client may have been deleted mid-crawl
    log(`crawl job ${job.id} failed: ${(err as Error).message}`);
  }
}

export function startWorker(log: (msg: string) => void, { concurrency = 2, pollMs = 1000 } = {}) {
  let running = 0;
  let stopped = false;
  // Jobs interrupted by a restart go back to the queue.
  void pool.query(`UPDATE crawl_jobs SET status = 'queued' WHERE status IN ('discovering', 'crawling')`);
  const timer = setInterval(async () => {
    while (!stopped && running < concurrency) {
      const job = await claim().catch(() => null);
      if (!job) return;
      running++;
      void runJob(job, log).finally(() => { running--; });
    }
  }, pollMs);
  return () => { stopped = true; clearInterval(timer); };
}
