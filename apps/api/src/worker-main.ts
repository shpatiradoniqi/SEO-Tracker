import { newWorkerId, startWorker } from './worker.js';
import { pool } from './db/pool.js';

/**
 * Standalone crawl worker service. Run as many copies as needed (npm run worker); they share the
 * Postgres queue. The API process only enqueues jobs and never crawls.
 */
const workerId = newWorkerId();
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2);
const log = (msg: string) => console.log(JSON.stringify({ time: new Date().toISOString(), worker: workerId, msg }));

const stop = startWorker(log, { concurrency, workerId });
log(`crawl worker started (concurrency ${concurrency})`);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received, finishing running jobs`);
    await stop();
    await pool.end();
    process.exit(0);
  });
}
