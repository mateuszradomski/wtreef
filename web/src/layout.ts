// Nested squarified treemap (Bruls, Huizing, van Wijk 2000), iterative.
// Directories are visited breadth-first through the draw order itself,
// which doubles as the work queue: every node is enqueued at most once, so
// the loop is bounded by the node count. All buffers are allocated once per
// tree in createLayout and reused across relayouts.

import { assert } from "./assert.ts";
import { NodeKind, type Tree } from "./decode.ts";
import type { TreeIndex } from "./model.ts";

export const LAYOUT = {
  // Every nesting level pays padding + header, and real PRs nest eight deep;
  // 13px a level keeps deep chains from eating the map.
  headerHeight: 12,
  padding: 1,
  gap: 1,
  /** Frames smaller than this get no header strip, so labels never clip. */
  headerWidthMin: 48,
  headerHeightMin: 40,
  /** Tiles thinner than this are not laid out; they would be invisible anyway. */
  tileSideMin: 2,
} as const;

export const LayoutFlag = {
  laidOut: 1,
  header: 2,
  /** A directory whose children were laid out; without it a directory draws as a summary tile. */
  open: 4,
  /**
   * The only visible child of its directory and itself a directory: it fills
   * the parent's content box with no frame or header of its own, and the
   * parent's header names the whole chain ("pages/blobs/components").
   */
  chained: 8,
} as const;

export const NO_CHAIN = -1;

export interface Layout {
  /** x, y, width, height per node in CSS pixels; meaningful only where `laidOut` is set. */
  readonly rects: Float32Array;
  readonly flags: Uint8Array;
  /** The chained child of each node, or NO_CHAIN. */
  readonly chainChild: Int32Array;
  /** Nodes in paint order: parents before children. */
  readonly drawOrder: Uint32Array;
  drawCount: number;
  rootNode: number;
  width: number;
  height: number;
  // Scratch space for one directory's children, reused for every directory.
  readonly scratchNodes: Uint32Array;
  readonly scratchAreas: Float64Array;
  readonly scratchRects: Float64Array;
}

export function createLayout(nodeCount: number): Layout {
  assert(nodeCount >= 1, "a tree has at least a root");
  return {
    rects: new Float32Array(nodeCount * 4),
    flags: new Uint8Array(nodeCount),
    chainChild: new Int32Array(nodeCount).fill(NO_CHAIN),
    drawOrder: new Uint32Array(nodeCount),
    drawCount: 0,
    rootNode: 0,
    width: 0,
    height: 0,
    scratchNodes: new Uint32Array(nodeCount),
    scratchAreas: new Float64Array(nodeCount),
    scratchRects: new Float64Array(nodeCount * 4),
  };
}

export function computeLayout(
  tree: Tree,
  index: TreeIndex,
  weights: Float64Array,
  rootNode: number,
  width: number,
  height: number,
  layout: Layout,
): void {
  assert(layout.flags.length === tree.nodeCount, "layout must be sized for this tree");
  assert(weights.length === tree.nodeCount, "weights must be sized for this tree");
  assert(tree.kinds[rootNode] === NodeKind.directory, "layout root must be a directory");
  layout.flags.fill(0);
  layout.chainChild.fill(NO_CHAIN);
  layout.drawCount = 0;
  layout.rootNode = rootNode;
  layout.width = width;
  layout.height = height;
  if ((weights[rootNode] ?? 0) <= 0) return;
  if (width < LAYOUT.tileSideMin || height < LAYOUT.tileSideMin) return;

  setRect(layout, rootNode, 0, 0, Math.floor(width), Math.floor(height));
  layout.flags[rootNode] = LayoutFlag.laidOut;
  layout.drawOrder[layout.drawCount++] = rootNode;
  for (let head = 0; head < layout.drawCount; head++) {
    const node = layout.drawOrder[head] ?? 0;
    if (tree.kinds[node] !== NodeKind.directory) continue;
    layoutDirectory(tree, index, weights, node, node === rootNode, layout);
  }
  assert(layout.drawCount <= tree.nodeCount, "each node is laid out at most once");
}

function setRect(layout: Layout, node: number, x: number, y: number, width: number, height: number): void {
  const offset = node * 4;
  layout.rects[offset] = x;
  layout.rects[offset + 1] = y;
  layout.rects[offset + 2] = width;
  layout.rects[offset + 3] = height;
}

