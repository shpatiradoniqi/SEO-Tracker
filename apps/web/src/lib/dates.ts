export const TIMEZONE = 'America/Toronto';

/** Today's calendar date in Toronto as YYYY-MM-DD (en-CA formats dates in ISO order). */
export function torontoToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "Oct 27, 2026" for a YYYY-MM-DD calendar date (no timezone shift: it already is a Toronto date). */
export function formatDay(isoDate: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }) {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
}

/** Formats a UTC timestamp as a Toronto date. */
export function formatTimestamp(ts: string) {
  return new Date(ts).toLocaleDateString('en-US', { timeZone: TIMEZONE, month: 'short', day: 'numeric', year: 'numeric' });
}
