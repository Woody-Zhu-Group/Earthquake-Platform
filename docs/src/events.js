// Global event pool for the world map. Pure functions (no DOM) so Node can test them.
import { indexAtOrBefore } from "./timeline.js";

export const inBbox = (e, [w, s, ea, n]) => e.lon >= w && e.lon <= ea && e.lat >= s && e.lat <= n;

/**
 * One time-sorted list of events for the whole world:
 *  - every event of a region with detector results (tagged with regionId, carries the anomaly measure),
 *  - plus live catalogue events that fall outside all of those regions (no detector runs there).
 */
export function buildGlobalEvents(regions, results, live = []) {
  const covered = regions.filter((r) => results.has(r.id));
  const out = [];
  for (const r of covered) {
    for (const e of results.get(r.id).events) out.push({ ...e, regionId: r.id, place: null });
  }
  for (const e of live) if (!covered.some((r) => inBbox(e, r.bbox))) out.push({ ...e, regionId: null });
  return out.sort((a, b) => a.timeMs - b.timeMs);
}

export const timesOf = (events) => events.map((e) => e.timeMs);

/** Events with start < time <= end. Events of `selectedId` are always kept; the rest need mag >= minMag. */
export function visibleEvents(events, times, startMs, endMs, { minMag = 0, selectedId = null } = {}) {
  const lo = indexAtOrBefore(times, startMs) + 1, hi = indexAtOrBefore(times, endMs);
  if (hi < lo) return [];
  return events.slice(lo, hi + 1).filter((e) => (selectedId && e.regionId === selectedId) || e.mag >= minMag);
}

/** Union of the time ranges of the loaded results, or the last `fallbackDays` days when there are none. */
export function globalRange(results, now = Date.now(), fallbackDays = 365) {
  const rs = [...results.values()];
  if (!rs.length) return { t0: now - fallbackDays * 86_400_000, t1: now };
  return { t0: Math.min(...rs.map((r) => r.t0)), t1: Math.max(...rs.map((r) => r.t1)) };
}
