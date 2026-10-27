/** Position styled by the results page it would appear on. */
export function rankBand(position: number | null) {
  if (position == null) return { label: 'No data yet', color: 'text-muted', ring: 'border-line' };
  if (position <= 3) return { label: 'Top 3', color: 'text-top3', ring: 'border-top3' };
  if (position <= 10) return { label: 'Page 1', color: 'text-page1', ring: 'border-page1' };
  if (position <= 20) return { label: 'Page 2', color: 'text-page2', ring: 'border-page2' };
  return { label: 'Page 3+', color: 'text-beyond', ring: 'border-beyond' };
}

export function RankBadge({ position, size = 'md' }: { position: number | null; size?: 'sm' | 'md' | 'lg' }) {
  const band = rankBand(position);
  const box = size === 'lg' ? 'h-14 min-w-14 text-2xl' : size === 'md' ? 'h-9 min-w-9 text-base' : 'h-6 min-w-6 text-xs';
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full border-2 px-1.5 font-bold ${box} ${band.color} ${band.ring}`}
      title={position == null ? 'No rank data yet' : `Position ${position} (${band.label})`}
    >
      {position ?? '–'}
    </span>
  );
}
