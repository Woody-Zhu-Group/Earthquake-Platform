// Spatio-temporal CUSUM: a line-for-line port of services/cusum_engine/engine.py.
// Pure functions, no DOM, so Node tests can check parity against the Python output.
//
//   E = 10^(1.5 M)                      energy proxy
//   X_t = summed E per time step        zero-filled between a cell's first and last event
//   mu_0 = mean(X), sigma_0 = sample std (ddof = 1), k = kFactor*sigma_0, h = hFactor*sigma_0
//   S_t = max(0, S_{t-1} + X_t - mu_0 - k),  S_{-1} = 0;  alarm when S_t > h

export const MIN_TIME_BINS = 4;

// Steps must divide 24 h so epoch-aligned bins equal pandas' midnight-anchored bins.
export const TIME_STEPS = { "1D": 86_400_000, "12h": 43_200_000, "6h": 21_600_000, "3h": 10_800_000, "1h": 3_600_000 };

export const energyProxy = (mag) => Math.pow(10, 1.5 * mag);

export function mean(values) {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function sampleStd(values, mu = mean(values)) {
  if (values.length < 2) return NaN;
  let ss = 0;
  for (const v of values) ss += (v - mu) * (v - mu);
  return Math.sqrt(ss / (values.length - 1));
}

export function cusumSeries(values, mu0, k) {
  const scores = new Array(values.length);
  let previous = 0;
  for (let t = 0; t < values.length; t++) {
    previous = Math.max(0, previous + (values[t] - mu0 - k));
    scores[t] = previous;
  }
  return scores;
}

/**
 * @param {{lat:number, lon:number, mag:number, timeMs:number}[]} events
 * @param {{gridDeg?:number, timeStep?:string, kFactor?:number, hFactor?:number, minEvents?:number}} opts
 * @returns {{anomalies: object[], cells: object[]}} anomalies = one row per alarmed step,
 *          cells = one summary per tested cell (same shape as the Python grid summary).
 */
export function runSpatioTemporalCusum(events, opts = {}) {
  const { gridDeg = 2.0, timeStep = "1D", kFactor = 0.5, hFactor = 3.5, minEvents = 4 } = opts;
  const stepMs = TIME_STEPS[timeStep];
  if (!stepMs) throw new Error(`Unsupported time step "${timeStep}"`);
  if (!(gridDeg > 0)) throw new Error("gridDeg must be positive");

  const groups = new Map();
  for (const ev of events) {
    const lat = Math.floor(ev.lat / gridDeg) * gridDeg;
    const lon = Math.floor(ev.lon / gridDeg) * gridDeg;
    const key = `${lat}|${lon}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { lat, lon, events: [] }));
    g.events.push(ev);
  }

  const anomalies = [];
  const cells = [];

  for (const g of groups.values()) {
    if (g.events.length < minEvents) continue;

    let first = Infinity, last = -Infinity, maxMag = -Infinity;
    for (const ev of g.events) {
      const b = Math.floor(ev.timeMs / stepMs);
      if (b < first) first = b;
      if (b > last) last = b;
      if (ev.mag > maxMag) maxMag = ev.mag;
    }
    const nBins = last - first + 1;
    if (nBins < MIN_TIME_BINS) continue;

    const series = new Array(nBins).fill(0);
    for (const ev of g.events) series[Math.floor(ev.timeMs / stepMs) - first] += energyProxy(ev.mag);

    const mu0 = mean(series);
    const std = sampleStd(series, mu0);
    const sigma0 = std > 0 ? std : 1e-6;
    const k = kFactor * sigma0;
    const h = hFactor * sigma0;
    const scores = cusumSeries(series, mu0, k);

    let maxS = 0;
    const alarms = [];
    scores.forEach((s, t) => {
      if (s > maxS) maxS = s;
      if (s > h) {
        const timeMs = (first + t) * stepMs;
        alarms.push({ timeMs, energy: series[t], score: s });
        anomalies.push({
          grid_lat: g.lat + gridDeg / 2,
          grid_lon: g.lon + gridDeg / 2,
          timestamp: new Date(timeMs).toISOString().slice(0, 19).replace("T", " "),
          energy_spike: series[t],
          baseline_mean: mu0,
          cusum_score: s,
          threshold_h: h,
          event_count: g.events.length,
          max_mag: maxMag,
        });
      }
    });

    cells.push({
      lat: g.lat, lon: g.lon, latCenter: g.lat + gridDeg / 2, lonCenter: g.lon + gridDeg / 2,
      gridDeg, max_cusum: maxS, count: g.events.length, maxMag, mu0, sigma0, k, h, alarms,
    });
  }

  anomalies.sort((a, b) => a.grid_lat - b.grid_lat || a.grid_lon - b.grid_lon || (a.timestamp < b.timestamp ? -1 : 1));
  cells.sort((a, b) => a.lat - b.lat || a.lon - b.lon);
  return { anomalies, cells };
}
