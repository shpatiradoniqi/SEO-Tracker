# Design decisions in detail

The README summarises these; this file has the full reasoning. Query timings are in `perf.md`.

## Crawling

**Sitemap discovery is generic, and tested against the traps in the two seed sites.** It reads `robots.txt`, falls back to common locations, then ranks child sitemaps by blog signals (`post`/`blog` > `article` > `news`), with ties broken by the index's own order. Only same-site sitemaps count: Semrush's index also lists `de.`, `fr.`, `ja.` blogs. Index vs. urlset is detected from the XML root, not the extension, because Semrush serves `/blog/sitemap/`. If nothing looks like a blog, it probes `/blog/sitemap_index.xml` and similar (Ahrefs keeps its blog sitemap there, unlinked), then filters by blog-like paths. URLs are fetched in sitemap order, and a URL only counts as a post if its JSON-LD says Article/BlogPosting: Yoast's and Backlinko's first sitemap entry is the blog index page, and both mark it `og:type=article`. Unit tests reproduce the Semrush, Yoast and Ahrefs layouts offline.

**Politeness.** Each host's `robots.txt` is read once per crawl and applied to every sitemap and page request (RFC 9309: our `SeoTracker` group beats `*`, longest match wins, `Allow` wins ties, `*` and `$` patterns; a missing file allows everything, an unreachable one blocks the crawl until it can be read). Requests are throttled per host: at most 3 in flight and starts at least 250 ms apart, or one at a time `Crawl-delay` seconds apart when the site asks (capped at 60 s, or at `CRAWL_DELAY_MAX_SECONDS`). www.semrush.com asks generic bots for 20 s, which is why the full seed takes minutes. If robots.txt is why nothing could be crawled, the job fails with that reason.

**SSRF guard.** The server fetches URLs that users type in, so every request and redirect hop is checked against private, loopback, link-local/metadata, CGNAT and reserved ranges. The check runs inside the socket's own DNS lookup (a custom undici agent): the address that was vetted is the address that gets connected to, so a DNS-rebinding host can't pass the check with a public answer and then connect to `127.0.0.1`. Tested with a local server and a scripted resolver.

## Keywords and issues

**Keywords: weighted fields, site-level IDF, strict phrase rules.** Candidates are 1–3-word phrases from the title, H1, URL slug, meta description, H2s and body, weighted in that order. Phrases containing stopwords are dropped ("segments in google" is a fragment, not a query). Brand and author names are excluded. Single words must be in the title, H1 and slug together. IDF across the client's 15 pages pushes down words the whole site uses. Overlapping and plural variants are de-duplicated. The top 6 per page are kept. This is a heuristic with no search-volume data, so it finds topics, not proven ranking terms.

**Optional LLM re-rank.** With `KEYWORD_RERANK=claude` (and an Anthropic API key), the heuristic proposes its top 12 per page and one Claude request per crawl (`claude-opus-5-5` by default, low effort, structured JSON output validated with Zod) picks and orders the final 6. Claude can only choose from the candidates: invented or duplicate phrases are dropped and the list is topped up from the heuristic order. Any error, refusal or unparseable answer falls back to the heuristic's top 6, so crawls never fail because of it. Off by default.

**SEO issues.** 15 on-page checks with a severity each (title/meta length, missing or multiple H1, skipped heading levels, missing alt text, canonical missing or pointing elsewhere, noindex, thin content, missing `lang`/Open Graph), plus duplicate titles across a client's pages. Both seed sites are SEO companies, so they have few issues.

## Data

**Schema** (`db/migrations/`):
- `rank_snapshots(page_keyword_id, captured_at, position)` uses the pair as its primary key, which is also the only index the history query needs.
- Keywords are a shared vocabulary; `page_keywords` links them to pages with a score and rank order.
- The latest position is denormalized onto `page_keywords`, so the pages list never reads the snapshots table. Its cost depends on pages per user, not on history size.
- Search uses `pg_trgm` GIN indexes on page URLs and keyword terms.
- `rank_snapshots` is partitioned by month on `captured_at` (migration 004), so old months can be detached or archived cheaply. Writers create the partitions they need first; a default partition catches stragglers and stays empty.
- `rank_daily` is a rollup: one row per keyword per Toronto day (last, best and worst position). History ranges over 92 days read it, so long charts don't read or de-duplicate raw captures. Shorter ranges read raw snapshots. Both paths return the same points (tested).