function layoutDirectory(
  tree: Tree,
  index: TreeIndex,
  weights: Float64Array,
  node: number,
  isRoot: boolean,
  layout: Layout,
): void {
  const offset = node * 4;
  const x = layout.rects[offset] ?? 0;
  const y = layout.rects[offset + 1] ?? 0;
  const width = layout.rects[offset + 2] ?? 0;
  const height = layout.rects[offset + 3] ?? 0;
  const isChained = ((layout.flags[node] ?? 0) & LayoutFlag.chained) !== 0;
  const hasHeader = !isRoot && !isChained && width >= LAYOUT.headerWidthMin && height >= LAYOUT.headerHeightMin
    && isTileGroup(tree, index, weights, node);
  if (hasHeader) layout.flags[node]! |= LayoutFlag.header;

  // A chained directory already sits inside its parent's padding.
  const padding = isChained ? 0 : LAYOUT.padding;
  const top = y + padding + (hasHeader ? LAYOUT.headerHeight : 0);
  const left = x + padding;
  // The gap trails each child, so the content box grows by one gap and the
  // last row's trailing gap falls outside it.
  const contentWidth = width - 2 * padding + LAYOUT.gap;
  const contentHeight = y + height - padding - top + LAYOUT.gap;
  if (contentWidth < LAYOUT.tileSideMin + LAYOUT.gap || contentHeight < LAYOUT.tileSideMin + LAYOUT.gap) return;

  const count = collectChildren(index, weights, node, layout);
  if (count === 0) return;
  const total = weights[node] ?? 0;
  assert(total > 0, "a directory with weighted children has weight");
  const scale = (contentWidth * contentHeight) / total;
  for (let child = 0; child < count; child++) {
    layout.scratchAreas[child] = (weights[layout.scratchNodes[child] ?? 0] ?? 0) * scale;
  }
  squarify(layout.scratchAreas, count, left, top, contentWidth, contentHeight, layout.scratchRects);

  layout.flags[node]! |= LayoutFlag.open;
  for (let child = 0; child < count; child++) {
    placeChild(layout, layout.scratchNodes[child] ?? 0, child);
  }
  // The root has no header to carry a chain's name, so its children keep their own.
  const onlyChild = layout.scratchNodes[0] ?? 0;
  const onlyChildPlaced = ((layout.flags[onlyChild] ?? 0) & LayoutFlag.laidOut) !== 0;
  if (!isRoot && count === 1 && onlyChildPlaced && tree.kinds[onlyChild] === NodeKind.directory) {
    layout.flags[onlyChild]! |= LayoutFlag.chained;
    layout.chainChild[node] = onlyChild;
  }
}

/** Only the innermost groups need a label; structural ancestors consume no header rows.
 * Single-child directory chains count as one group, named by their shared header.
 */
function isTileGroup(tree: Tree, index: TreeIndex, weights: Float64Array, node: number): boolean {
  let current = node;
  for (let depth = 0; depth < tree.nodeCount; depth++) {
    let children = 0;
    let directories = 0;
    let directory = 0;
    for (let cursor = index.childStart[current] ?? 0; cursor < (index.childStart[current + 1] ?? 0); cursor++) {
      const child = index.childIndices[cursor] ?? 0;
      if ((weights[child] ?? 0) <= 0) continue;
      children++;
      if (tree.kinds[child] === NodeKind.directory) {
        directories++;
        directory = child;
      }
    }
    if (directories === 0) return children > 0;
    if (children !== 1) return false;
    current = directory;
  }
  assert(false, "directory chains are bounded by tree depth");
}

/** The deepest directory of the chain starting at `node` (itself when unchained). */
export function chainEnd(layout: Layout, node: number): number {
  let current = node;
  for (let depth = 0; depth < layout.chainChild.length; depth++) {
    const next = layout.chainChild[current] ?? NO_CHAIN;
    if (next === NO_CHAIN) return current;
    current = next;
  }
  assert(false, "chains are bounded by the tree depth");
}

/** The directory whose frame and header draw the chain that `node` belongs to. */
export function chainTop(tree: Tree, layout: Layout, node: number): number {
  let current = node;
  for (let depth = 0; depth < layout.chainChild.length; depth++) {
    if (((layout.flags[current] ?? 0) & LayoutFlag.chained) === 0) return current;
    current = tree.parents[current] ?? 0;
  }
  assert(false, "chains are bounded by the tree depth");
}

/** Writes the children with positive weight into scratchNodes, heaviest first. */
function collectChildren(index: TreeIndex, weights: Float64Array, node: number, layout: Layout): number {
  const start = index.childStart[node] ?? 0;
  const end = index.childStart[node + 1] ?? 0;
  let count = 0;
  for (let cursor = start; cursor < end; cursor++) {
    const child = index.childIndices[cursor] ?? 0;
    if ((weights[child] ?? 0) > 0) layout.scratchNodes[count++] = child;
  }
  // Heaviest first is what makes squarify's greedy rows work; the index
  // tiebreak keeps the layout deterministic.
  layout.scratchNodes
    .subarray(0, count)
    .sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0) || a - b);
  return count;
}

