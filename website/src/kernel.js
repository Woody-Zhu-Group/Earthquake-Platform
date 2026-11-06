// Kernel density smoothing on a lon/lat map. Pure functions (no DOM) so Node can test them.
//
// density(x) = sum_i w_i * K2(|x - x_i| / h) / h^2     [weight per km^2, K2 integrates to 1 over the plane]
//
// Distances are local equirectangular kilometres (adequate at kernel scale, fixed in longitude by cos(latitude)).
// Grid rows are evenly spaced in Web-Mercator y so the image lines up with Leaflet's basemap.

export const KM_PER_DEG_LAT = 111.19;
export const KM_PER_DEG_LON_EQ = 111.32;
const RAD = Math.PI / 180;

// Radially symmetric 2-D kernels. `support` is the cut-off in units of the bandwidth h.
export const KERNELS = {
  gaussian: { label: "Gaussian", support: 3, k2: (u) => Math.exp(-0.5 * u * u) / (2 * Math.PI) },
  epanechnikov: { label: "Epanechnikov", support: 1, k2: (u) => (u < 1 ? (2 / Math.PI) * (1 - u * u) : 0) },
  quartic: { label: "Quartic (biweight)", support: 1, k2: (u) => (u < 1 ? (3 / Math.PI) * (1 - u * u) ** 2 : 0) },
  uniform: { label: "Uniform (disc)", support: 1, k2: (u) => (u < 1 ? 1 / Math.PI : 0) },
};

export const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));
export const invMercY = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD;
export const wrapLon = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Peak density of one unit-weight point with bandwidth h (km): the value at its own location. */
export const peakDensity = (kernel, hKm) => KERNELS[kernel].k2(0) / (hKm * hKm);

/**
 * Pick grid size for a view. Cells are never finer than the view allows (maxCells across) and never so fine that a
 * kernel spans more than ~30 cells, which keeps the cost bounded. The bandwidth is raised to >= 1.5 cells so the
 * kernel is resolvable; `bandwidthKm` in the result is what is actually used.
 */
export function chooseGrid(bounds, bandwidthKm, kernel, maxCells = 300) {
  const midLat = (bounds.south + bounds.north) / 2;
  const widthKm = (bounds.east - bounds.west) * KM_PER_DEG_LON_EQ * Math.cos(midLat * RAD);
  const support = KERNELS[kernel].support;
  const cellKm = Math.max(widthKm / maxCells, (bandwidthKm * support) / 30);
  const nx = Math.max(16, Math.min(maxCells, Math.ceil(widthKm / cellKm)));
  const dxRad = (bounds.east - bounds.west) * RAD;
  const dyMerc = mercY(bounds.north) - mercY(bounds.south);
  const ny = Math.max(16, Math.min(maxCells, Math.ceil((nx * dyMerc) / dxRad)));
  return { nx, ny, bandwidthKm: Math.max(bandwidthKm, 1.5 * (widthKm / nx)) };
}

/**
 * @param {{points:{lon:number,lat:number,w:number}[], bounds:{west,south,east,north}, nx:number, ny:number,
 *          bandwidthKm:number, kernel:string}} args
 * @returns {Float32Array} nx*ny densities, row 0 = north, in weight per km^2
 */
export function kernelDensityGrid({ points, bounds, nx, ny, bandwidthKm, kernel }) {
  const K = KERNELS[kernel];
  if (!K) throw new Error(`Unknown kernel "${kernel}"`);
  if (!(bandwidthKm > 0)) throw new Error("bandwidthKm must be positive");
  const out = new Float32Array(nx * ny);
  const yN = mercY(bounds.north), yS = mercY(bounds.south);
  const dY = (yN - yS) / ny;
  const dLon = (bounds.east - bounds.west) / nx;
  const rowLat = new Float64Array(ny), rowCos = new Float64Array(ny);
  for (let j = 0; j < ny; j++) {
    rowLat[j] = invMercY(yN - (j + 0.5) * dY);
    rowCos[j] = Math.cos(rowLat[j] * RAD);
  }
  const R = K.support * bandwidthKm;
  const h2 = bandwidthKm * bandwidthKm;

  for (const p of points) {
    if (!(p.w > 0)) continue;
    const dLatMax = R / KM_PER_DEG_LAT;
    const jMin = Math.max(0, Math.floor((yN - mercY(Math.min(89, p.lat + dLatMax))) / dY));
    const jMax = Math.min(ny - 1, Math.ceil((yN - mercY(Math.max(-89, p.lat - dLatMax))) / dY));
    for (let j = jMin; j <= jMax; j++) {
      const dyKm = (rowLat[j] - p.lat) * KM_PER_DEG_LAT;
      if (Math.abs(dyKm) >= R) continue;
      const cosMid = Math.cos(((rowLat[j] + p.lat) / 2) * RAD);
      const kmPerLon = KM_PER_DEG_LON_EQ * Math.max(cosMid, 1e-3);
      const dxMaxKm = Math.sqrt(R * R - dyKm * dyKm);
      const spanCols = Math.ceil(dxMaxKm / kmPerLon / dLon);
      const centre = Math.floor((p.lon - bounds.west) / dLon);
      const full = 2 * spanCols + 1 >= nx;
      const iFrom = full ? 0 : centre - spanCols, iTo = full ? nx - 1 : centre + spanCols;
      for (let i = iFrom; i <= iTo; i++) {
        const ii = ((i % nx) + nx) % nx;
        if (!full && (i < 0 || i >= nx) && bounds.east - bounds.west < 360) continue; // wrap only for full-world views
        const lon = bounds.west + (ii + 0.5) * dLon;
        const dxKm = wrapLon(lon - p.lon) * kmPerLon;
        const d2 = dxKm * dxKm + dyKm * dyKm;
        if (d2 >= R * R) continue;
        out[j * nx + ii] += (p.w * K.k2(Math.sqrt(d2) / bandwidthKm)) / h2;
      }
    }
  }
  return out;
}

