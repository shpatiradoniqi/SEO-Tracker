/** Hostname without a leading "www.", lowercased. Used to treat www/apex as one site. */
export function bareHost(input: string | URL): string {
  const host = (typeof input === 'string' ? new URL(input) : input).hostname.toLowerCase();
  return host.startsWith('www.') ? host.slice(4) : host;
}

export function isSameSite(a: string | URL, b: string | URL): boolean {
  try {
    return bareHost(a) === bareHost(b);
  } catch {
    return false;
  }
}

/**
 * Validates and normalizes a user-supplied website URL.
 * Accepts "example.com" (adds https://). Rejects non-http(s), credentials, and hosts without a dot.
 */
export function normalizeWebsiteUrl(raw: string): { url: string; host: string } | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (!isIpv4 && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return { url: `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`, host: bareHost(u) };
}
