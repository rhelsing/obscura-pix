/** Formatting helpers shared across screens. */

/**
 * Compact relative time: `now`, `5m`, `3h`, `2d`. Single source of truth for
 * the chat list, story headers, and anywhere else that shows "time since".
 */
export function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return 'now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}
