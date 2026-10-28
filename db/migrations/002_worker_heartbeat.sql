-- The crawl worker runs as its own service, possibly several copies at once.
-- Each running job records which worker owns it and when that worker last checked in,
-- so a crashed worker's jobs can be re-queued without touching jobs other workers are running.
ALTER TABLE crawl_jobs
  ADD COLUMN worker_id    text,
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN attempts     int NOT NULL DEFAULT 0;

CREATE INDEX crawl_jobs_running_idx ON crawl_jobs(heartbeat_at) WHERE status IN ('discovering', 'crawling');
