const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 86400e3],
  ['month', 30 * 86400e3],
  ['day', 86400e3],
  ['hour', 3600e3],
  ['minute', 60e3],
];

/** "3 days ago", "just now". */
export function ago(ms: number, now = Date.now()): string {
  const diff = now - ms;
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of units) if (diff >= size) return rtf.format(-Math.floor(diff / size), unit);
  return 'just now';
}

export const pct = (r: number | null) => (r === null ? '–' : `${(r * 100).toFixed(r < 0.01 && r > 0 ? 2 : 1)}%`);
export const num = (n: number) => n.toLocaleString('en');
