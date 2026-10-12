// Methodology: place a 200×100 box in a 1000×800 viewport near each edge
// and corner, and check it opens toward the room it has, never crosses the
// margin, and never covers the point it opened at.

import { test } from "node:test";
import assert from "node:assert/strict";
import { placeAtPoint, placeBelow, VIEWPORT_MARGIN_PX } from "./placement.ts";

const SIZE = { width: 200, height: 100 };
const VIEWPORT = { width: 1000, height: 800 };
const GAP = 2;

test("a menu opens below and to the right of the point when it fits", () => {
  assert.deepEqual(placeAtPoint({ x: 100, y: 100 }, SIZE, VIEWPORT, GAP), { x: 102, y: 102 });
});

test("a menu near the right or bottom edge flips to the other side of the point", () => {
  assert.deepEqual(placeAtPoint({ x: 900, y: 100 }, SIZE, VIEWPORT, GAP), { x: 698, y: 102 });
  assert.deepEqual(placeAtPoint({ x: 100, y: 750 }, SIZE, VIEWPORT, GAP), { x: 102, y: 648 });
  assert.deepEqual(placeAtPoint({ x: 990, y: 790 }, SIZE, VIEWPORT, GAP), { x: 788, y: 688 });
});

test("the point is never under the menu, so the click that ends a touch misses it", () => {
  for (const point of [{ x: 10, y: 10 }, { x: 500, y: 400 }, { x: 995, y: 795 }, { x: 150, y: 790 }]) {
    const corner = placeAtPoint(point, SIZE, VIEWPORT, GAP);
    const insideX = point.x >= corner.x && point.x < corner.x + SIZE.width;
    const insideY = point.y >= corner.y && point.y < corner.y + SIZE.height;
    assert.ok(!(insideX && insideY), `point ${point.x},${point.y}`);
  }
});

test("a box never crosses the margin, even when the viewport is too small for it", () => {
  const tiny = { width: 150, height: 60 };
  assert.deepEqual(placeAtPoint({ x: 3, y: 3 }, SIZE, tiny, GAP), { x: VIEWPORT_MARGIN_PX, y: VIEWPORT_MARGIN_PX });
  assert.deepEqual(placeBelow({ left: 0, top: 0, right: 10, bottom: 10 }, SIZE, tiny, GAP), { x: VIEWPORT_MARGIN_PX, y: VIEWPORT_MARGIN_PX });
});

test("a tooltip sits under its control, moves above it only when that side has room, and slides in from the right edge", () => {
  const control = { left: 300, top: 40, right: 360, bottom: 68 };
  assert.deepEqual(placeBelow(control, SIZE, VIEWPORT, 6), { x: 300, y: 74 });
  const low = { left: 300, top: 720, right: 360, bottom: 748 };
  assert.deepEqual(placeBelow(low, SIZE, VIEWPORT, 6), { x: 300, y: 614 });
  const right = { left: 950, top: 40, right: 990, bottom: 68 };
  assert.deepEqual(placeBelow(right, SIZE, VIEWPORT, 6), { x: 1000 - VIEWPORT_MARGIN_PX - 200, y: 74 });
});
