/**
 * Per-host politeness: at most `maxConcurrent` requests in flight to one host, and request starts
 * spaced at least `minGapMs` apart. Different hosts don't wait for each other.
 */
export interface HostLimits { minGapMs: number; maxConcurrent: number }

export const DEFAULT_LIMITS: HostLimits = { minGapMs: 250, maxConcurrent: 3 };

interface HostState { active: number; nextStart: number; waiting: Array<() => void> }

export class HostThrottle {
  private hosts = new Map<string, HostState>();
  private limits = new Map<string, HostLimits>();

  constructor(private defaults: HostLimits = DEFAULT_LIMITS, private now = () => Date.now()) {}

  /** Overrides the limits for one host, e.g. from its robots.txt Crawl-delay. */
  setLimits(host: string, limits: Partial<HostLimits>): void {
    this.limits.set(host, { ...this.defaults, ...this.limits.get(host), ...limits });
  }

  limitsFor(host: string): HostLimits {
    return this.limits.get(host) ?? this.defaults;
  }

  async run<T>(url: string, fn: () => Promise<T>): Promise<T> {
    const host = new URL(url).host;
    const state = this.hosts.get(host) ?? this.hosts.set(host, { active: 0, nextStart: 0, waiting: [] }).get(host)!;
    const { minGapMs, maxConcurrent } = this.limitsFor(host);

    while (state.active >= maxConcurrent) await new Promise<void>((resolve) => state.waiting.push(resolve));
    state.active++;
    // Reserve a start slot before sleeping, so concurrent callers queue up behind each other.
    const start = Math.max(this.now(), state.nextStart);
    state.nextStart = start + minGapMs;
    const wait = start - this.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await fn();
    } finally {
      state.active--;
      state.waiting.shift()?.();
    }
  }
}