**Seed.** Deterministic random walks (same history on every run). Rows are bulk-inserted with `unnest()`; 60k+ rows take about two seconds including the rollup. The history length grows automatically if a smaller site would fall under 50,000 rows. Re-running rebuilds the two demo users and regenerates snapshots for every page in the database, which is how clients added in the app get positions "when the seed runs again".

**Time zones.** Snapshots are stored as `timestamptz` in UTC at 06:00, which is the same calendar day in Toronto all year. The history API takes Toronto dates, converts the range bounds in SQL (`::timestamp AT TIME ZONE 'America/Toronto'`, so DST is handled by Postgres), and groups by Toronto date. A test checks that 03:30 UTC on Jan 15 is reported as Jan 14.

**Real rank data (optional, outside the brief).** The brief says positions are invented, and by default they are. As an opt-in extension, `npm run ranks:refresh` captures current Google positions from SerpApi (`SERPAPI_KEY`): one search per distinct keyword (100 results), matched to each page by URL (ignoring scheme, `www.`, trailing slash and query). Matches get a snapshot and become the latest position; pages outside the top 100 have their latest position cleared. All searches run before a single short write transaction, which also refreshes the rollup. `--dry-run`, `--limit N` and `--client <id>` control cost. `npm run seed` replaces real snapshots with simulated ones.

## Security and tenancy

**Tenancy.** Every data query lives in `apps/api/src/repo.ts` and filters on `clients.user_id`. An id belonging to someone else matches no rows and returns 404, the same as a missing id, so the API doesn't reveal that it exists. Integration and browser tests try User B's ids as User A through every route.

**Sessions.** An httpOnly, SameSite=Lax cookie holding a random token. The database stores only its SHA-256 hash, so a database leak can't hijack sessions. Passwords use scrypt from `node:crypto`, chosen over argon2 so there is no native build step on Windows. Login time doesn't reveal whether an email exists.

**Login rate limiting.** Failed sign-ins are counted in Postgres (shared by every API process) per email (5 per 15 minutes) and per IP (50 per 15 minutes). A locked-out request gets `429` with `Retry-After`, and the lock is checked before the password, so it reveals nothing. A successful sign-in clears the account's counter. Behind a reverse proxy, set `TRUST_PROXY=true` so the real client IP is used.

**CSRF.** Every state-changing request with a session cookie must send `X-CSRF-Token`, an HMAC of the session token keyed by `SESSION_SECRET`. The app gets it from the login and `/auth/me` responses and keeps it in memory. Another site can make the browser send the cookie but can't read the token. Login itself is exempt (no session yet, JSON-only body).

## Adding a client and the worker

The URL is validated and normalized, so `www.Yoast.com/` and `yoast.com` are the same site. A unique `(user_id, normalized_host)` constraint blocks duplicates. The API returns `202` and queues a job in `crawl_jobs`. A separate worker service (`apps/api/src/worker-main.ts`) claims jobs with `FOR UPDATE SKIP LOCKED` (a Postgres queue, so no Redis) and records progress, which the UI polls. Any number of workers can run. Each running job records its owner and a heartbeat every 10 s; if a worker dies, another one re-queues its jobs after 60 s (up to 3 attempts), and a worker that lost a job can't overwrite the new result. On shutdown a worker finishes or hands back its running jobs. Failures are stored as readable messages ("no sitemap found, tried …", "robots.txt doesn't allow …", "the site refused the crawler (HTTP 403 …)" for bot protection such as Cloudflare, kept apart from a plain 404), and the client can be retried or removed.

## Frontend

React + Vite + TanStack Query + Tailwind + Recharts.
- The colors borrow from a search results page: blue titles, green URLs. Positions are colored by the results page they would land on.
- The chart's Y axis is reversed so position 1 is at the top, with a dashed line marking the end of page 1.
- Filters, search and the page number live in the URL, so they survive a refresh.
- Light and dark modes are supported, and the list stacks on phones.
- The chart library loads only with the detail route.
