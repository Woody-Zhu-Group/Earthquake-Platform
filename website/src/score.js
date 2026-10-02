// Port of score.py (Spatio-Temporal-Change-Detection): the score model behind the CUSUM detector.
// Pure functions/classes, no DOM, so Node tests can exercise it.
//
// Data layout: flat Float64Array, row-major, ndim columns per event: [ t, x, y ] with x, y in [0, 1].
//
// Differences from score.py (deliberate, see website/README.md):
//  * the LSTM branch is dropped. score.py's own docstring says the model assumes "no history dependence
//    (i.e., marginal)", and the LSTM was fed shuffled mini-batch rows as if they were a sequence. The
//    network is score(x) = base + W2 * silu(W1 x + b1) + b2, with W2 and b2 zero-initialised exactly as in
//    score.py, so it starts from the `base` score.
//  * gradients are written out by hand (one hidden layer), so there is no autograd dependency. The
//    divergence in psi() is the closed-form diagonal of the Jacobian.
//  * `use_transform` is not ported (the demo notebook runs with use_transform=False).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const silu = (z) => z * sigmoid(z);
const dsilu = (z) => { const s = sigmoid(z); return s * (1 + z * (1 - s)); };

export function toFlat(rows, ndim = 3) {
  const out = new Float64Array(rows.length * ndim);
  rows.forEach((r, i) => { for (let c = 0; c < ndim; c++) out[i * ndim + c] = r[c]; });
  return out;
}

export class ScoreModel {
  /**
   * @param {{ndim?:number, radius?:number, hidden?:number, seed?:number}} opts
   *   radius: neighbourhood radius used to localise time (find_index) and in the base score.
   */
  constructor({ ndim = 3, radius = 0.1, hidden = 64, seed = 1 } = {}) {
    this.ndim = ndim;
    this.radius = radius;
    this.hidden = hidden;
    this.rng = mulberry32(seed);
    this.base = new Float64Array(ndim); // not trained, set from the data in fit()
    const bound = 1 / Math.sqrt(ndim);   // torch's default nn.Linear init for the first layer
    const u = () => (this.rng() * 2 - 1) * bound;
    this.W1 = Float64Array.from({ length: hidden * ndim }, u);
    this.b1 = Float64Array.from({ length: hidden }, u);
    this.W2 = new Float64Array(ndim * hidden); // zero init: score starts at `base`
    this.b2 = new Float64Array(ndim);
  }

  gauss() {
    const u1 = Math.max(this.rng(), 1e-12), u2 = this.rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** Score of one (already localised) point, written into out[0..ndim). */
  scoreAt(data, i, out) {
    const { ndim, hidden, W1, b1, W2, b2, base } = this;
    for (let c = 0; c < ndim; c++) out[c] = base[c] + b2[c];
    for (let j = 0; j < hidden; j++) {
      let z = b1[j];
      for (let k = 0; k < ndim; k++) z += W1[j * ndim + k] * data[i * ndim + k];
      const a = silu(z);
      for (let c = 0; c < ndim; c++) out[c] += W2[c * hidden + j] * a;
    }
    return out;
  }

  /** @returns {Float64Array} [ n * ndim ] scores of localised data */
  score(data) {
    const n = data.length / this.ndim;
    const out = new Float64Array(data.length);
    const tmp = new Float64Array(this.ndim);
    for (let i = 0; i < n; i++) { this.scoreAt(data, i, tmp); out.set(tmp, i * this.ndim); }
    return out;
  }

  /** Base score from the data: mu is the median of a Gaussian-KDE density over the spatial columns. */
  fitBase(data, timeSpan = 1) {
    const { ndim, radius } = this;
    const n = data.length / ndim;
    if (n === 0) { this.base = new Float64Array(ndim); return; }
    let mu = kdeMedianDensity(data, ndim, n);
    if (mu == null) { // KDE failed (too few / degenerate points): global-volume estimate, as in score.py
      let vol = 1;
      for (let c = 0; c < ndim; c++) {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < n; i++) { const v = data[i * ndim + c]; if (v < lo) lo = v; if (v > hi) hi = v; }
        vol *= hi - lo;
      }
      mu = vol > 0 ? n / vol : 0;
    }
    this.base = new Float64Array(ndim);
    // score.py treats the data as spanning one unit of time, so mu (events per unit area) is a rate.
    // `timeSpan` rescales it when a model is refitted on a shorter batch (online updates); default 1 = score.py.
    this.base[0] = -(mu / timeSpan) * 4 * radius * radius;
  }

