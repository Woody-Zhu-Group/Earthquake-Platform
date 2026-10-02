import assert from "node:assert/strict";
import test from "node:test";
import { contourSegments, countRegions, kernelGrid, rampColor } from "../src/kernels.js";
import { wheelDelta, wheelToUnits } from "../src/timeline.js";

test("kernelGrid: one point gives a Gaussian bump centred on it with the right mass", () => {
  const sigma = 12, cell = 2;
  const { grid, cols, rows, max } = kernelGrid([{ x: 100, y: 60, w: 3 }], { width: 200, height: 120, cell, sigma });
  let sum = 0, bi = 0;
  for (let k = 0; k < grid.length; k++) { sum += grid[k]; if (grid[k] > grid[bi]) bi = k; }
  assert.ok(Math.abs(((bi % cols) + 0.5) * cell - 100) <= cell && Math.abs((Math.floor(bi / cols) + 0.5) * cell - 60) <= cell);
  assert.ok(Math.abs(max - 3) < 0.05, `peak ${max}`);
  const mass = sum * cell * cell, expected = 3 * 2 * Math.PI * sigma * sigma;
  assert.ok(Math.abs(mass / expected - 1) < 0.03, `mass ${mass} vs ${expected}`);
  assert.equal(rows, 60);
});

test("kernelGrid: weights add, non-positive / non-finite points are ignored", () => {
  const a = kernelGrid([{ x: 20, y: 20, w: 1 }, { x: 20, y: 20, w: 2 }, { x: 5, y: 5, w: 0 }, { x: NaN, y: 1, w: 1 }], { width: 40, height: 40, cell: 2, sigma: 4 });
  const b = kernelGrid([{ x: 20, y: 20, w: 3 }], { width: 40, height: 40, cell: 2, sigma: 4 });
  assert.ok(Math.abs(a.max - b.max) < 1e-5);
});

test("contour of a single blob is one closed loop at about the expected radius; two blobs = two regions", () => {
  const sigma = 15, cell = 2;
  const one = kernelGrid([{ x: 100, y: 100, w: 1 }], { width: 200, height: 200, cell, sigma });
  const level = 0.5 * one.max;
  const segs = contourSegments(one.grid, one.cols, one.rows, level);
  const expectedR = sigma * Math.sqrt(2 * Math.log(2)); // where a unit Gaussian crosses 0.5
  for (const [x1, y1, x2, y2] of segs) {
    for (const [x, y] of [[x1, y1], [x2, y2]]) {
      const r = Math.hypot((x + 0.5) * cell - 100, (y + 0.5) * cell - 100);
      assert.ok(Math.abs(r - expectedR) < 2 * cell, `contour point at r=${r}, expected ${expectedR}`);
    }
  }
  assert.ok(segs.length > 20);
  assert.equal(countRegions(one.grid, one.cols, one.rows, level), 1);

  const two = kernelGrid([{ x: 50, y: 50, w: 1 }, { x: 150, y: 150, w: 1 }], { width: 200, height: 200, cell, sigma });
  assert.equal(countRegions(two.grid, two.cols, two.rows, 0.5 * two.max), 2);
  const none = kernelGrid([], { width: 20, height: 20, cell, sigma });
  assert.equal(none.max, 0);
});

test("rampColor interpolates between stops and clamps", () => {
  const ramp = [[0, [0, 0, 0, 0]], [1, [100, 200, 50, 1]]];
  assert.deepEqual(rampColor(ramp, 0.5), [50, 100, 25, 0.5]);
  assert.deepEqual(rampColor(ramp, -1), [0, 0, 0, 0]);
  assert.deepEqual(rampColor(ramp, 2), [100, 200, 50, 1]);
});

test("wheel scrubbing: dominant axis, line mode, Shift = coarse, Alt = fine", () => {
  assert.equal(wheelDelta({ deltaX: 0, deltaY: 100, deltaMode: 0 }), 100);
  assert.equal(wheelDelta({ deltaX: -40, deltaY: 5, deltaMode: 0 }), -40); // trackpad swipe
  assert.equal(wheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }), 48);    // lines -> px
  assert.equal(wheelToUnits({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: false, altKey: false }), 8);
  assert.equal(wheelToUnits({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: true, altKey: false }), 40);
  assert.ok(Math.abs(wheelToUnits({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: false, altKey: true }) - 1.6) < 1e-12);
});
