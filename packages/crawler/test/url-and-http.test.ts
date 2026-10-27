import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from '../src/http.js';
import { normalizeWebsiteUrl, isSameSite } from '../src/url.js';

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
