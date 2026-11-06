import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildGlobalEvents, globalRange, inBbox, timesOf, visibleEvents } from "../src/events.js";
import { RegionResult } from "../src/results.js";

const ca = new RegionResult(JSON.parse(readFileSync(new URL("../../tests/fixtures/standin_california.json", import.meta.url), "utf8")));
const regions = [
  { id: "california", bbox: [-125.5, 32, -114, 42.5] },
  { id: "japan", bbox: [122, 24, 150, 46] },
];
const live = [
  { id: "a", lon: -30, lat: 0, mag: 5, timeMs: ca.t0 + 1000 },          // open ocean: no detector there
  { id: "b", lon: -120, lat: 36, mag: 5, timeMs: ca.t0 + 2000 },        // inside California: the result file already covers it
  { id: "c", lon: 140, lat: 35, mag: 6, timeMs: ca.t0 + 3000 },         // inside Japan, which has no results here: keep the live event
];

test("global pool = result events of regions with results + live events outside those regions only", () => {
  const all = buildGlobalEvents(regions, new Map([["california", ca]]), live);
  assert.equal(all.length, ca.events.length + 2);
  assert.deepEqual(all.filter((e) => !e.regionId).map((e) => e.id).sort(), ["a", "c"]);
  assert.ok(all.every((e, i) => i === 0 || e.timeMs >= all[i - 1].timeMs), "sorted by time");
  assert.ok(all.filter((e) => e.regionId).every((e) => e.regionId === "california"));
});

test("with no results every live event is kept", () => {
  assert.equal(buildGlobalEvents(regions, new Map(), live).length, 3);
});

test("visibleEvents is (start, end], applies the magnitude floor, and always keeps the selected region's events", () => {
  const all = buildGlobalEvents(regions, new Map([["california", ca]]), live);
  const times = timesOf(all);
  const win = [ca.t0 - 1, ca.t1];
  const strict = visibleEvents(all, times, ...win, { minMag: 99 });
  assert.equal(strict.length, 0);
  const sel = visibleEvents(all, times, ...win, { minMag: 99, selectedId: "california" });
  assert.equal(sel.length, ca.events.length);
  const floor = visibleEvents(all, times, ...win, { minMag: 5 });
  assert.ok(floor.every((e) => e.mag >= 5) && floor.length >= 2);
  assert.deepEqual(visibleEvents(all, times, ca.t1 + 1, ca.t1 + 2), []);
});

test("globalRange is the union of result ranges, or the last year without results", () => {
  assert.deepEqual(globalRange(new Map([["california", ca]])), { t0: ca.t0, t1: ca.t1 });
  const r = globalRange(new Map(), 1_000_000_000_000);
  assert.equal(r.t1 - r.t0, 365 * 86_400_000);
});
