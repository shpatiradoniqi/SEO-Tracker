import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { gunzipSync } from 'node:zlib';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 SeoTracker/1.0';

export class BlockedHostError extends Error {}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
];

/** True for loopback, private, link-local (incl. cloud metadata), CGNAT, multicast and reserved ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = ipv4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]!);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

/** SSRF guard: every hop of every request must resolve only to public addresses. */
async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedHostError(`Unsupported protocol ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new BlockedHostError(`Blocked host ${host}`);
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new BlockedHostError(`Blocked host ${host} (resolves to a private or reserved address)`);
  }
}

export interface FetchResult {
  url: string; // final URL after redirects
  status: number;
  contentType: string;
  body: string;
}

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  maxBytes?: number;
  accept?: string;
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET with an SSRF guard on every redirect hop, a timeout, a body size cap,
 * transparent .gz handling, and retries with backoff on network errors / 429 / 5xx.
 */
export async function safeFetch(rawUrl: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const { timeoutMs = 15_000, retries = 2, maxBytes = 15 * 1024 * 1024, accept = '*/*' } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    try {
      let url = new URL(rawUrl);
      for (let hop = 0; hop <= 5; hop++) {
        await assertPublicHost(url);
        const res = await fetch(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'user-agent': USER_AGENT, accept, 'accept-language': 'en-US,en;q=0.9' },
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          url = new URL(res.headers.get('location')!, url);
          await res.body?.cancel();
          continue;
        }
        if (res.status === 429 || res.status >= 500) {
          await res.body?.cancel();
          throw new Error(`HTTP ${res.status} for ${url.href}`);
        }
        let buf = await readCapped(res, maxBytes);
        if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf); // raw .gz file (not Content-Encoding)
        return {
          url: url.href,
          status: res.status,
          contentType: res.headers.get('content-type') ?? '',
          body: buf.toString('utf8'),
        };
      }
      throw new Error(`Too many redirects for ${rawUrl}`);
    } catch (err) {
      if (err instanceof BlockedHostError) throw err; // never retry a blocked host
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
