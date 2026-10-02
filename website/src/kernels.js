// Kernel utilities for the two map layers. Pure functions, no DOM.
//
//  * event kernel:  Gaussian kernel density of the events in the observation window (weights = 1 or magnitude based)
//  * zone kernel:   Gaussian kernel smoothing of the CUSUM anomaly zone: every event inside the estimated change
//                   region omega contributes its (positive) anomaly measure, so the zone becomes a smooth
//                   surface with a contour boundary instead of a union of hard-edged cells.
//
// Both work on a coarse screen-space grid (`cell` pixels per grid cell) so cost is O(points * footprint).

export function gaussianWeight(d2, sigma) {
  return Math.exp(-d2 / (2 * sigma * sigma));
}

/**
 * Weighted Gaussian kernel sum on a grid.
 * @param {{x:number,y:number,w:number}[]|{length:number}} points  pixel coordinates (screen space)
 * @param {{width:number,height:number,cell:number,sigma:number,cutoff?:number}} o  sigma in pixels
 * @returns {{grid:Float32Array, cols:number, rows:number, cell:number, max:number}}
 */
export function kernelGrid(points, { width, height, cell = 4, sigma, cutoff = 3 }) {
  const cols = Math.max(1, Math.ceil(width / cell)), rows = Math.max(1, Math.ceil(height / cell));
  const grid = new Float32Array(cols * rows);
  const reach = Math.max(1, Math.ceil((cutoff * sigma) / cell));
  for (const p of points) {
    if (!(p.w > 0) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const gx = p.x / cell - 0.5, gy = p.y / cell - 0.5; // position in cell-centre coordinates
    const x0 = Math.max(0, Math.floor(gx) - reach), x1 = Math.min(cols - 1, Math.ceil(gx) + reach);
    const y0 = Math.max(0, Math.floor(gy) - reach), y1 = Math.min(rows - 1, Math.ceil(gy) + reach);
    for (let j = y0; j <= y1; j++) {
      const dy = (j - gy) * cell;
      for (let i = x0; i <= x1; i++) {
        const dx = (i - gx) * cell;
        grid[j * cols + i] += p.w * gaussianWeight(dx * dx + dy * dy, sigma);
      }
    }
  }
  let max = 0;
  for (let k = 0; k < grid.length; k++) if (grid[k] > max) max = grid[k];
  return { grid, cols, rows, cell, max };
}

/** Marching squares. Returns line segments [x1, y1, x2, y2] in cell-centre coordinates (multiply by cell for pixels). */
export function contourSegments(grid, cols, rows, level) {
  const segs = [];
  const v = (i, j) => grid[j * cols + i];
  const lerp = (a, b) => (a === b ? 0.5 : (level - a) / (b - a));
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = v(i, j), b = v(i + 1, j), c = v(i + 1, j + 1), d = v(i, j + 1);
      const code = (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (c >= level ? 4 : 0) | (d >= level ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const top = [i + lerp(a, b), j], right = [i + 1, j + lerp(b, c)];
      const bottom = [i + lerp(d, c), j + 1], left = [i, j + lerp(a, d)];
      const add = (p, q) => segs.push([p[0], p[1], q[0], q[1]]);
      switch (code) {
        case 1: case 14: add(left, top); break;
        case 2: case 13: add(top, right); break;
        case 3: case 12: add(left, right); break;
        case 4: case 11: add(right, bottom); break;
        case 6: case 9: add(top, bottom); break;
        case 7: case 8: add(left, bottom); break;
        case 5: add(left, top); add(right, bottom); break;   // saddle
        case 10: add(top, right); add(left, bottom); break;  // saddle
        default: break;
      }
    }
  }
  return segs;
}

/** Number of 4-connected regions with value >= level. */
export function countRegions(grid, cols, rows, level) {
  const seen = new Uint8Array(grid.length);
  let regions = 0;
  const stack = [];
  for (let s = 0; s < grid.length; s++) {
    if (seen[s] || !(grid[s] >= level)) continue;
    regions++;
    seen[s] = 1; stack.push(s);
    while (stack.length) {
      const k = stack.pop(), i = k % cols, j = (k / cols) | 0;
      const nb = [i > 0 ? k - 1 : -1, i < cols - 1 ? k + 1 : -1, j > 0 ? k - cols : -1, j < rows - 1 ? k + cols : -1];
      for (const q of nb) if (q >= 0 && !seen[q] && grid[q] >= level) { seen[q] = 1; stack.push(q); }
    }
  }
  return regions;
}

/** Piecewise-linear colour ramp. stops: [[t, [r,g,b,a]], ...] with t ascending in [0,1], a in [0,1]. */
export function rampColor(stops, t) {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0 || 1);
      return c0.map((v, k) => v + (c1[k] - v) * f);
    }
  }
  return stops[stops.length - 1][1];
}

export const EVENT_RAMP = [
  [0.0, [0, 0, 255, 0]], [0.08, [0, 0, 255, 0.25]], [0.3, [0, 255, 255, 0.5]],
  [0.5, [0, 255, 0, 0.6]], [0.75, [255, 255, 0, 0.7]], [1.0, [255, 0, 0, 0.8]],
];
export const ZONE_RAMP = [
  [0.0, [168, 85, 247, 0]], [0.1, [168, 85, 247, 0.2]], [0.4, [217, 70, 239, 0.5]],
  [0.7, [239, 68, 68, 0.65]], [1.0, [250, 204, 21, 0.8]],
];
