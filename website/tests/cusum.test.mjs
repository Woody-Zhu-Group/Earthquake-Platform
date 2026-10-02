import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { featureToEvent, parseFeatures } from "../src/api.js";
import { cusumSeries, energyProxy, runSpatioTemporalCusum, sampleStd } from "../src/cusum.js";

const fixtures = new URL("../../tests/fixtures/", import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, fixtures), "utf8"));
const close = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);

test("energy proxy is 10^(1.5 M)", () => {
  close(energyProxy(2), 1000, "M2");
  close(energyProxy(0), 1, "M0");
});

test("CUSUM recursion matches the definition (and includes the first bin)", () => {
  assert.deepEqual(cusumSeries([0, 5, 5, 0, 0], 1, 0.5), [0, 3.5, 7, 5.5, 4]);
  assert.equal(cusumSeries([10, 0], 1, 0.5)[0], 8.5);
});

test("sample standard deviation uses ddof = 1 like pandas", () => {
  close(sampleStd([1, 2, 3, 4]), Math.sqrt(5 / 3), "std");
});

test("rejects unsupported steps", () => {
  assert.throws(() => runSpatioTemporalCusum([], { timeStep: "2D" }), /Unsupported time step/);
});

test("matches the Python engine on every committed configuration", () => {
  const events = load("synthetic_events.json").map((e) => ({ lat: e.lat, lon: e.lon, mag: e.mag, timeMs: e.time_ms }));
  const expected = load("expected_cusum.json");
  const steps = { "1D": "1D", "6h": "6h" };

  for (const [name, exp] of Object.entries(expected)) {
    const p = exp.params;
    const { anomalies, cells } = runSpatioTemporalCusum(events, {
      gridDeg: p.grid_deg, timeStep: steps[p.time_step], kFactor: p.k_factor, hFactor: p.h_factor, minEvents: p.min_events,
    });

    assert.equal(cells.length, exp.grid.length, `${name}: tested cell count`);
    cells.forEach((c, i) => {
      assert.equal(c.lat, exp.grid[i].lat, `${name}: cell lat`);
      assert.equal(c.lon, exp.grid[i].lon, `${name}: cell lon`);
      assert.equal(c.count, exp.grid[i].count, `${name}: cell count`);
      close(c.max_cusum, exp.grid[i].max_cusum, `${name}: max_cusum`);
    });

    assert.equal(anomalies.length, exp.anomalies.length, `${name}: alarm row count`);
    const key = (a) => `${a.grid_lat}|${a.grid_lon}|${a.timestamp}`;
    const byKey = new Map(exp.anomalies.map((a) => [key(a), a]));
    for (const a of anomalies) {
      const e = byKey.get(key(a));
      assert.ok(e, `${name}: unexpected alarm ${key(a)}`);
      close(a.cusum_score, e.cusum_score, `${name}: score`);
      close(a.threshold_h, e.threshold_h, `${name}: h`);
      close(a.baseline_mean, e.baseline_mean, `${name}: mu0`);
      close(a.energy_spike, e.energy_spike, `${name}: spike`);
      assert.equal(a.event_count, e.event_count);
      assert.equal(a.max_mag, e.max_mag);
    }
  }
});

test("USGS feature parsing drops unusable events and sorts by time", () => {
  assert.equal(featureToEvent({ properties: { mag: null, time: 1 }, geometry: { coordinates: [1, 2, 3] } }), null);
  assert.equal(featureToEvent({ properties: { mag: 1, time: 1 }, geometry: null }), null);
  const out = parseFeatures({
    features: [
      { id: "b", properties: { mag: 4, time: 2000, place: "B" }, geometry: { coordinates: [10, 20] } },
      { id: "a", properties: { mag: 5, time: 1000 }, geometry: { coordinates: [11, 21, 9] } },
    ],
  });
  assert.deepEqual(out.map((e) => e.id), ["a", "b"]);
  assert.equal(out[1].depth, null);
  assert.equal(out[0].place, "Unknown location");
});
