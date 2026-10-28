/**
 * Real rank data from Google results via SerpApi (serpapi.com). One search returns up to 100
 * organic results; we only need each result's position and URL.
 */

export interface SerpResult { position: number; url: string }

export interface RankProvider {
  name: string;
  /** Organic results for one query, best first. */
  search(query: string): Promise<SerpResult[]>;
}

export interface SerpApiOptions {
  apiKey: string;
  gl?: string;          // Google country, e.g. "us"
  hl?: string;          // interface language, e.g. "en"
  location?: string;    // optional SerpApi location string, e.g. "Toronto, Ontario, Canada"
  fetchImpl?: typeof fetch;
}

export class SerpApiError extends Error {}

export function serpApiProvider({ apiKey, gl = 'us', hl = 'en', location, fetchImpl = fetch }: SerpApiOptions): RankProvider {
  return {
    name: 'serpapi',
    async search(query) {
      const params = new URLSearchParams({ engine: 'google', q: query, num: '100', gl, hl, api_key: apiKey });
      if (location) params.set('location', location);
      const res = await fetchImpl(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(60_000) });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        organic_results?: Array<{ position?: number; link?: string }>;
      };
      // SerpApi reports "no results" as an error string with HTTP 200; that just means nothing ranks.
      if (data.error && /hasn't returned any results/i.test(data.error)) return [];
      if (!res.ok || data.error) throw new SerpApiError(`SerpApi: ${data.error ?? `HTTP ${res.status}`}`);
      return (data.organic_results ?? [])
        .filter((r): r is { position: number; link: string } => typeof r.position === 'number' && typeof r.link === 'string')
        .map((r) => ({ position: r.position, url: r.link }));
    },
  };
}
