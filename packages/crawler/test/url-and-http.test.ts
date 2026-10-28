import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { BlockedHostError, createGuardedAgent, createGuardedLookup, isPrivateAddress } from '../src/http.js';
import { normalizeWebsiteUrl, isSameSite } from '../src/url.js';

type Answer = Array<{ address: string; family: number }>;
// A resolver that returns a scripted answer per call, like a DNS-rebinding server would.
const scripted = (...answers: Answer[]) => {
  let i = 0;
  return (_host: string, _opts: unknown, cb: (err: null, a: Answer) => void) => cb(null, answers[Math.min(i++, answers.length - 1)]!);
};
const lookupOnce = (lookup: ReturnType<typeof createGuardedLookup>, all: boolean) =>
  new Promise<{ err: Error | null; result: unknown }>((resolve) =>
    lookup('rebind.test', { all }, (err: Error | null, result: unknown) => resolve({ err, result })));

describe('connect-time SSRF guard (DNS pinning)', () => {
  const PUBLIC = { address: '93.184.216.34', family: 4 };
  const LOOPBACK = { address: '127.0.0.1', family: 4 };

  it('hands vetted public addresses to the socket, in both lookup shapes', async () => {
    expect((await lookupOnce(createGuardedLookup(scripted([PUBLIC])), true)).result).toEqual([PUBLIC]);
    expect((await lookupOnce(createGuardedLookup(scripted([PUBLIC])), false)).result).toBe(PUBLIC.address);
  });

  it('checks every connection\'s own lookup, so a second "rebound" answer is refused', async () => {
    const lookup = createGuardedLookup(scripted([PUBLIC], [LOOPBACK]));
    expect((await lookupOnce(lookup, true)).err).toBeNull();
    expect((await lookupOnce(lookup, true)).err).toBeInstanceOf(BlockedHostError);
  });

  it('refuses an answer that mixes public and private addresses', async () => {
    expect((await lookupOnce(createGuardedLookup(scripted([PUBLIC, LOOPBACK])), true)).err).toBeInstanceOf(BlockedHostError);
  });

  it('never opens a connection to a private address through the agent', async () => {
    const server = createServer((_req, res) => res.end('internal secret'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      // Control: the server is reachable without the guard...
      expect(await (await undiciFetch(`http://127.0.0.1:${port}/`)).text()).toBe('internal secret');
      // ...but not through a hostname that resolves to it, even via the guarded agent alone.
      const err = await undiciFetch(`http://rebind.test:${port}/`, { dispatcher: createGuardedAgent(scripted([LOOPBACK])) })
        .then(() => null, (e: Error) => e);
      expect(err?.cause).toBeInstanceOf(BlockedHostError);
    } finally {
      server.close();
    }
  });
});

describe('isPrivateAddress (SSRF guard)', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])(
    'blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(['8.8.8.8', '104.16.0.1', '172.32.0.1', '2606:4700::1111'])('allows %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe('normalizeWebsiteUrl', () => {
  it('normalizes scheme-less input and strips www for the host key', () => {
    expect(normalizeWebsiteUrl('WWW.Yoast.com/blog?x=1')).toEqual({ url: 'https://www.yoast.com', host: 'yoast.com' });
  });
  it.each(['', 'not a url', 'ftp://a.com', 'javascript:alert(1)', 'https://localhost', 'https://user:pw@a.com', 'http://a'])(
    'rejects %j', (raw) => expect(normalizeWebsiteUrl(raw)).toBeNull());
  it('treats www and apex as the same site but not other subdomains', () => {
    expect(isSameSite('https://www.semrush.com/a', 'https://semrush.com')).toBe(true);
    expect(isSameSite('https://de.semrush.com/a', 'https://www.semrush.com')).toBe(false);
  });
});