/** Cell areas in km^2 per row (for mass checks). */
export function rowCellAreaKm2(bounds, nx, ny) {
  const yN = mercY(bounds.north), yS = mercY(bounds.south), dY = (yN - yS) / ny;
  const dLon = (bounds.east - bounds.west) / nx;
  return Array.from({ length: ny }, (_, j) => {
    const top = invMercY(yN - j * dY), bot = invMercY(yN - (j + 1) * dY), mid = (top + bot) / 2;
    return dLon * KM_PER_DEG_LON_EQ * Math.cos(mid * RAD) * (top - bot) * KM_PER_DEG_LAT;
  });
}

export const RAMPS = {
  events: [[0, [37, 99, 235]], [0.25, [6, 182, 212]], [0.5, [132, 204, 22]], [0.75, [250, 204, 21]], [1, [220, 38, 38]]],
  zones: [[0, [168, 85, 247]], [0.4, [217, 70, 239]], [0.7, [239, 68, 68]], [1, [250, 204, 21]]],
  baseline: [[0, [100, 116, 139]], [0.5, [20, 184, 166]], [1, [110, 231, 183]]],
};

export function rampColor(ramp, v) {
  const stops = RAMPS[ramp];
  const x = Math.min(1, Math.max(0, v));
  for (let k = 1; k < stops.length; k++) {
    if (x <= stops[k][0]) {
      const [x0, c0] = stops[k - 1], [x1, c1] = stops[k];
      const f = (x - x0) / (x1 - x0 || 1);
      return c0.map((c, n) => Math.round(c + (c1[n] - c) * f));
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * Densities -> RGBA bytes. Colour scale is *absolute*, not per-frame: 1.0 = `saturation` unit-weight points stacked
 * at one place, so intensity stays comparable while scrolling through time.
 */
export function densityToRGBA(values, { ramp, bandwidthKm, kernel, saturation, opacity = 0.75 }) {
  const full = peakDensity(kernel, bandwidthKm) * saturation;
  const rgba = new Uint8ClampedArray(values.length * 4);
  for (let n = 0; n < values.length; n++) {
    const v = values[n] / full;
    if (v < 0.015) continue;
    const [r, g, b] = rampColor(ramp, v);
    rgba[4 * n] = r; rgba[4 * n + 1] = g; rgba[4 * n + 2] = b;
    rgba[4 * n + 3] = Math.round(255 * opacity * Math.min(1, 0.25 + v * 1.2));
  }
  return rgba;
}

/**
 * Marching squares on a density grid. Grid values sit at cell centres; returns segments [x0, y0, x1, y1] in
 * fractional grid coordinates (x right, y down, cell centres at integers), using linear interpolation.
 */
export function contourSegments(values, nx, ny, level) {
  const out = [];
  const v = (i, j) => values[j * nx + i];
  const lerp = (a, b) => (a === b ? 0.5 : (level - a) / (b - a));
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const tl = v(i, j), tr = v(i + 1, j), br = v(i + 1, j + 1), bl = v(i, j + 1);
      const code = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const top = [i + lerp(tl, tr), j], right = [i + 1, j + lerp(tr, br)];
      const bottom = [i + lerp(bl, br), j + 1], left = [i, j + lerp(tl, bl)];
      const seg = (a, b) => out.push([a[0], a[1], b[0], b[1]]);
      switch (code) {
        case 1: case 14: seg(left, bottom); break;
        case 2: case 13: seg(bottom, right); break;
        case 3: case 12: seg(left, right); break;
        case 4: case 11: seg(top, right); break;
        case 6: case 9: seg(top, bottom); break;
        case 7: case 8: seg(top, left); break;
        case 5: case 10: {
          const centreHigh = (tl + tr + br + bl) / 4 >= level;
          const joined = (code === 5) === centreHigh;      // high corners connected through the centre
          if (joined) { seg(top, left); seg(bottom, right); } else { seg(top, right); seg(left, bottom); }
          break;
        }
      }
    }
  }
  return out;
}

/** Fractional grid coordinates (cell centres at integers) -> [lat, lon] for a grid made by kernelDensityGrid. */
export function gridToLatLng(bounds, nx, ny, x, y) {
  const yN = mercY(bounds.north), yS = mercY(bounds.south);
  return [invMercY(yN - ((y + 0.5) * (yN - yS)) / ny), bounds.west + (x + 0.5) * ((bounds.east - bounds.west) / nx)];
}

/** Contour levels as fractions of the colour-scale maximum (peakDensity * saturation). */
export const CONTOUR_FRACTIONS = [0.12, 0.3, 0.55, 0.85];
