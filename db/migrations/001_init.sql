-- Core schema for the SEO keyword tracker.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  password_hash text   NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id         text PRIMARY KEY,               -- SHA-256 of the cookie token, never the token itself
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);

CREATE TABLE clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  website_url     text NOT NULL,
  normalized_host text NOT NULL,             -- lowercased, no "www.", used for duplicate detection
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, normalized_host)
);

CREATE TYPE crawl_status AS ENUM ('queued', 'discovering', 'crawling', 'done', 'failed');

CREATE TABLE crawl_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  status      crawl_status NOT NULL DEFAULT 'queued',
  pages_found int NOT NULL DEFAULT 0,
  pages_done  int NOT NULL DEFAULT 0,
  sitemap_url text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);
CREATE INDEX crawl_jobs_client_id_idx ON crawl_jobs(client_id);
-- Worker claims the oldest queued job; partial index keeps this tiny.
CREATE INDEX crawl_jobs_queued_idx ON crawl_jobs(created_at) WHERE status = 'queued';

CREATE TABLE pages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  url              text NOT NULL,
  sitemap_position smallint NOT NULL,        -- order the sitemap listed it in
  title            text,
  meta_description text,
  h1               text,
  status_code      smallint NOT NULL,
  word_count       int NOT NULL DEFAULT 0,
  crawled_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, url)
);
CREATE INDEX pages_client_order_idx ON pages(client_id, sitemap_position);
CREATE INDEX pages_url_trgm_idx ON pages USING gin (url gin_trgm_ops);

CREATE TABLE keywords (
  id   serial PRIMARY KEY,
  term text NOT NULL UNIQUE                  -- lowercased, whitespace-collapsed
);
CREATE INDEX keywords_term_trgm_idx ON keywords USING gin (term gin_trgm_ops);

CREATE TABLE page_keywords (
  id                 serial PRIMARY KEY,
  page_id            uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  keyword_id         int  NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  score              real NOT NULL,
  rank_order         smallint NOT NULL,      -- 1 = strongest candidate for the page
  -- Denormalized from rank_snapshots so the pages list never touches the big table.
  latest_position    smallint,
  latest_captured_at timestamptz,
  UNIQUE (page_id, keyword_id)
);
CREATE INDEX page_keywords_keyword_id_idx ON page_keywords(keyword_id);

CREATE TYPE issue_severity AS ENUM ('high', 'medium', 'low');

CREATE TABLE seo_issues (
  id       serial PRIMARY KEY,
  page_id  uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  code     text NOT NULL,
  severity issue_severity NOT NULL,
  message  text NOT NULL,
  details  jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX seo_issues_page_id_idx ON seo_issues(page_id);

-- One row per (page, keyword, day). The PK doubles as the only index needed:
-- history = range scan, latest = backward scan with LIMIT 1.
CREATE TABLE rank_snapshots (
  page_keyword_id int NOT NULL REFERENCES page_keywords(id) ON DELETE CASCADE,
  captured_at     timestamptz NOT NULL,
  position        smallint NOT NULL CHECK (position BETWEEN 1 AND 100),
  PRIMARY KEY (page_keyword_id, captured_at)
);
