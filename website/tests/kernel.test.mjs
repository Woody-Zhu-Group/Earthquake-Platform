import assert from "node:assert/strict";
import test from "node:test";
import { KERNELS, chooseGrid, densityToRGBA, invMercY, kernelDensityGrid, mercY, peakDensity, rampColor,
         rowCellAreaKm2, wrapLon } from "../src/kernel.js";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const view = { west: -3, east: 3, south: -3, north: 3 };
const mass = (values, b, nx, ny) => {
  const area = rowCellAreaKm2(b, nx, ny);
  let m = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) m += values[j * nx + i] * area[j];
  return m;
};

test("every 2-D kernel integrates to 1 over its support (Gaussian is truncated at 3h: >= 98.8%)", () => {
  for (const [name, K] of Object.entries(KERNELS)) {
    let sum = 0;
    const n = 20000, top = K.support;
    for (let i = 0; i < n; i++) { const u = ((i + 0.5) / n) * top; sum += K.k2(u) * 2 * Math.PI * u * (top / n); }
    near(sum, 1, name === "gaussian" ? 0.012 : 1e-3, name);
  }
});

test("finite-support kernels are exactly zero beyond h", () => {
  for (const name of ["epanechnikov", "quartic", "uniform"]) assert.equal(KERNELS[name].k2(1.0001), 0);
});

test("mercator round-trips and wrapLon wraps", () => {
  for (const lat of [-80, -33.4, 0, 12.5, 64]) near(invMercY(mercY(lat)), lat, 1e-9, "merc");
  assert.equal(wrapLon(190), -170);
  assert.equal(wrapLon(-181), 179);
});

test("a point's weight is conserved by the grid and the peak sits at the point", () => {
  for (const kernel of Object.keys(KERNELS)) {
    const g = chooseGrid(view, 80, kernel);
    const values = kernelDensityGrid({ points: [{ lon: 0.3, lat: -0.4, w: 3 }], bounds: view, nx: g.nx, ny: g.ny, bandwidthKm: g.bandwidthKm, kernel });
    near(mass(values, view, g.nx, g.ny) / 3, 1, kernel === "gaussian" ? 0.04 : 0.03, `${kernel} mass`);
    let best = 0;
    values.forEach((v, n) => { if (v > values[best]) best = n; });
    const lon = view.west + ((best % g.nx) + 0.5) * ((view.east - view.west) / g.nx);
    near(lon, 0.3, 0.35, `${kernel} peak lon`);
  }
});

test("density is linear in weights and additive over points", () => {
  const g = chooseGrid(view, 100, "epanechnikov");
  const run = (points) => kernelDensityGrid({ points, bounds: view, nx: g.nx, ny: g.ny, bandwidthKm: g.bandwidthKm, kernel: "epanechnikov" });
  const a = run([{ lon: -1, lat: 1, w: 1 }]), b = run([{ lon: 1, lat: -1, w: 2 }]), both = run([{ lon: -1, lat: 1, w: 1 }, { lon: 1, lat: -1, w: 2 }]);
  a.forEach((v, n) => near(v + b[n], both[n], 1e-6 * (1 + both[n]), "additive"));
});

test("nothing is drawn beyond the support radius, and zero-weight points are ignored", () => {
  const g = chooseGrid(view, 50, "uniform");
  const v = kernelDensityGrid({ points: [{ lon: 0, lat: 0, w: 1 }, { lon: 2, lat: 2, w: 0 }], bounds: view, nx: g.nx, ny: g.ny, bandwidthKm: g.bandwidthKm, kernel: "uniform" });
  const dLon = (view.east - view.west) / g.nx;
  for (let i = 0; i < g.nx; i++) {
    const lon = view.west + (i + 0.5) * dLon;
    if (Math.abs(lon) * 111.3 > g.bandwidthKm * 1.05 + dLon * 111.3) assert.equal(v[Math.floor(g.ny / 2) * g.nx + i], 0);
  }
  assert.equal(v[(g.ny - 2) * g.nx + g.nx - 3], 0);
});

test("a world view wraps density across the antimeridian", () => {
  const world = { west: -180, east: 180, south: -60, north: 60 };
  const g = chooseGrid(world, 300, "gaussian", 200);
  const v = kernelDensityGrid({ points: [{ lon: 179.9, lat: 0, w: 1 }], bounds: world, nx: g.nx, ny: g.ny, bandwidthKm: g.bandwidthKm, kernel: "gaussian" });
  const row = Math.floor(g.ny / 2);
  assert.ok(v[row * g.nx + 0] > 0 && v[row * g.nx + g.nx - 1] > 0, "both sides of the date line lit");
});

test("grid choice is bounded and raises an unresolvable bandwidth", () => {
  const world = { west: -180, east: 180, south: -70, north: 70 };
  const g = chooseGrid(world, 20, "gaussian", 300);
  assert.ok(g.nx <= 300 && g.ny <= 300 && g.nx >= 16);
  assert.ok(g.bandwidthKm > 20, "20 km kernel cannot be resolved on a world view, so it is widened");
  const zoomed = chooseGrid({ west: -118.5, east: -117.5, south: 33.5, north: 34.5 }, 20, "gaussian", 300);
  assert.equal(zoomed.bandwidthKm >= 20, true);
});

test("colour scale is absolute: saturation stacked points reach full scale; empty cells are transparent", () => {
  const h = 50, sat = 4;
  const full = peakDensity("gaussian", h) * sat;
  const rgba = densityToRGBA(new Float32Array([0, full * 0.001, full * 0.5, full]), { ramp: "events", bandwidthKm: h, kernel: "gaussian", saturation: sat });
  assert.equal(rgba[3], 0); assert.equal(rgba[7], 0);
  assert.ok(rgba[11] > 0 && rgba[15] > rgba[11]);
  assert.deepEqual(rampColor("events", 1), [220, 38, 38]);
  assert.deepEqual(rampColor("events", 0), [37, 99, 235]);
});

test("unknown kernel and bad bandwidth are rejected", () => {
  assert.throws(() => kernelDensityGrid({ points: [], bounds: view, nx: 20, ny: 20, bandwidthKm: 10, kernel: "nope" }), /Unknown kernel/);
  assert.throws(() => kernelDensityGrid({ points: [], bounds: view, nx: 20, ny: 20, bandwidthKm: 0, kernel: "gaussian" }), /positive/);
});
