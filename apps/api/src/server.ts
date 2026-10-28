import { buildApp } from './app.js';
import { pool } from './db/pool.js';

const port = Number(process.env.API_PORT ?? 3001);
const app = await buildApp({ logger: true });
// Crawls run in the separate worker service (src/worker-main.ts); the API only enqueues them.

await app.listen({ port, host: '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
