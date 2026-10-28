# SEO Keyword Tracker

Crawls a client's blog, works out which keywords each post is likely to rank for and which SEO issues it has, and shows (invented) daily positions over time. Fastify + PostgreSQL + React.

## How to run

Needs Node 20.12+ and Docker. From a clean clone:

```bash
cp .env.example .env            # Windows PowerShell: copy .env.example .env
docker compose up -d --wait     # PostgreSQL 16 on localhost:5432
npm install
npm run db:migrate
npm run seed                    # live-crawls semrush.com and yoast.com, ~1 min; prints the snapshot count
npm run dev                     # API on :3001, crawl worker, app on http://localhost:5173
```

In production the crawl worker runs as its own service: `npm run worker` (start as many copies as you like).

If port 5432 is already in use (for example by a local PostgreSQL install), set `DB_PORT=5433` in `.env`, use the same port in `DATABASE_URL`, and run `docker compose up -d --wait` again.

Sign in as `alice@example.com` (Semrush) or `bob@example.com` (Yoast), password `password123`.
`npm test` runs the crawler unit tests and the API integration tests (the API tests need the database running).

## Decisions and why

**Sitemap discovery is generic, and tested against the traps in the two seed sites.** It reads `robots.txt`, falls back to common locations, then ranks child sitemaps by blog signals (`post`/`blog` > `article` > `news`), with ties broken by the index's own order. Only same-site sitemaps count: Semrush's index also lists `de.`, `fr.`, `ja.` blogs. Index vs. urlset is detected from the XML root, not the extension, because Semrush serves `/blog/sitemap/`. If nothing looks like a blog, it probes `/blog/sitemap_index.xml` and similar (Ahrefs keeps its blog sitemap there, unlinked), then filters by blog-like paths. URLs are fetched in sitemap order, and a URL only counts as a post if its JSON-LD says Article/BlogPosting. Yoast's and Backlinko's first sitemap entry is the blog index page, and both mark it `og:type=article`. Unit tests reproduce the Semrush, Yoast and Ahrefs layouts offline.

**Keywords: weighted fields, site-level IDF, strict phrase rules.** Candidates are 1–3-word phrases from the title, H1, URL slug, meta description, H2s and body, weighted in that order. Phrases containing stopwords are dropped ("segments in google" is a fragment, not a query). Brand and author names are excluded. Single words must be in the title, H1 and slug together. IDF across the client's 15 pages pushes down words the whole site uses. Overlapping and plural variants are de-duplicated. The top 6 per page are kept. This is a heuristic with no search-volume data, so it finds topics, not proven ranking terms.

**SEO issues:** 15 on-page checks with a severity each (title/meta length, missing or multiple H1, skipped heading levels, missing alt text, canonical missing or pointing elsewhere, noindex, thin content, missing `lang`/Open Graph), plus duplicate titles across a client's pages. Both seed sites are SEO companies, so they have few issues.

**Schema:** see `db/migrations/001_init.sql`.
- `rank_snapshots(page_keyword_id, captured_at, position)` uses the pair as its primary key, which is also the only index the history query needs.
- Keywords are a shared vocabulary; `page_keywords` links them to pages with a score.
- The latest position is denormalized onto `page_keywords` by the seed, so the pages list never reads the snapshots table. Its cost depends on pages per user, not on history size.
- Search uses `pg_trgm` indexes.
- Measured: every endpoint answers in 3–15 ms with the seed loaded (`docs/perf.md`).

**Seed:** deterministic random walks (same history on every run). Rows are bulk-inserted with `unnest()`; 60k+ rows take under a second. The history length grows automatically if a smaller site would fall under 50,000 rows. Re-running rebuilds the two demo users and regenerates snapshots for every page in the database, which is how clients added in the app get positions "when the seed runs again".

**Time zones:** snapshots are stored as `timestamptz` in UTC at 06:00, which is the same calendar day in Toronto all year. The history API takes Toronto dates, converts the range bounds in SQL (`::timestamp AT TIME ZONE 'America/Toronto'`, so DST is handled by Postgres), and groups by Toronto date. A test checks that 03:30 UTC on Jan 15 is reported as Jan 14.

**Tenancy:** every data query lives in `apps/api/src/repo.ts` and filters on `clients.user_id`. An id belonging to someone else matches no rows and returns 404, the same as a missing id, so the API doesn't reveal that it exists. Integration tests try User B's page, history, job and client ids as User A, through every route.

**Auth:** an httpOnly cookie holding a random token. The database stores only its SHA-256 hash, so a database leak can't hijack sessions. Passwords use scrypt from `node:crypto`, chosen over argon2 so there is no native build step on Windows. Login time doesn't reveal whether an email exists.

**Adding a client:** the URL is validated and normalized, so `www.Yoast.com/` and `yoast.com` are the same site. A unique `(user_id, host)` constraint blocks duplicates. The API returns `202` and queues a job in `crawl_jobs`. A separate worker service (`apps/api/src/worker-main.ts`) claims jobs with `FOR UPDATE SKIP LOCKED` (a Postgres queue, so no Redis) and records progress, which the UI polls. Any number of workers can run. Each running job records its owner and a heartbeat every 10 s; if a worker dies, another one re-queues its jobs after 60 s (up to 3 attempts), and a worker that lost a job can't overwrite the new result. On shutdown a worker finishes or hands back its running jobs. Failures are stored as readable messages, and the client can be retried or removed. Because the server fetches URLs that users type in, every request and redirect hop is checked against private, loopback and metadata IP ranges (SSRF guard).

**Frontend:** React + Vite + TanStack Query + Tailwind + Recharts.
- The colors borrow from a search results page: blue titles, green URLs. Positions are colored by the results page they would land on.
- The chart's Y axis is reversed so position 1 is at the top, with a dashed line marking the end of page 1.
- Filters, search and the page number live in the URL, so they survive a refresh.
- Light and dark modes are supported, and the list stacks on phones.

## Unfinished / next steps

- **Missing protections:** no login rate limiting and no CSRF token. SameSite=Lax cookies and JSON-only endpoints cover the common cases, but I'd add both.
- **SSRF guard:** checks DNS before connecting, which leaves a small DNS-rebinding window. Pinning the resolved IP in a custom HTTP agent would close it.
- **Crawling politeness:** the crawler doesn't read `robots.txt` crawl rules or per-host rate limits beyond a concurrency of 3.
- **Keyword quality:** an LLM pass that re-ranks the heuristic candidates, with JSON output and the heuristic as fallback, would improve results. Real rank data would come from a SERP API.
- **Scale:** at tens of millions of snapshots, partition `rank_snapshots` by month and add a daily rollup for long ranges.
- **Tests:** no end-to-end browser tests yet. Screens were checked manually with headless-browser screenshots.

## AI tools used

Claude (claude.ai, Claude Opus 5.5): analysed the brief, planned the architecture, and wrote most of the code and tests phase by phase, including live checks of the seed sites' sitemaps and screenshot reviews of the UI. I reviewed each phase, made the design calls, and verified the run instructions on a clean clone.
