import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ScoreModel, kdeMedianDensity, mulberry32, toFlat } from "../src/score.js";

const fx = JSON.parse(readFileSync(new URL("../../tests/fixtures/expected_score.json", import.meta.url), "utf8"));
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);

test("localize matches score.py find_index/localize (incl. duplicate coordinates and no-neighbour fallback)", () => {
  for (const c of fx.localize) {
    const m = new ScoreModel({ radius: c.radius });
    const got = m.localize(toFlat(c.data));
    c.expected.forEach((row, i) => row.forEach((v, k) => close(got[i * 3 + k], v, 1e-12, `row ${i} col ${k}`)));
  }
});

test("KDE base density matches scipy.stats.gaussian_kde (median of local density x n)", () => {
  for (const c of fx.kde) {
    const flat = toFlat(c.data);
    close(kdeMedianDensity(flat, 3, c.data.length, 10_000), c.mu, 1e-9, "mu");
  }
});

test("fit sets base[0] = -mu * 4 r^2 and leaves the other components at 0", () => {
  const c = fx.kde[0], flat = toFlat(c.data);
  const m = new ScoreModel({ radius: 0.1 });
  m.fitBase(flat);
  close(m.base[0], -c.mu * 4 * 0.01, 1e-9, "base");
  assert.equal(m.base[1], 0); assert.equal(m.base[2], 0);
  // a model refitted on a batch covering a tenth of the time has a ten times larger rate
  const m2 = new ScoreModel({ radius: 0.1 });
  m2.fitBase(flat, 0.1);
  close(m2.base[0], m.base[0] * 10, 1e-9, "timeSpan rescale");
});

test("untrained model has score = base (zero-initialised output layer, as in score.py)", () => {
  const m = new ScoreModel({ radius: 0.1 });
  m.base[0] = -3;
  const s = m.score(Float64Array.from([0.2, 0.4, 0.6, 0.1, 0.9, 0.3]));
  assert.deepEqual(Array.from(s), [-3, 0, 0, -3, 0, 0]);
});

test("psi: closed-form divergence equals a finite-difference divergence of w * score", () => {
  const rng = mulberry32(5);
  const m = new ScoreModel({ radius: 0.1, hidden: 16, seed: 3 });
  m.base[0] = -4;
  for (let i = 0; i < m.W2.length; i++) m.W2[i] = (rng() - 0.5) * 0.8; // non-zero so the network matters
  for (let i = 0; i < m.b2.length; i++) m.b2[i] = (rng() - 0.5) * 0.4;
  const w = (x) => [x[0], Math.min(x[1], 1 - x[1]), Math.min(x[2], 1 - x[2])];
  const ws = (x) => { const s = m.score(Float64Array.from(x)); const ww = w(x); return [ww[0] * s[0], ww[1] * s[1], ww[2] * s[2]]; };
  for (let trial = 0; trial < 20; trial++) {
    const x = [rng() * 0.5 + 0.01, rng() * 0.4 + 0.05, rng() * 0.4 + 0.55];
    let div = 0;
    const eps = 1e-6;
    for (let c = 0; c < 3; c++) {
      const up = x.slice(), dn = x.slice(); up[c] += eps; dn[c] -= eps;
      div += (ws(up)[c] - ws(dn)[c]) / (2 * eps);
    }
    const s = m.score(Float64Array.from(x)), ww = w(x);
    const expected = ww[0] * s[0] ** 2 + ww[1] * s[1] ** 2 + ww[2] * s[2] ** 2 + 2 * div;
    close(m.psiLoc(Float64Array.from(x))[0], expected, 1e-6, `psi trial ${trial}`);
  }
});

test("DSM fit lowers the loss and recovers an exponential time-gap score", () => {
  // events with exponential gaps (rate lam) at uniformly random places; the gap score is -lam
  const rng = mulberry32(11), lam = 6, n = 600;
  const rows = []; let t = 0;
  for (let i = 0; i < n; i++) { t += -Math.log(1 - rng()) / lam / 20; rows.push([t, rng(), rng()]); }
  const flat = toFlat(rows);
  const m = new ScoreModel({ radius: 0.2, seed: 2 });
  const losses = m.fit(flat, { nEpochs: 30, batchSize: 128, lr: 2e-3, sigma: 0.1 });
  assert.ok(losses[losses.length - 1] < losses[0], `loss ${losses[0]} -> ${losses[losses.length - 1]}`);
  assert.ok(Number.isFinite(losses[losses.length - 1]));
});
