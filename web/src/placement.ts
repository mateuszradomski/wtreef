// Where floating things go: a menu opens at a point, a tooltip under its
// control. Both flip to stay inside the viewport and keep a margin from its
// edges. Pure, so the flipping is tested without a DOM.

import { assert } from "./assert.ts";

export const VIEWPORT_MARGIN_PX = 8;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Top-left corner for a box opening at `point`, `gap` pixels below and to
 * the right of it; flipped to the left or above when it would cross that
 * edge. The gap keeps the pointer off the box: the click that ends a touch
 * lands where the finger was, and must not land on an item.
 */
export function placeAtPoint(point: Point, size: Size, viewport: Size, gap: number): Point {
  assert(gap >= 0, "the gap is a distance");
  let x = point.x + gap;
  let y = point.y + gap;
  if (x + size.width > viewport.width - VIEWPORT_MARGIN_PX) x = point.x - gap - size.width;
  if (y + size.height > viewport.height - VIEWPORT_MARGIN_PX) y = point.y - gap - size.height;
  return clampToViewport({ x, y }, size, viewport);
}

/** Top-left corner for a box under `anchor`, left-aligned with it; above it when only that side has room. */
export function placeBelow(anchor: Box, size: Size, viewport: Size, gap: number): Point {
  assert(anchor.right >= anchor.left, "the anchor has a width");
  assert(anchor.bottom >= anchor.top, "the anchor has a height");
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  const fitsBelow = below + size.height <= viewport.height - VIEWPORT_MARGIN_PX;
  const fitsAbove = above >= VIEWPORT_MARGIN_PX;
  const y = !fitsBelow && fitsAbove ? above : below;
  return clampToViewport({ x: anchor.left, y }, size, viewport);
}

/** Keeps the margin on every side; a box larger than the viewport keeps its top-left corner in view. */
function clampToViewport(point: Point, size: Size, viewport: Size): Point {
  const xMax = Math.max(VIEWPORT_MARGIN_PX, viewport.width - VIEWPORT_MARGIN_PX - size.width);
  const yMax = Math.max(VIEWPORT_MARGIN_PX, viewport.height - VIEWPORT_MARGIN_PX - size.height);
  const x = Math.round(Math.min(Math.max(point.x, VIEWPORT_MARGIN_PX), xMax));
  const y = Math.round(Math.min(Math.max(point.y, VIEWPORT_MARGIN_PX), yMax));
  assert(x >= VIEWPORT_MARGIN_PX, "the box starts inside the margin");
  assert(y >= VIEWPORT_MARGIN_PX, "the box starts inside the margin");
  return { x, y };
}
