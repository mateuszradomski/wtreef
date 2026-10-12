// Methodology: squarify is checked against exact geometry (areas preserved,
// full coverage, no overlap, good aspect ratios). The nested layout is
// checked for structural invariants on both fixtures at several viewport
// sizes, from a phone to a large desktop: children sit inside their
// parent's content box, siblings never overlap, zero-weight nodes are never
// laid out, and the draw order puts parents first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePullRequestData, NodeKind, type Tree } from "./decode.ts";
import { chainEnd, chainTop, computeLayout, createLayout, LAYOUT, type Layout, LayoutFlag, squarify } from "./layout.ts";
import { buildTreeIndex, computeWeights, DEFAULT_FILTERS, SizeMode, type TreeIndex } from "./model.ts";
import { loadFixtureJson, REAL_FIXTURE, TINY_FIXTURE } from "./test-support.ts";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectOf(layout: Layout, node: number): Rect {
  const offset = node * 4;
  return {
    x: layout.rects[offset] ?? NaN,
    y: layout.rects[offset + 1] ?? NaN,
    width: layout.rects[offset + 2] ?? NaN,
    height: layout.rects[offset + 3] ?? NaN,
  };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test("squarify preserves areas, covers the rectangle, and never overlaps", () => {
  const sizes = [6, 6, 4, 3, 2, 2, 1];
  const width = 6;
  const height = 4;
  const areas = Float64Array.from(sizes);
  const rects = new Float64Array(sizes.length * 4);
  squarify(areas, sizes.length, 0, 0, width, height, rects);
  let coveredArea = 0;
  const placed: Rect[] = [];
  for (let item = 0; item < sizes.length; item++) {
    const rect = { x: rects[item * 4]!, y: rects[item * 4 + 1]!, width: rects[item * 4 + 2]!, height: rects[item * 4 + 3]! };
    assert.ok(Math.abs(rect.width * rect.height - sizes[item]!) < 1e-9, `area of item ${item}`);
    assert.ok(rect.x >= -1e-9 && rect.y >= -1e-9, "inside the left/top edge");
    assert.ok(rect.x + rect.width <= width + 1e-9 && rect.y + rect.height <= height + 1e-9, "inside the right/bottom edge");
    for (const other of placed) assert.ok(!overlaps(shrink(rect), shrink(other)), `item ${item} overlaps`);
    placed.push(rect);
    coveredArea += rect.width * rect.height;
  }
  assert.ok(Math.abs(coveredArea - width * height) < 1e-9);
  // The textbook example (Bruls et al.) keeps every aspect ratio under 3.
  for (const rect of placed) assert.ok(Math.max(rect.width / rect.height, rect.height / rect.width) < 3);
});

function shrink(rect: Rect): Rect {
  const epsilon = 1e-6;
  return { x: rect.x + epsilon, y: rect.y + epsilon, width: rect.width - 2 * epsilon, height: rect.height - 2 * epsilon };
}

function layoutFixture(name: string, width: number, height: number, sizeMode: SizeMode = SizeMode.context) {
  const tree = decodePullRequestData(loadFixtureJson(name)).tree;
  const index = buildTreeIndex(tree);
  const weights = new Float64Array(tree.nodeCount);
  computeWeights(tree, index, { ...DEFAULT_FILTERS, sizeMode }, weights);
  const layout = createLayout(tree.nodeCount);
  computeLayout(tree, index, weights, 0, width, height, layout);
  return { tree, index, weights, layout };
}

function checkLayoutInvariants(tree: Tree, index: TreeIndex, weights: Float64Array, layout: Layout): void {
  const seen = new Uint8Array(tree.nodeCount);
  for (let order = 0; order < layout.drawCount; order++) {
    const node = layout.drawOrder[order]!;
    assert.equal(seen[node], 0, `node ${node} drawn twice`);
    seen[node] = 1;
    assert.ok((weights[node] ?? 0) > 0, `zero-weight node ${node} laid out`);
    assert.ok(((layout.flags[node] ?? 0) & LayoutFlag.laidOut) !== 0);
    const rect = rectOf(layout, node);
    assert.ok(rect.width >= LAYOUT.tileSideMin && rect.height >= LAYOUT.tileSideMin, `node ${node} too small`);
    assert.ok(Number.isInteger(rect.x) && Number.isInteger(rect.width), `node ${node} not pixel-snapped`);
    if (node === layout.rootNode) continue;
    const parent = tree.parents[node]!;
    assert.equal(seen[parent], 1, `parent of ${node} must be drawn first`);
    const parentRect = rectOf(layout, parent);
    const parentFlags = layout.flags[parent] ?? 0;
    const headerOffset = (parentFlags & LayoutFlag.header) !== 0 ? LAYOUT.headerHeight : 0;
    const padding = (parentFlags & LayoutFlag.chained) !== 0 ? 0 : LAYOUT.padding;
    assert.ok(rect.x >= parentRect.x + padding, `node ${node} left of its parent's content`);
    assert.ok(rect.y >= parentRect.y + padding + headerOffset, `node ${node} above its parent's content`);
    assert.ok(rect.x + rect.width <= parentRect.x + parentRect.width - padding, `node ${node} right of content`);
    assert.ok(rect.y + rect.height <= parentRect.y + parentRect.height - padding, `node ${node} below content`);
    if (((layout.flags[node] ?? 0) & LayoutFlag.chained) !== 0) {
      assert.equal(layout.chainChild[parent], node, `chained node ${node} is its parent's chain child`);
      assert.equal(rect.x, parentRect.x + padding, "a chained directory fills its parent's content box");
      assert.equal(rect.width, parentRect.width - 2 * padding, "a chained directory fills its parent's content box");
    }
  }
  for (let node = 0; node < tree.nodeCount; node++) {
    if (seen[node] === 0) continue;
    const start = index.childStart[node]!;
    const end = index.childStart[node + 1]!;
    for (let first = start; first < end; first++) {
      const a = index.childIndices[first]!;
      if (seen[a] === 0) continue;
      for (let second = first + 1; second < end; second++) {
        const b = index.childIndices[second]!;
        if (seen[b] === 1) assert.ok(!overlaps(rectOf(layout, a), rectOf(layout, b)), `siblings ${a} and ${b} overlap`);
      }
    }
  }
}

test("nested layout invariants hold on both fixtures at many sizes", () => {
  const sizes: ReadonlyArray<[number, number]> = [[1440, 760], [1100, 640], [390, 480], [200, 120], [37, 23]];
  for (const fixture of [TINY_FIXTURE, REAL_FIXTURE]) {
    for (const [width, height] of sizes) {
      for (const sizeMode of [SizeMode.context, SizeMode.churn]) {
        const { tree, index, weights, layout } = layoutFixture(fixture, width, height, sizeMode);
        checkLayoutInvariants(tree, index, weights, layout);
      }
    }
  }
});

test("the root fills the viewport and big children get headers and open frames", () => {
  const { tree, layout } = layoutFixture(TINY_FIXTURE, 800, 600);
  assert.deepEqual(rectOf(layout, 0), { x: 0, y: 0, width: 800, height: 600 });
  assert.equal(layout.drawOrder[0], 0);
  const src = 1;
  assert.equal(tree.kinds[src], NodeKind.directory);
  assert.ok(((layout.flags[src] ?? 0) & LayoutFlag.header) !== 0);
  assert.ok(((layout.flags[src] ?? 0) & LayoutFlag.open) !== 0);
  assert.equal((layout.flags[0] ?? 0) & LayoutFlag.header, 0, "the zoom root has no header; breadcrumbs name it");
});

test("tile areas follow weights", () => {
  const { tree, weights, layout } = layoutFixture(TINY_FIXTURE, 1000, 700);
  const lockfile = 2;
  const docs = 4;
  const lockRect = rectOf(layout, lockfile);
  const docsRect = rectOf(layout, docs);
  const expectedRatio = (weights[lockfile] ?? 0) / (weights[docs] ?? 1);
  const actualRatio = (lockRect.width * lockRect.height) / (docsRect.width * docsRect.height);
  assert.ok(Math.abs(actualRatio / expectedRatio - 1) < 0.05, `ratio ${actualRatio} vs ${expectedRatio}`);
  assert.equal(tree.parents[lockfile], 0);
});

test("zooming lays out only the zoomed subtree, and empty roots lay out nothing", () => {
  const { tree, index, weights, layout } = layoutFixture(TINY_FIXTURE, 600, 400);
  const util = 9;
  const math = 13;
  const mathTest = 14;
  computeLayout(tree, index, weights, util, 600, 400, layout);
  const drawn = [...layout.drawOrder.subarray(0, layout.drawCount)];
  assert.deepEqual(drawn, [util, math, mathTest]);
  weights.fill(0);
  computeLayout(tree, index, weights, 0, 600, 400, layout);
  assert.equal(layout.drawCount, 0);
});

test("single-child folder chains share one header", () => {
  const { tree, index, weights, layout } = layoutFixture(REAL_FIXTURE, 1280, 800, SizeMode.churn);
  let chains = 0;
  for (let node = 0; node < tree.nodeCount; node++) {
    if (((layout.flags[node] ?? 0) & LayoutFlag.chained) === 0) continue;
    chains++;
    const parent = tree.parents[node]!;
    assert.notEqual(parent, layout.rootNode, "the root never chains: it has no header to name the chain");
    assert.equal((layout.flags[node] ?? 0) & LayoutFlag.header, 0, "chained folders draw no header");
    let visibleSiblings = 0;
    for (let cursor = index.childStart[parent]!; cursor < index.childStart[parent + 1]!; cursor++) {
      if ((weights[index.childIndices[cursor]!] ?? 0) > 0) visibleSiblings++;
    }
    assert.equal(visibleSiblings, 1);
    assert.equal(chainTop(tree, layout, chainEnd(layout, node)), chainTop(tree, layout, node));
  }
  assert.ok(chains > 0, "the l2beat PR has single-child folder chains in Churn mode");
});

test("an open headed frame starts its tiles right under a 12px header and 1px padding", () => {
  const { tree, index, layout } = layoutFixture(REAL_FIXTURE, 1280, 800, SizeMode.churn);
  assert.equal(LAYOUT.headerHeight, 12);
  assert.equal(LAYOUT.padding, 1);
  let headed = 0;
  for (let node = 0; node < tree.nodeCount; node++) {
    const flags = layout.flags[node] ?? 0;
    if ((flags & LayoutFlag.header) === 0 || (flags & LayoutFlag.open) === 0) continue;
    headed++;
    const frame = rectOf(layout, node);
    let topmost = Number.POSITIVE_INFINITY;
    for (let cursor = index.childStart[node]!; cursor < index.childStart[node + 1]!; cursor++) {
      const child = index.childIndices[cursor]!;
      if (((layout.flags[child] ?? 0) & LayoutFlag.laidOut) !== 0) topmost = Math.min(topmost, rectOf(layout, child).y);
    }
    // Squarify fills the content box from its top edge, so some child always touches it.
    assert.equal(topmost, frame.y + LAYOUT.padding + LAYOUT.headerHeight, `frame ${node}`);
  }
  assert.ok(headed > 0, "the l2beat PR has headed folders at this size");
});

test("layout is deterministic", () => {
  const first = layoutFixture(REAL_FIXTURE, 1280, 720);
  const second = layoutFixture(REAL_FIXTURE, 1280, 720);
  assert.deepEqual(first.layout.rects, second.layout.rects);
  assert.deepEqual(first.layout.drawOrder, second.layout.drawOrder);
});
