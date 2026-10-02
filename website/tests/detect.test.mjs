import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cusum, generateGriddedPoints, inOmega, SpatioTemporalDetector as D } from "../src/detect.js";
import { ScoreModel, mulberry32, toFlat } from "../src/score.js";

const fx = JSON.parse(readFileSync(new URL("../../tests/fixtures/expected_score.json", import.meta.url), "utf8"));
const close = (a, b, msg, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const pairs = (flat) => Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]]);
const sortPairs = (p) => p.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);

test("cusum = max suffix sum, arg = earliest index of the maximum", () => {
  assert.deepEqual(cusum([1, -5, 2, 2]), { value: 4, index: 2 });
  assert.deepEqual(cusum([3, -3, 3]), { value: 3, index: 0 }); // tie between index 0 and 2: numpy argmax takes 0
  assert.deepEqual(cusum([-1, -2]), { value: -2, index: 1 });
});

test("gridded points match np.meshgrid layout", () => {
  const p = generateGriddedPoints(3);
  assert.deepEqual(Array.from(p), [0, 0, 0.5, 0, 1, 0, 0, 0.5, 0.5, 0.5, 1, 0.5, 0, 1, 0.5, 1, 1, 1]);
});

test("inner_event / inner_grid / outer match detect.py on every committed case", () => {
  for (const d of fx.detect) {
    const data = toFlat(d.data), measure = Float64Array.from(d.measure);
    for (const c of d.cases) {
      const og = D.innerGrid(data, measure, c.tau, d.nres, c.t);
      assert.deepEqual(sortPairs(pairs(og)), sortPairs(c.omega_grid), `grid omega tau=${c.tau} t=${c.t}`);
      const oe = D.innerEvent(data, measure, c.tau, c.t);
      assert.deepEqual(pairs(oe), c.omega_event, `event omega tau=${c.tau} t=${c.t}`);

      const rg = D.outer(data, measure, og, 1 / (2 * (d.nres - 1)), c.t);
      close(rg.tau, c.outer_grid[0], "grid tau"); close(rg.stat, c.outer_grid[1], "grid stat");
      const re = oe.length ? D.outer(data, measure, oe, d.radius, c.t) : { tau: c.t, stat: 0 };
      close(re.tau, c.outer_event[0], "event tau"); close(re.stat, c.outer_event[1], "event stat");
    }
  }
});

test("inOmega uses a strict Chebyshev radius", () => {
  const data = Float64Array.from([0, 0.5, 0.5, 1, 0.625, 0.5, 2, 0.75, 0.5, 3, 0.5, 0.875]);
  const mask = inOmega(data, 4, Float64Array.from([0.5, 0.5]), 0.25); // binary-exact distances: 0, 0.125, 0.25, 0.375
  assert.deepEqual(Array.from(mask), [1, 1, 0, 0]); // exactly 0.25 away is excluded (strict <), as in detect.py
});

// ---- end-to-end on synthetic spatio-temporal change data (the simulator's setting) ----------------------
function makeData(rng, { n0, extra, nu, centers, rad }) {
  const rows = [];
  for (let i = 0; i < n0; i++) rows.push([rng(), rng(), rng()]);
  for (const c of centers) for (let i = 0; i < extra; i++) rows.push([nu + (1 - nu) * rng(), c[0] + rad * (2 * rng() - 1), c[1] + rad * (2 * rng() - 1)]);
  rows.sort((a, b) => a[0] - b[0]);
  return toFlat(rows);
}

test("online detector finds the change point and the change region on synthetic data", () => {
  const rng = mulberry32(7), rad = 0.1;
  const centers = [[0.5, 0.5], [0.7, 0.5], [0.3, 0.5], [0.5, 0.3], [0.5, 0.7]];
  const pre = makeData(rng, { n0: 2000, extra: 0, nu: 1, centers, rad });
  // hot squares at ~3x the background rate. (Much stronger changes push local time gaps far below the DSM noise
  // level sigma = 0.1 that score.py uses, where the learned score no longer discriminates; see website/README.md.)
  const test_ = makeData(rng, { n0: 2000, extra: 120, nu: 0.5, centers, rad });
  const f0 = new ScoreModel({ radius: 0.1, seed: 1 }), f1 = new ScoreModel({ radius: 0.1, seed: 2 });
  f0.fit(pre, { nEpochs: 60 });
  const res = new D(f0, f1).online(test_, { ntt: 100, K: 3, nUpdate: 10, radius: 0.05, fitKwds: { nEpochs: 20 } });

  const n = res.tt.length, half = res.tt.findIndex((t) => t >= 0.5);
  const pre_max = Math.max(...res.statList.slice(0, half));
  const post_max = Math.max(...res.statList.slice(half));
  assert.ok(post_max > 2 * pre_max, `statistic should jump after the change: pre ${pre_max} post ${post_max}`);

  const iPeak = res.statList.indexOf(post_max);
  assert.ok(Math.abs(res.tauList[iPeak] - 0.5) < 0.1, `tau ${res.tauList[iPeak]} should be near the true change point 0.5`);

  // the estimated change region at the peak concentrates on the five hot squares
  const om = pairs(res.omegaList[iPeak]);
  const hot = om.filter(([x, y]) => centers.some((c) => Math.abs(x - c[0]) <= rad + 0.02 && Math.abs(y - c[1]) <= rad + 0.02)).length;
  assert.ok(hot / om.length > 0.5, `only ${hot}/${om.length} omega points fall in the hot squares`);
});