  /**
   * Denoising score matching on the localised data. score.py: Adam, fresh optimiser per call.
   * @returns {number[]} mean loss per epoch
   */
  fit(data, { batchSize = 256, nEpochs = 100, lr = 1e-3, sigma = 0.1, timeSpan = 1 } = {}) {
    const { ndim, hidden } = this;
    const n = data.length / ndim;
    this.fitBase(data, timeSpan);
    if (n === 0 || lr === 0) return [];
    const loc = this.localize(data);
    const P = { W1: this.W1, b1: this.b1, W2: this.W2, b2: this.b2 };
    const G = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, new Float64Array(v.length)]));
    const M = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, new Float64Array(v.length)]));
    const V = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, new Float64Array(v.length)]));
    const [beta1, beta2, eps] = [0.9, 0.999, 1e-8];
    const order = Array.from({ length: n }, (_, i) => i);
    const xt = new Float64Array(ndim), noise = new Float64Array(ndim), r = new Float64Array(ndim);
    const z = new Float64Array(hidden), a = new Float64Array(hidden);
    const losses = [];
    let step = 0;
    for (let epoch = 0; epoch < nEpochs; epoch++) {
      for (let i = n - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      let lossSum = 0, nb = 0;
      for (let s = 0; s < n; s += batchSize) {
        const B = Math.min(batchSize, n - s);
        for (const g of Object.values(G)) g.fill(0);
        let loss = 0;
        for (let q = 0; q < B; q++) {
          const row = order[s + q];
          for (let c = 0; c < ndim; c++) { noise[c] = this.gauss() * sigma; xt[c] = loc[row * ndim + c] + noise[c]; }
          for (let c = 0; c < ndim; c++) r[c] = this.base[c] + this.b2[c];
          for (let j = 0; j < hidden; j++) {
            let zj = this.b1[j];
            for (let k = 0; k < ndim; k++) zj += this.W1[j * ndim + k] * xt[k];
            z[j] = zj; a[j] = silu(zj);
            for (let c = 0; c < ndim; c++) r[c] += this.W2[c * hidden + j] * a[j];
          }
          for (let c = 0; c < ndim; c++) { r[c] += noise[c] / (sigma * sigma); loss += r[c] * r[c]; }
          for (let c = 0; c < ndim; c++) { G.b2[c] += r[c]; for (let j = 0; j < hidden; j++) G.W2[c * hidden + j] += r[c] * a[j]; }
          for (let j = 0; j < hidden; j++) {
            let da = 0;
            for (let c = 0; c < ndim; c++) da += this.W2[c * hidden + j] * r[c];
            const dz = da * dsilu(z[j]);
            G.b1[j] += dz;
            for (let k = 0; k < ndim; k++) G.W1[j * ndim + k] += dz * xt[k];
          }
        }
        step++;
        const scale = 2 / B; // d(mean ||r||^2)/dparam = 2/B * sum r * dr/dparam
        const c1 = 1 - Math.pow(beta1, step), c2 = 1 - Math.pow(beta2, step);
        for (const key of Object.keys(P)) {
          const p = P[key], g = G[key], m = M[key], v = V[key];
          for (let i = 0; i < p.length; i++) {
            const gi = g[i] * scale;
            m[i] = beta1 * m[i] + (1 - beta1) * gi;
            v[i] = beta2 * v[i] + (1 - beta2) * gi * gi;
            p[i] -= (lr * (m[i] / c1)) / (Math.sqrt(v[i] / c2) + eps);
          }
        }
        lossSum += loss / B; nb++;
      }
      losses.push(lossSum / nb);
    }
    return losses;
  }

  /**
   * Time since the most recent earlier event within `radius` (spatially). Mirrors localize()/find_index():
   * neighbours at distance exactly 0 are ignored, and an event with no neighbour falls back to event 0.
   * @returns {Float64Array} localised copy of data
   */
  localize(data) {
    const { ndim, radius } = this;
    const n = data.length / ndim;
    const out = Float64Array.from(data);
    const cell = Math.max(radius, 1e-12);
    const buckets = new Map();
    const key = (cx, cy) => cx * 73856093 ^ cy * 19349663;
    for (let i = 0; i < n; i++) {
      const x = data[i * ndim + 1], y = data[i * ndim + 2];
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      let best = -1;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const list = buckets.get(key(cx + dx, cy + dy));
        if (!list) continue;
        for (let q = list.length - 1; q >= 0; q--) {
          const j = list[q];
          if (j <= best) break; // lists are ascending: nothing later in this list can beat `best`
          const d = Math.hypot(data[j * ndim + 1] - x, data[j * ndim + 2] - y);
          if (d > 0 && d <= radius) { best = j; break; }
        }
      }
      if (best < 0) best = 0;
      out[i * ndim] = data[i * ndim] - data[best * ndim];
      const k = key(cx, cy);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(i);
    }
    return out;
  }

  /** Weighted Hyvarinen score of already-localised data. @returns {Float64Array} [ n ] */
  psiLoc(loc) {
    const { ndim, hidden, W1, b1, W2, b2, base } = this;
    const n = loc.length / ndim;
    const psi = new Float64Array(n);
    const s = new Float64Array(ndim), ds = new Float64Array(ndim);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ndim; c++) { s[c] = base[c] + b2[c]; ds[c] = 0; }
      for (let j = 0; j < hidden; j++) {
        let z = b1[j];
        for (let k = 0; k < ndim; k++) z += W1[j * ndim + k] * loc[i * ndim + k];
        const act = silu(z), d = dsilu(z);
        for (let c = 0; c < ndim; c++) {
          s[c] += W2[c * hidden + j] * act;
          ds[c] += W2[c * hidden + j] * d * W1[j * ndim + c]; // d score_c / d x_c
        }
      }
      let val = 0;
      for (let c = 0; c < ndim; c++) {
        const x = loc[i * ndim + c];
        let w, dw;
        if (c === 0) { w = x; dw = 1; }
        else { const lo = x, hi = 1 - x; w = Math.min(lo, hi); dw = lo <= hi ? 1 : -1; }
        val += w * s[c] * s[c] + 2 * (dw * s[c] + w * ds[c]);
      }
      psi[i] = val;
    }
    return psi;
  }

  /** @param {Float64Array} data raw (un-localised) data. @returns {Float64Array} [ n ] */
  psi(data) { return this.psiLoc(this.localize(data)); }
}

