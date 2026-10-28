import type { crawlSite } from '@seo/crawler';

type CrawlOptions = NonNullable<Parameters<typeof crawlSite>[1]>;

/** Operator settings for crawls run by the worker and the seed, read from the environment. */
export function crawlOptionsFromEnv(env = process.env): CrawlOptions {
  const options: CrawlOptions = {};
  const cap = Number(env.CRAWL_DELAY_MAX_SECONDS);
  if (env.CRAWL_DELAY_MAX_SECONDS && Number.isFinite(cap) && cap >= 0) options.maxCrawlDelaySeconds = cap;
  return options;
}
