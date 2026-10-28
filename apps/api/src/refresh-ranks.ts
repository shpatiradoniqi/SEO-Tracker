import { parseArgs } from 'node:util';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { refreshRanks } from './services/ranks/refresh.js';
import { serpApiProvider } from './services/ranks/serpapi.js';

/**
 * Captures today's real Google positions from SerpApi (one search per distinct keyword).
 *   npm run ranks:refresh                       all clients
 *   npm run ranks:refresh -- --client <id>      one client
 *   npm run ranks:refresh -- --limit 10         first 10 keywords only (cost control)
 *   npm run ranks:refresh -- --dry-run          count the searches without calling SerpApi
 * Note: `npm run seed` regenerates simulated history and replaces these snapshots.
 */
const { values } = parseArgs({
  options: { client: { type: 'string' }, limit: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
});

async function main() {
  await migrate();
  const limit = values.limit ? Number(values.limit) : undefined;
  if (values['dry-run']) {
    const { rows: [r] } = await pool.query<{ n: number }>(
      `SELECT count(DISTINCT k.term)::int AS n FROM page_keywords pk JOIN keywords k ON k.id = pk.keyword_id
       JOIN pages p ON p.id = pk.page_id WHERE ($1::uuid IS NULL OR p.client_id = $1)`, [values.client ?? null]);
    console.log(`Would run ${Math.min(r!.n, limit ?? Infinity)} SerpApi searches (one per distinct keyword).`);
    return;
  }
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) throw new Error('SERPAPI_KEY is not set. Add your serpapi.com key to .env to capture real positions.');
  const provider = serpApiProvider({ apiKey, gl: process.env.SERP_GL, hl: process.env.SERP_HL, location: process.env.SERP_LOCATION });
  const started = Date.now();
  console.log('Fetching positions from SerpApi ...');
  const result = await refreshRanks(provider, { clientId: values.client, limit, log: console.log });
  console.log(`${result.queries} searches: ${result.ranked} page/keyword pairs ranked in the top 100, ${result.notRanked} not ranked `
    + `(${((Date.now() - started) / 1000).toFixed(1)}s).`);
}

main()
  .catch((err) => { console.error('Rank refresh failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
