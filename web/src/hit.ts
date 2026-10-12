// Point -> deepest laid-out node. Descends from the layout root through
// the child whose rect contains the point; siblings never overlap, so at
// most one child matches per level. Bounded by the tree depth.

import { assert } from "./assert.ts";
import { NodeKind, type Tree } from "./decode.ts";
import { type Layout, LayoutFlag } from "./layout.ts";
import type { TreeIndex } from "./model.ts";

export const NO_NODE = -1;

function rectContains(layout: Layout, node: number, x: number, y: number): boolean {
  const offset = node * 4;
  const left = layout.rects[offset] ?? 0;
  const top = layout.rects[offset + 1] ?? 0;
  return x >= left && y >= top && x < left + (layout.rects[offset + 2] ?? 0) && y < top + (layout.rects[offset + 3] ?? 0);
}

export function hitTest(tree: Tree, index: TreeIndex, layout: Layout, x: number, y: number): number {
  if (layout.drawCount === 0) return NO_NODE;
  let node = layout.rootNode;
  if (!rectContains(layout, node, x, y)) return NO_NODE;
  for (let depth = 0; depth < tree.nodeCount; depth++) {
    if (((layout.flags[node] ?? 0) & LayoutFlag.open) === 0) return node;
    const child = childAt(index, layout, node, x, y);
    if (child === NO_NODE) return node;
    node = child;
  }
  assert(false, "hit test descended deeper than the tree");
}

function childAt(index: TreeIndex, layout: Layout, node: number, x: number, y: number): number {
  const end = index.childStart[node + 1] ?? 0;
  for (let cursor = index.childStart[node] ?? 0; cursor < end; cursor++) {
    const child = index.childIndices[cursor] ?? 0;
    if (((layout.flags[child] ?? 0) & LayoutFlag.laidOut) === 0) continue;
    if (rectContains(layout, child, x, y)) return child;
  }
  return NO_NODE;
}

/**
 * True when the point is on a directory's frame (header strip or padding)
 * rather than on one of its tiles: that is where a click zooms in.
 */
export function isDirectoryFrameHit(tree: Tree, layout: Layout, node: number): boolean {
  if (node === NO_NODE) return false;
  if (node === layout.rootNode) return false;
  return tree.kinds[node] === NodeKind.directory;
}
