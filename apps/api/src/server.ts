import { buildApp } from './app.js';
import { startWorker } from './worker.js';
import { pool } from './db/pool.js';

const port = Number(process.env.API_PORT ?? 3001);
const app = await buildApp({ logger: true });
// The crawl worker runs in the API process for simplicity; in production it would be its own deployment.
const stopWorker = startWorker((msg) => app.log.info(msg));

await app.listen({ port, host: '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopWorker();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
