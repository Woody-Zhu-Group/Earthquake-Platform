// Loader and query helpers for detector result documents (see services/change_detection/pipeline.py, version 2).
import { indexAtOrBefore } from "./timeline.js";

export const RESULT_VERSION = 2;

export function validateResult(doc) {
  const fail = (msg) => { throw new Error(`Not a detector result file: ${msg}`); };
  if (!doc || typeof doc !== "object") fail("not a JSON object");
  if (doc.version !== RESULT_VERSION) fail(`version ${doc.version} (expected ${RESULT_VERSION})`);
  if (!doc.region?.id) fail("missing region.id");
  const n = doc.tt_ms?.length;
  if (!n || doc.stat?.length !== n || doc.tau_ms?.length !== n || doc.zone_index?.length !== n) fail("time-grid arrays differ in length");
  const nz = doc.zone_points?.length ?? 0;
  for (const ids of doc.zone_index) for (const i of ids) if (!(i >= 0 && i < nz)) fail("zone_index points outside zone_points");
  const cols = doc.event_columns ?? [];
  if (["time_ms", "lon", "lat", "mag", "measure"].some((c) => !cols.includes(c))) fail("event_columns incomplete");
  for (let k = 1; k < n; k++) if (doc.tt_ms[k] < doc.tt_ms[k - 1]) fail("tt_ms not ascending");
  return doc;
}

export class RegionResult {
  constructor(doc) {
    this.doc = validateResult(doc);
    const c = doc.event_columns;
    const col = Object.fromEntries(c.map((name, i) => [name, i]));
    this.events = doc.events
      .map((e) => ({ timeMs: e[col.time_ms], lon: e[col.lon], lat: e[col.lat], mag: e[col.mag], measure: e[col.measure] }))
      .sort((a, b) => a.timeMs - b.timeMs);
    this.eventTimes = this.events.map((e) => e.timeMs);
    this.t0 = doc.time.monitor_start_ms;
    this.t1 = doc.time.monitor_end_ms;
    this.maxStat = Math.max(0, ...doc.stat);
    this.baselineMs = doc.time.monitor_start_ms - doc.time.baseline_start_ms;
    this.standin = Boolean(doc.meta?.standin);
  }

  /** Detector state at time t: the last grid time <= t (the detector only knows the past). */
  stateAt(tMs) {
    const d = this.doc;
    const i = indexAtOrBefore(d.tt_ms, tMs);
    if (i < 0) return { index: -1, stat: 0, tauMs: null, zone: [] };
    return {
      index: i, stat: d.stat[i], tauMs: d.tau_ms[i],
      zone: d.zone_index[i].map((k) => ({ lon: d.zone_points[k][0], lat: d.zone_points[k][1], w: d.zone_points[k][2] })),
    };
  }

  /** Events with start < time <= end. */
  eventsIn(startMs, endMs) {
    const lo = indexAtOrBefore(this.eventTimes, startMs) + 1;
    const hi = indexAtOrBefore(this.eventTimes, endMs);
    return hi < lo ? [] : this.events.slice(lo, hi + 1);
  }

  /** Long-term ("normal") activity as weighted points: weight = expected events in a window of `windowMs`. */
  baselinePoints(windowMs) {
    const pts = this.doc.baseline_points ?? [];
    if (!pts.length || !(this.baselineMs > 0)) return [];
    const w = (this.doc.meta.n_baseline / pts.length) * (windowMs / this.baselineMs);
    return pts.map(([lon, lat]) => ({ lon, lat, w }));
  }
}
