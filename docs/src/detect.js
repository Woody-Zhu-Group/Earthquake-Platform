// Port of detect.py (Spatio-Temporal-Change-Detection): spatio-temporal CUSUM over score-based anomaly measures.
// Pure functions/classes, no DOM.
//
// Data layout: flat Float64Array [ t, x, y ] per event, sorted by time, x, y in [0, 1].
// Omega (the estimated change region) is a flat Float64Array [ x0, y0, x1, y1, ... ].
//
//   measure_i = psi_f0(event_i) - psi_f1(event_i)           anomaly measure per event
//   inner:    omega = region where the measure is positive within [tau, t)
//   outer:    tau   = argmax over suffixes of the cumulative sum of measure in omega x [0, t)
//             stat  = that max (the CUSUM statistic)
//   K inner/outer rounds per time grid point, as in detect.py.

const COLS = 3;
const MEASURE_EPS = 1e-5; // detect.py: "non-negligible measure"

/** Smallest index with data[i].t >= t (data sorted by time). */
function lowerBound(data, n, t) {
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (data[mid * COLS] < t) lo = mid + 1; else hi = mid; }
  return lo;
}

export function linspace(a, b, n) {
  return Array.from({ length: n }, (_, i) => (n === 1 ? a : a + ((b - a) * i) / (n - 1)));
}

/** Uniform spatial hash of omega points so "within Chebyshev radius of omega" is a few lookups per event. */
function buildOmegaHash(omega, radius) {
  const buckets = new Map();
  const cell = Math.max(radius, 1e-12);
  const m = omega.length / 2;
  for (let q = 0; q < m; q++) {
    const cx = Math.floor(omega[2 * q] / cell), cy = Math.floor(omega[2 * q + 1] / cell);
    const k = cx * 100003 + cy;
    const list = buckets.get(k);
    if (list) list.push(q); else buckets.set(k, [q]);
  }
  return { buckets, cell };
}

/** Chebyshev distance < radius to any omega point, for events [0, count). @returns {Uint8Array} */
export function inOmega(data, count, omega, radius) {
  const mask = new Uint8Array(count);
  if (omega.length === 0 || !(radius > 0)) return mask;
  const { buckets, cell } = buildOmegaHash(omega, radius);
  for (let i = 0; i < count; i++) {
    const x = data[i * COLS + 1], y = data[i * COLS + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    search: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const list = buckets.get((cx + dx) * 100003 + (cy + dy));
      if (!list) continue;
      for (const q of list) {
        if (Math.max(Math.abs(omega[2 * q] - x), Math.abs(omega[2 * q + 1] - y)) < radius) { mask[i] = 1; break search; }
      }
    }
  }
  return mask;
}

export function generateGriddedPoints(nres) {
  const out = new Float64Array(nres * nres * 2);
  let q = 0;
  for (let iy = 0; iy < nres; iy++) for (let ix = 0; ix < nres; ix++) {
    out[q++] = ix / (nres - 1); out[q++] = iy / (nres - 1);
  }
  return out;
}

/** Reverse cumulative sum: returns { value: max suffix sum, index: its (first) position }. */
export function cusum(arr) {
  let run = 0, best = -Infinity, idx = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    run += arr[i];
    if (run >= best) { best = run; idx = i; } // >= while scanning backwards keeps the earliest index on ties (numpy argmax)
  }
  return { value: best, index: idx };
}

export class SpatioTemporalDetector {
  /** @param f0 pre-change ScoreModel, f1 post-change ScoreModel (both from score.js) */
  constructor(f0, f1) { this.f0 = f0; this.f1 = f1; }

  /**
   * inner optimisation, event based: omega = locations of events in [tau, t) with non-negligible measure.
   * @returns {Float64Array} flat [x, y, ...]
   */
  static innerEvent(data, measure, tau, t) {
    const n = data.length / COLS;
    const lo = lowerBound(data, n, tau), hi = lowerBound(data, n, t);
    const out = [];
    for (let i = lo; i < hi; i++) if (measure[i] > MEASURE_EPS) out.push(data[i * COLS + 1], data[i * COLS + 2]);
    return Float64Array.from(out);
  }

  /** inner optimisation, grid based: omega = grid points whose neighbouring measure mass is positive. */
  static innerGrid(data, measure, tau, nres, t) {
    const n = data.length / COLS;
    const lo = lowerBound(data, n, tau), hi = lowerBound(data, n, t);
    const half = 1 / (2 * (nres - 1)), step = 1 / (nres - 1);
    const val = new Float64Array(nres * nres);
    for (let i = lo; i < hi; i++) {
      const x = data[i * COLS + 1], y = data[i * COLS + 2];
      for (let iy = Math.max(0, Math.floor(y / step - 1)); iy <= Math.min(nres - 1, Math.ceil(y / step + 1)); iy++) {
        if (!(Math.abs(iy * step - y) < half)) continue;
        for (let ix = Math.max(0, Math.floor(x / step - 1)); ix <= Math.min(nres - 1, Math.ceil(x / step + 1)); ix++) {
          if (Math.abs(ix * step - x) < half) val[iy * nres + ix] += measure[i];
        }
      }
    }
    const out = [];
    for (let iy = 0; iy < nres; iy++) for (let ix = 0; ix < nres; ix++) {
      if (val[iy * nres + ix] > MEASURE_EPS) out.push(ix * step, iy * step);
    }
    return Float64Array.from(out);
  }