/**
 * Median over points of (Gaussian KDE over columns 1.. evaluated at the point) * n.
 * Scott's rule, sample covariance (ddof = 1), exactly scipy.stats.gaussian_kde defaults.
 * Evaluates at most `maxEval` evenly-spaced points. Returns null if the KDE is degenerate.
 */
export function kdeMedianDensity(data, ndim, n, maxEval = 1500) {
  const d = ndim - 1;
  if (d !== 2 || n < 3) return null; // the portal only uses 2 spatial columns
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += data[i * ndim + 1]; my += data[i * ndim + 2]; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = data[i * ndim + 1] - mx, dy = data[i * ndim + 2] - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  sxx /= n - 1; sxy /= n - 1; syy /= n - 1;
  const factor = Math.pow(n, -1 / (d + 4));
  const a = sxx * factor * factor, b = sxy * factor * factor, c = syy * factor * factor;
  const det = a * c - b * b;
  if (!(det > 0) || !Number.isFinite(det)) return null;
  const ia = c / det, ib = -b / det, ic = a / det;
  const norm = 1 / (n * Math.sqrt((2 * Math.PI) ** 2 * det));
  const m = Math.min(n, maxEval), vals = new Float64Array(m);
  for (let q = 0; q < m; q++) {
    const i = Math.floor((q * n) / m);
    const px = data[i * ndim + 1], py = data[i * ndim + 2];
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const dx = px - data[j * ndim + 1], dy = py - data[j * ndim + 2];
      sum += Math.exp(-0.5 * (dx * dx * ia + 2 * dx * dy * ib + dy * dy * ic));
    }
    vals[q] = sum * norm * n;
  }
  const sorted = Array.from(vals).sort((p, q) => p - q);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
