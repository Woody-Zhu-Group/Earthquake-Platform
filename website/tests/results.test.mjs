import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RegionResult, validateResult } from "../src/results.js";
import { featureToEvent, parseFeatures } from "../src/api.js";

const doc = () => JSON.parse(readFileSync(new URL("../../tests/fixtures/standin_california.json", import.meta.url), "utf8"));

test("the Python-written result file loads", () => {
  const r = new RegionResult(doc());
  assert.equal(r.doc.region.id, "california");
  assert.ok(r.events.length > 50 && r.standin === true && r.t1 > r.t0);
  assert.ok(r.eventTimes.every((t, i) => i === 0 || t >= r.eventTimes[i - 1]), "events sorted");
});

test("stateAt only uses the past: nothing before the first grid time, last state at the end", () => {
  const r = new RegionResult(doc());
  assert.equal(r.stateAt(r.doc.tt_ms[0] - 1).index, -1);
  assert.deepEqual(r.stateAt(r.doc.tt_ms[0] - 1).zone, []);
  const last = r.stateAt(r.t1 + 10 * 86_400_000);
  assert.equal(last.index, r.doc.tt_ms.length - 1);
  assert.equal(last.stat, r.doc.stat.at(-1));
  assert.equal(last.zone.length, r.doc.zone_index.at(-1).length);
  const mid = r.stateAt(r.doc.tt_ms[10] + 1);
  assert.equal(mid.index, 10);
});

test("the end-of-period anomaly zone sits on the swarm (-122, 40) not on the busy normal area (-118, 34)", () => {
  const r = new RegionResult(doc());
  const zone = r.stateAt(r.t1).zone.filter((p) => p.w > 0.3);
  assert.ok(zone.length > 5);
  const med = (k) => zone.map((p) => p[k]).sort((a, b) => a - b)[Math.floor(zone.length / 2)];
  assert.ok(Math.abs(med("lon") - -122) < 1.2 && Math.abs(med("lat") - 40) < 1.2);
});

test("eventsIn is (start, end] and matches a brute-force filter", () => {
  const r = new RegionResult(doc());
  const [a, b] = [r.t0 + 60 * 86_400_000, r.t0 + 200 * 86_400_000];
  assert.deepEqual(r.eventsIn(a, b).map((e) => e.timeMs), r.events.filter((e) => e.timeMs > a && e.timeMs <= b).map((e) => e.timeMs));
  assert.deepEqual(r.eventsIn(r.t1 + 1, r.t1 + 2), []);
  assert.deepEqual(r.eventsIn(b, a), []);
});

test("baseline weights sum to the expected number of normal events in the window", () => {
  const r = new RegionResult(doc());
  const win = 30 * 86_400_000;
  const total = r.baselinePoints(win).reduce((s, p) => s + p.w, 0);
  const expected = (r.doc.meta.n_baseline * win) / r.baselineMs;
  assert.ok(Math.abs(total - expected) < 1e-6 * expected);
  assert.ok(expected > 1 && expected < 20, `expected ${expected}`);
});

test("malformed files are rejected with a readable message", () => {
  for (const [mutate, msg] of [
    [(d) => { d.version = 1; }, /version/],
    [(d) => { d.stat.pop(); }, /differ in length/],
    [(d) => { d.zone_index[3] = [10 ** 9]; }, /outside zone_points/],
    [(d) => { d.event_columns = ["time_ms"]; }, /event_columns/],
    [(d) => { d.region = {}; }, /region\.id/],
  ]) {
    const d = doc(); mutate(d);
    assert.throws(() => validateResult(d), msg);
  }
  assert.throws(() => validateResult(null), /not a JSON object/);
});

test("USGS feature parsing for the live fallback", () => {
  assert.equal(featureToEvent({ properties: { mag: null, time: 1 }, geometry: { coordinates: [1, 2] } }), null);
  const out = parseFeatures({ features: [
    { id: "b", properties: { mag: 4, time: 2000 }, geometry: { coordinates: [10, 20] } },
    { id: "a", properties: { mag: 5, time: 1000, place: "X" }, geometry: { coordinates: [11, 21, 9] } }] });
  assert.deepEqual(out.map((e) => e.id), ["a", "b"]);
  assert.equal(out[1].depth, null);
});
