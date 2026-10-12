// Methodology: the window is plain arithmetic over pixels, so check it at
// the edges that matter: the top and bottom of the list, a list shorter
// than the view, a view between rows, and a list out of view.

import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleRowRange } from "./virtual-rows.ts";

const ROW = 32;

test("the window covers the visible rows and ten more on each side, within the list", () => {
  assert.deepEqual(visibleRowRange(0, 320, ROW, 1000), { start: 0, end: 20 }, "no rows above the first");
  assert.deepEqual(visibleRowRange(3200, 3520, ROW, 1000), { start: 90, end: 120 });
  assert.deepEqual(visibleRowRange(31_680, 32_000, ROW, 1000), { start: 980, end: 1000 }, "no rows past the last");
  assert.deepEqual(visibleRowRange(0, 320, ROW, 4), { start: 0, end: 4 }, "a short list renders whole");
});

test("a row cut by either edge of the view counts as visible", () => {
  assert.deepEqual(visibleRowRange(3216, 3240, ROW, 1000), { start: 90, end: 112 });
});

test("nothing renders when the list is out of view, scrolled past, or empty", () => {
  assert.deepEqual(visibleRowRange(-900, -600, ROW, 1000), { start: 0, end: 0 }, "the list starts below the view");
  assert.deepEqual(visibleRowRange(40_000, 40_300, ROW, 1000), { start: 0, end: 0 }, "the list ended above the view");
  assert.deepEqual(visibleRowRange(300, 300, ROW, 1000), { start: 0, end: 0 }, "a view with no height");
  assert.deepEqual(visibleRowRange(0, 320, ROW, 0), { start: 0, end: 0 });
});
