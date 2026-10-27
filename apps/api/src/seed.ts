import { crawlSite } from '@seo/crawler';
import { pool, tx } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { hashPassword } from './auth/password.js';
import { replaceClientPages } from './services/persist.js';
import { regenerateSnapshots } from './services/snapshots.js';
import { normalizeWebsiteUrl } from '@seo/crawler';

const SEED = [
  { email: 'alice@example.com', client: 'Semrush', website: 'https://www.semrush.com' },
  { email: 'bob@example.com', client: 'Yoast', website: 'https://yoast.com' },
];
export const SEED_PASSWORD = 'password123';

/**
 * Idempotent seed:
 *  1. (Re)creates the two demo users and their clients. Other users and app-added clients are kept.
 *  2. Crawls both sites live with the same pipeline the "Add client" screen uses.
 *  3. Rebuilds rank history for every page/keyword pair in the database, so clients added through
 *     the app get snapshots on the next seed run.
 */
async function main() {
  const started = Date.now();
  await migrate();
  const hash = await hashPassword(SEED_PASSWORD);

  const crawls = await Promise.all(
    SEED.map(async (s) => {
      console.log(`Crawling ${s.website} ...`);
      const result = await crawlSite(s.website);
      console.log(`  ${s.website}: ${result.pages.length} posts from ${result.discovery.sitemapUrl}`);
      return { ...s, result };
    }),
  );

  await tx(async (db) => {
    for (const { email, client, website, result } of crawls) {
      const { rows: [user] } = await db.query<{ id: string }>(
        `INSERT INTO users(email, password_hash) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id`,
        [email, hash],
      );
      const norm = normalizeWebsiteUrl(website)!;
      await db.query('DELETE FROM clients WHERE user_id = $1 AND normalized_host = $2', [user!.id, norm.host]);
      const { rows: [c] } = await db.query<{ id: string }>(
        `INSERT INTO clients(user_id, name, website_url, normalized_host) VALUES ($1, $2, $3, $4) RETURNING id`,
        [user!.id, client, norm.url, norm.host],
      );
      await db.query(
        `INSERT INTO crawl_jobs(client_id, status, pages_found, pages_done, sitemap_url, started_at, finished_at)
         VALUES ($1, 'done', $2, $2, $3, now(), now())`,
        [c!.id, result.pages.length, result.discovery.sitemapUrl],
      );
      await replaceClientPages(db, c!.id, result.pages);
    }
    const t = Date.now();
    const { rows, days } = await regenerateSnapshots(db);
    console.log(`Generated ${rows.toLocaleString()} rank snapshots (${days} days) in ${Date.now() - t}ms`);
    if (rows < 50_000) throw new Error(`Expected at least 50,000 snapshots, got ${rows}`);
  });

  console.log(`Seed finished in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  console.log(`Sign in with ${SEED.map((s) => s.email).join(' or ')} / ${SEED_PASSWORD}`);
}

main()
  .catch((err) => { console.error('Seed failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
