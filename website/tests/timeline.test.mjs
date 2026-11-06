import assert from "node:assert/strict";
import test from "node:test";
import { histogram, indexAtOrBefore, scrollCursor, timeToX, wheelToFraction, xToTime } from "../src/timeline.js";

test("histogram bins events and ignores those outside the range", () => {
  assert.deepEqual(histogram([0, 1, 5, 9, 10, 11, -1], 0, 10, 5), [2, 0, 1, 0, 2]);
  assert.deepEqual(histogram([1, 2], 5, 5, 3), [0, 0, 0]);
});

test("x <-> time mapping round-trips and clamps", () => {
  assert.equal(xToTime(50, 100, 1000, 2000), 1500);
  assert.equal(xToTime(-20, 100, 1000, 2000), 1000);
  assert.equal(xToTime(500, 100, 1000, 2000), 2000);
  assert.equal(timeToX(1500, 100, 1000, 2000), 50);
});

test("indexAtOrBefore", () => {
  const a = [10, 20, 20, 30];
  assert.equal(indexAtOrBefore(a, 5), -1);
  assert.equal(indexAtOrBefore(a, 10), 0);
  assert.equal(indexAtOrBefore(a, 25), 2);
  assert.equal(indexAtOrBefore(a, 99), 3);
  assert.equal(indexAtOrBefore([], 1), -1);
});

test("wheel scrolls forward on scroll-down, backward on scroll-up, with coarse and fine modifiers", () => {
  assert.ok(wheelToFraction({ deltaY: 100 }) > 0);
  assert.ok(wheelToFraction({ deltaY: -100 }) < 0);
  assert.equal(wheelToFraction({ deltaY: 100, shiftKey: true }), 5 * wheelToFraction({ deltaY: 100 }));
  assert.ok(Math.abs(wheelToFraction({ deltaY: 100, altKey: true }) - 0.2 * wheelToFraction({ deltaY: 100 })) < 1e-12);
  assert.equal(wheelToFraction({ deltaY: 3, deltaMode: 1 }), wheelToFraction({ deltaY: 48 }));   // line mode
  assert.equal(wheelToFraction({ deltaY: 0, deltaX: 100, shiftKey: true }), 5 * wheelToFraction({ deltaY: 100 })); // horizontal wheel
  assert.equal(wheelToFraction({ deltaY: 2000 }), 1);
});

test("scrolling never leaves the time range", () => {
  assert.equal(scrollCursor(900, 0.5, 0, 1000), 1000);
  assert.equal(scrollCursor(100, -0.5, 0, 1000), 0);
  assert.equal(scrollCursor(500, 0.1, 0, 1000), 600);
});
