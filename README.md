# SEO Keyword Tracker

Crawls a client's blog, works out which keywords each post is likely to rank for and which SEO issues it has, and shows (invented) daily positions over time. Fastify + PostgreSQL + React.

## How to run

Needs Node 20.12+ and Docker. From a clean clone:

```bash
cp .env.example .env            # Windows PowerShell: copy .env.example .env
docker compose up -d --wait     # PostgreSQL 16 on localhost:5432
npm install
npm run db:migrate
npm run seed                    # live-crawls semrush.com and yoast.com; prints the snapshot count
npm run dev                     # API on :3001, crawl worker, app on http://localhost:5173
```

Sign in as `alice@example.com` (Semrush) or `bob@example.com` (Yoast), password `password123`.

- **Seed time:** the crawler honours robots.txt, and www.semrush.com asks bots for a 20-second `Crawl-delay`, so the seed takes ~6–10 minutes (Yoast takes seconds). For a quick demo, set `CRAWL_DELAY_MAX_SECONDS=2` in `.env` first (about a minute).
- **Port 5432 taken** (e.g. a local PostgreSQL)? Set `DB_PORT=5433` in `.env`, use the same port in `DATABASE_URL`, and rerun `docker compose up -d --wait`.
- **Tests:** `npm test` (crawler unit tests + API integration tests, needs the database) and `npm run test:e2e` (Playwright against the seeded app; first time: `npx playwright install chromium`). `npm run typecheck` checks every workspace.
- **Production:** the crawl worker is its own service (`npm run worker`, any number of copies).

## Decisions and why

Full reasoning is in [`docs/decisions.md`](docs/decisions.md); timings in [`docs/perf.md`](docs/perf.md).

- **Generic sitemap discovery.** robots.txt, then common locations; child sitemaps ranked by blog signals; index vs. urlset detected from the XML, not the extension; same-site only (Semrush lists `de.`/`fr.` blogs). A URL counts as a post only if its JSON-LD says Article/BlogPosting. Nothing is site-specific; tests reproduce the Semrush, Yoast and Ahrefs layouts offline.
- **Polite, safe crawling.** robots.txt rules (RFC 9309) and `Crawl-delay` are honoured, with per-host throttling. User-typed URLs are SSRF-checked on every redirect hop, inside the socket's DNS lookup, so DNS rebinding can't reach internal addresses.
- **Keywords** are 1–3-word phrases scored by where they appear (title > H1 > slug > meta > H2 > body), with stopword fragments, brand and author names removed and site-level IDF; top 6 per page. Optional: `KEYWORD_RERANK=claude` lets Claude reorder the top 12 candidates (it can't invent terms; any failure falls back to the heuristic). **SEO issues:** 15 on-page checks with severities, plus duplicate titles across a client.
- **Schema.** Users, clients, pages, keywords (shared vocabulary), `page_keywords` (link + score + denormalized latest position), SEO issues, rank snapshots, crawl jobs. The pages list never touches the snapshots table, so its cost depends on pages per user, not on history size. `rank_snapshots` has `(page_keyword_id, captured_at)` as its primary key, is partitioned by month, and a `rank_daily` rollup serves ranges over 92 days. Every endpoint answers in a few ms with 62k snapshots.
- **Seed:** deterministic random walks, bulk-inserted with `unnest()`. History grows automatically to stay over 50,000 rows. Re-running regenerates snapshots for every page, which is how app-added clients get positions.
- **Time zones:** stored in UTC at 06:00 (same Toronto day all year); the API takes Toronto dates, converts bounds and groups by Toronto day in SQL, so DST is Postgres's job. Tested at the midnight boundary.
- **Tenancy:** every data query is in `apps/api/src/repo.ts` and filters on `clients.user_id`; another user's id gets the same 404 as a missing one. Tested through every route, in the API and the browser.
- **Auth:** httpOnly cookie with a random token; only its SHA-256 is stored. scrypt passwords, constant-time unknown-email path, login rate limiting (per email and per IP, in Postgres) and per-session CSRF tokens.
- **Adding a client:** URL validated and normalized (`www.Yoast.com/` = `yoast.com`), unique per user, `202` + a job in a Postgres queue (`FOR UPDATE SKIP LOCKED`, no Redis). A separate worker crawls with heartbeats, so a crashed worker's jobs are retried. The UI polls progress, and failures ("no sitemap found, tried …") are readable and retryable.
- **Frontend:** React + Vite + TanStack Query + Tailwind + Recharts. Search-results colors, reversed Y axis (position 1 on top) with an "end of page 1" line, filters in the URL, light/dark, stacks on phones.
- **Optional, outside the brief:** positions are invented as asked, but `npm run ranks:refresh` can capture real Google positions from SerpApi if `SERPAPI_KEY` is set. Off by default.

## Unfinished / next steps

- **Real rank data:** `ranks:refresh` isn't scheduled; it would run daily, and the seed would keep real snapshots instead of replacing them.
- **Login lockout abuse:** someone who knows an email can lock its owner out for 15 minutes. Exponential backoff or a CAPTCHA would soften that.
- **Slow sites:** a long `Crawl-delay` makes a crawl take minutes; there's progress but no time estimate or "done" notification.
- **Tests:** e2e runs against the seeded data; it should get an isolated database and run in CI. Live crawls, Claude and SerpApi are covered by unit tests with fakes only.

## AI tools used

Claude (claude.ai, Claude Opus 5.5) analysed the brief, planned the architecture, and wrote most of the code and tests phase by phase, including live checks of the seed sites' sitemaps and screenshot reviews of the UI. I reviewed each phase, made the design calls, and verified the run instructions on a clean clone. Claude Code (Claude Opus 5.5) then implemented the "next steps" list one commit per item (worker service, rate limiting and CSRF, SSRF pinning, robots.txt, Claude re-rank, partitioning, SerpApi, Playwright); I chose the providers and the Crawl-delay policy.
