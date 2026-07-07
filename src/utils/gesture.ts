/** Small math helpers shared by the pinch/drag gesture handlers. */

/** Clamp `v` into the inclusive range [lo, hi]. */
export const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** Euclidean distance between the first two active touches (pinch baseline). */
export const touchDist = (touches: { pageX: number; pageY: number }[]) =>
  Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);