/** Snaps a squarified rect to whole pixels, removes the trailing gap, and keeps it if visible. */
function placeChild(layout: Layout, node: number, slot: number): void {
  const offset = slot * 4;
  const rawX = layout.scratchRects[offset] ?? 0;
  const rawY = layout.scratchRects[offset + 1] ?? 0;
  // Neighbors share float edges, so rounding both edges keeps them adjacent.
  const x = Math.round(rawX);
  const y = Math.round(rawY);
  const width = Math.round(rawX + (layout.scratchRects[offset + 2] ?? 0)) - x - LAYOUT.gap;
  const height = Math.round(rawY + (layout.scratchRects[offset + 3] ?? 0)) - y - LAYOUT.gap;
  if (width < LAYOUT.tileSideMin || height < LAYOUT.tileSideMin) return;
  setRect(layout, node, x, y, width, height);
  layout.flags[node] = LayoutFlag.laidOut;
  layout.drawOrder[layout.drawCount++] = node;
}

/**
 * Lays `count` areas (sorted descending, summing to width × height) into
 * the rectangle, writing x, y, width, height per area into `rects`. Each
 * row is grown greedily along the shorter side while the worst aspect
 * ratio in it keeps improving.
 */
export function squarify(
  areas: Float64Array,
  count: number,
  x: number,
  y: number,
  width: number,
  height: number,
  rects: Float64Array,
): void {
  assert(count <= areas.length, "areas must hold every item");
  assert(rects.length >= count * 4, "rects must hold every item");
  let start = 0;
  let remainingX = x;
  let remainingY = y;
  let remainingWidth = width;
  let remainingHeight = height;
  while (start < count) {
    const side = Math.min(remainingWidth, remainingHeight);
    const end = growRow(areas, start, count, side);
    assert(end > start, "every row takes at least one item");
    const rowArea = sumAreas(areas, start, end);
    const isLastRow = end === count;
    if (remainingWidth >= remainingHeight) {
      const thickness = isLastRow ? remainingWidth : rowArea / remainingHeight;
      placeRow(areas, start, end, rects, remainingX, remainingY, thickness, remainingHeight, true);
      remainingX += thickness;
      remainingWidth -= thickness;
    } else {
      const thickness = isLastRow ? remainingHeight : rowArea / remainingWidth;
      placeRow(areas, start, end, rects, remainingX, remainingY, remainingWidth, thickness, false);
      remainingY += thickness;
      remainingHeight -= thickness;
    }
    start = end;
  }
}

/** Returns the end (exclusive) of the row starting at `start` with the best worst-aspect ratio. */
function growRow(areas: Float64Array, start: number, count: number, side: number): number {
  let end = start;
  let rowArea = 0;
  let rowMin = Number.POSITIVE_INFINITY;
  let rowMax = 0;
  let worst = Number.POSITIVE_INFINITY;
  while (end < count) {
    const area = areas[end] ?? 0;
    const nextArea = rowArea + area;
    const nextMin = Math.min(rowMin, area);
    const nextMax = Math.max(rowMax, area);
    const nextWorst = worstAspectRatio(nextArea, nextMin, nextMax, side);
    if (end > start && nextWorst > worst) break;
    rowArea = nextArea;
    rowMin = nextMin;
    rowMax = nextMax;
    worst = nextWorst;
    end++;
  }
  return end;
}

function worstAspectRatio(rowArea: number, rowMin: number, rowMax: number, side: number): number {
  const sideSquared = side * side;
  const rowAreaSquared = rowArea * rowArea;
  return Math.max((sideSquared * rowMax) / rowAreaSquared, rowAreaSquared / (sideSquared * rowMin));
}

function sumAreas(areas: Float64Array, start: number, end: number): number {
  let sum = 0;
  for (let item = start; item < end; item++) sum += areas[item] ?? 0;
  return sum;
}

/** Stacks one row; the last item takes the remainder so float error never leaves a seam. */
function placeRow(
  areas: Float64Array,
  start: number,
  end: number,
  rects: Float64Array,
  x: number,
  y: number,
  width: number,
  height: number,
  isColumn: boolean,
): void {
  const thickness = isColumn ? width : height;
  const length = isColumn ? height : width;
  let cursor = 0;
  for (let item = start; item < end; item++) {
    const itemLength = item === end - 1 ? length - cursor : thickness > 0 ? (areas[item] ?? 0) / thickness : 0;
    const offset = item * 4;
    rects[offset] = isColumn ? x : x + cursor;
    rects[offset + 1] = isColumn ? y + cursor : y;
    rects[offset + 2] = isColumn ? thickness : itemLength;
    rects[offset + 3] = isColumn ? itemLength : thickness;
    cursor += itemLength;
  }
}
