import { createClaudeReranker, DEFAULT_RERANK_MODEL, type crawlSite } from '@seo/crawler';

type CrawlOptions = NonNullable<Parameters<typeof crawlSite>[1]>;

/** Operator settings for crawls run by the worker and the seed, read from the environment. */
export function crawlOptionsFromEnv(env = process.env, log: (msg: string) => void = console.warn): CrawlOptions {
  const options: CrawlOptions = {};
  const cap = Number(env.CRAWL_DELAY_MAX_SECONDS);
  if (env.CRAWL_DELAY_MAX_SECONDS && Number.isFinite(cap) && cap >= 0) options.maxCrawlDelaySeconds = cap;
  // KEYWORD_RERANK=claude turns on the LLM keyword pass; credentials come from the Anthropic SDK's usual sources.
  if (env.KEYWORD_RERANK === 'claude') {
    options.reranker = createClaudeReranker({ model: env.ANTHROPIC_MODEL || DEFAULT_RERANK_MODEL });
    options.onRerankError = (err) => log(`Keyword re-ranking failed, using heuristic keywords: ${(err as Error).message}`);
  }
  return options;
}
