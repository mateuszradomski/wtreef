// Methodology: lay out the tiny fixture, then probe the center of every
// laid-out node and expect that node back; probe gaps, headers and the
// outside of the canvas for the containing directory or nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePullRequestData, NodeKind } from "./decode.ts";
import { hitTest, isDirectoryFrameHit, NO_NODE } from "./hit.ts";
import { computeLayout, createLayout, LAYOUT, LayoutFlag } from "./layout.ts";
import { buildTreeIndex, computeWeights, DEFAULT_FILTERS } from "./model.ts";
import { loadFixtureJson, TINY_FIXTURE } from "./test-support.ts";

function setup() {
  const tree = decodePullRequestData(loadFixtureJson(TINY_FIXTURE)).tree;
  const index = buildTreeIndex(tree);
  const weights = new Float64Array(tree.nodeCount);
  computeWeights(tree, index, DEFAULT_FILTERS, weights);
  const layout = createLayout(tree.nodeCount);
  computeLayout(tree, index, weights, 0, 900, 600, layout);
  return { tree, index, layout };
}

test("the center of every leaf hits that leaf", () => {
  const { tree, index, layout } = setup();
  for (let order = 1; order < layout.drawCount; order++) {
    const node = layout.drawOrder[order]!;
    if (tree.kinds[node] === NodeKind.directory) continue;
    const x = layout.rects[node * 4]! + layout.rects[node * 4 + 2]! / 2;
    const y = layout.rects[node * 4 + 1]! + layout.rects[node * 4 + 3]! / 2;
    assert.equal(hitTest(tree, index, layout, x, y), node);
  }
});

test("a directory header hits the directory and counts as a frame hit", () => {
  const { tree, index, layout } = setup();
  const src = 9;
  assert.ok(((layout.flags[src] ?? 0) & LayoutFlag.header) !== 0);
  const x = layout.rects[src * 4]! + 10;
  const y = layout.rects[src * 4 + 1]! + LAYOUT.padding + LAYOUT.headerHeight / 2;
  const hit = hitTest(tree, index, layout, x, y);
  assert.equal(hit, src);
  assert.ok(isDirectoryFrameHit(tree, layout, hit));
});

test("points outside the canvas hit nothing, and the root is never a frame hit", () => {
  const { tree, index, layout } = setup();
  assert.equal(hitTest(tree, index, layout, -1, 5), NO_NODE);
  assert.equal(hitTest(tree, index, layout, 5, 600), NO_NODE);
  assert.equal(isDirectoryFrameHit(tree, layout, 0), false);
  assert.equal(isDirectoryFrameHit(tree, layout, NO_NODE), false);
});