  /**
   * outer optimisation: change point tau and CUSUM statistic over events in omega x [0, t).
   * @returns {{tau:number, stat:number}}
   */
  static outer(data, measure, omega, radius, t) {
    const n = data.length / COLS;
    const hi = lowerBound(data, n, t);
    const inside = inOmega(data, hi, omega, radius);
    const idx = [];
    for (let i = 0; i < hi; i++) if (inside[i]) idx.push(i);
    if (idx.length === 0) return { tau: t, stat: 0 };
    const { value, index } = cusum(idx.map((i) => measure[i]));
    return { tau: data[idx[index] * COLS], stat: value };
  }

  /** Run K inner/outer rounds at time t. Returns the new { tau, omega, stat }. */
  static step(data, measure, tau, t, { K, useGrid, nres, radius }) {
    let omega, stat;
    for (let k = 0; k < K; k++) {
      omega = useGrid ? SpatioTemporalDetector.innerGrid(data, measure, tau, nres, t)
                      : SpatioTemporalDetector.innerEvent(data, measure, tau, t);
      ({ tau, stat } = SpatioTemporalDetector.outer(data, measure, omega, radius, t));
    }
    return { tau, omega, stat };
  }

  /**
   * Offline detection: both models are already trained.
   * @returns {{tt:number[], tauList:number[], omegaList:Float64Array[], statList:number[], measure:Float64Array}}
   */
  offline(data, { ntt = 50, K = 5, nres = 20, radius = 0.1, useGrid = false } = {}) {
    const n = data.length / COLS;
    const measure = this.measureFor(data);
    const tt = linspace(data[0], data[(n - 1) * COLS] + 1e-5, ntt);
    const r = useGrid ? 1 / (2 * (nres - 1)) : radius;
    const tauList = [], omegaList = [], statList = [];
    let tau = 0;
    for (const t of tt) {
      const s = SpatioTemporalDetector.step(data, measure, tau, t, { K, useGrid, nres, radius: r });
      tau = s.tau;
      tauList.push(s.tau); omegaList.push(s.omega); statList.push(s.stat);
    }
    return { tt, tauList, omegaList, statList, measure };
  }

  measureFor(data) {
    const p0 = this.f0.psi(data), p1 = this.f1.psi(data);
    return p0.map((v, i) => v - p1[i]);
  }

  /**
   * Online detection: f0 is trained on the baseline; f1 is re-fitted every `skip` steps on the previous batch
   * restricted to the current change region and to times after tau (detect.py `online`).
   * @param {{ntt?:number,K?:number,nUpdate?:number,window?:number|null,fitKwds?:object,nres?:number,radius?:number,
   *          useGrid?:boolean,onProgress?:(i:number,n:number)=>void}} opts
   */
  online(data, { ntt = 100, K = 5, nUpdate = 10, window = null, fitKwds = {}, nres = 20, radius = 0.1, useGrid = false, onProgress } = {}) {
    const n = data.length / COLS;
    const tt = linspace(data[0], data[(n - 1) * COLS] + 1e-5, ntt);
    const loc0 = this.f0.localize(data), loc1 = this.f1.localize(data);
    const psi0 = this.f0.psiLoc(loc0);
    const psi1Init = this.f1.psiLoc(loc1);
    const measure = psi0.map((v, i) => v - psi1Init[i]); // placeholder, f1 starts untrained

    const skip = nUpdate != null ? Math.max(1, Math.floor(ntt / nUpdate)) : 1;
    const win = window == null ? skip : window;
    const r = useGrid ? 1 / (2 * (nres - 1)) : radius;
    const tauList = [], omegaList = [], statList = [];
    let tau = 0;

    for (let i = 0; i < tt.length; i++) {
      const t = tt[i];
      const s = SpatioTemporalDetector.step(data, measure, tau, t, { K, useGrid, nres, radius: r });
      tau = s.tau;
      tauList.push(tau); omegaList.push(s.omega); statList.push(s.stat);
      if (onProgress) onProgress(i, tt.length);

      if (i % skip === 0 && i !== 0) {
        const oldLo = tt[Math.max(i - Math.max(skip, win), 0)], oldHi = tt[i];
        const newLo = tt[i], newHi = tt[Math.min(i + skip, tt.length - 1)];
        const inSpace = inOmega(data, n, s.omega, r);
        const pick = (pred) => { const out = []; for (let e = 0; e < n; e++) if (pred(e)) out.push(e); return out; };
        const tOf = (e) => data[e * COLS];
        let fitIdx = pick((e) => tOf(e) >= oldLo && tOf(e) < oldHi && inSpace[e] && tOf(e) >= tau);
        if (fitIdx.length === 0) fitIdx = pick((e) => tOf(e) >= oldLo && tOf(e) < oldHi); // fall back to the whole previous batch
        if (fitIdx.length > 0) {
          const sub = new Float64Array(fitIdx.length * COLS);
          fitIdx.forEach((e, q) => sub.set(data.subarray(e * COLS, e * COLS + COLS), q * COLS));
          // batch duration rescales the base rate (score.js `timeSpan`); score.py's online() omits this
          this.f1.fit(sub, { timeSpan: Math.max(oldHi - oldLo, 1e-9), ...fitKwds });
          const psi1 = this.f1.psiLoc(loc1);
          for (let e = 0; e < n; e++) if (tOf(e) >= newLo && tOf(e) < newHi) measure[e] = psi0[e] - psi1[e];
        }
      }
    }
    return { tt, tauList, omegaList, statList, measure };
  }
}
