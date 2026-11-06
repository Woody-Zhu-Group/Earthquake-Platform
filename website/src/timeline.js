// Time-axis maths for the scrubbable timeline strips. Pure functions.

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Counts of events per bin over [t0, t1]. */
export function histogram(timesMs, t0, t1, bins) {
  const out = new Array(bins).fill(0);
  const span = t1 - t0;
  if (!(span > 0)) return out;
  for (const t of timesMs) {
    if (t < t0 || t > t1) continue;
    out[Math.min(bins - 1, Math.floor(((t - t0) / span) * bins))]++;
  }
  return out;
}

export const xToTime = (x, width, t0, t1) => t0 + clamp(x / width, 0, 1) * (t1 - t0);
export const timeToX = (t, width, t0, t1) => ((t - t0) / (t1 - t0)) * width;

/** Index of the last element <= value in an ascending array, or -1. */
export function indexAtOrBefore(sorted, value) {
  let lo = 0, hi = sorted.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Wheel/trackpad delta -> signed fraction of the full time span to move.
 * Down/right = later. 2000 px of scroll sweeps the whole span; Shift = 5x coarse, Alt = 0.2x fine.
 */
export function wheelToFraction({ deltaX = 0, deltaY = 0, deltaMode = 0, shiftKey = false, altKey = false }) {
  // browsers turn Shift+wheel into horizontal scroll on some platforms: use whichever axis dominates
  let d = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
  if (deltaMode === 1) d *= 16;        // lines -> px
  else if (deltaMode === 2) d *= 400;  // pages -> px
  const gain = (shiftKey ? 5 : 1) * (altKey ? 0.2 : 1);
  return (d / 2000) * gain;
}

/** Move a cursor by a fraction of the span, staying inside [t0, t1]. */
export const scrollCursor = (cursor, fraction, t0, t1) => clamp(cursor + fraction * (t1 - t0), t0, t1);
