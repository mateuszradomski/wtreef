// Methodology: the tiny fixture is small enough to name every node, so each
// test states which nodes a hidden set covers by hand: a folder takes its
// subtree, nothing else; the nearest shown ancestor climbs past the highest
// hidden folder; sets are values, so earlier ones are never modified. Then
// a property check on the real fixture: the path table names every node
// that can be hidden, and only those.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePullRequestData, NodeKind } from "./decode.ts";
import {
  buildHideableNodeByPath,
  isHideableNode,
  isInsideHiddenSubtree,
  nearestShownAncestor,
  NO_HIDDEN_NODES,
  withNodeHidden,
  withNodeShown,
} from "./hidden.ts";
import { buildTreeIndex } from "./model.ts";
import { loadFixtureJson, REAL_FIXTURE, TINY_FIXTURE } from "./test-support.ts";

// Tiny fixture node indices (see web/fixtures/wtreef-example-1.json).
const ROOT = 0, SRC = 1, README = 3, DOCS = 4, APP = 6, UTIL = 9, COMPONENTS = 11, REST = 12, MATH = 13, MATH_TEST = 14;

const tree = decodePullRequestData(loadFixtureJson(TINY_FIXTURE)).tree;

function coveredNodes(hidden: ReadonlySet<number>): number[] {
  const covered: number[] = [];
  for (let node = 0; node < tree.nodeCount; node++) {
    if (isInsideHiddenSubtree(tree, hidden, node)) covered.push(node);
  }
  return covered;
}

test("files, folders and collapsed folders can be hidden; the root and rest nodes cannot", () => {
  assert.ok(isHideableNode(tree, APP));
  assert.ok(isHideableNode(tree, UTIL));
  assert.ok(isHideableNode(tree, COMPONENTS));
  assert.equal(isHideableNode(tree, ROOT), false);
  assert.equal(isHideableNode(tree, REST), false);
});

test("a hidden folder covers its whole subtree and nothing else", () => {
  assert.deepEqual(coveredNodes(new Set([UTIL])), [UTIL, MATH, MATH_TEST]);
  assert.deepEqual(coveredNodes(new Set([MATH, DOCS])), [DOCS, MATH]);
  assert.deepEqual(coveredNodes(NO_HIDDEN_NODES), []);
  assert.equal(coveredNodes(new Set([SRC])).length, 10, "src, its seven children, and util's two files");
});

test("the nearest shown ancestor climbs past the highest hidden folder", () => {
  assert.equal(nearestShownAncestor(tree, NO_HIDDEN_NODES, UTIL), UTIL);
  assert.equal(nearestShownAncestor(tree, new Set([UTIL]), UTIL), SRC);
  assert.equal(nearestShownAncestor(tree, new Set([UTIL]), MATH), SRC);
  assert.equal(nearestShownAncestor(tree, new Set([UTIL, SRC]), MATH), ROOT);
  assert.equal(nearestShownAncestor(tree, new Set([MATH_TEST]), UTIL), UTIL, "hiding a child leaves the folder shown");
});

test("hiding and showing return new sets and keep nested entries apart", () => {
  const file = withNodeHidden(NO_HIDDEN_NODES, tree, MATH);
  const both = withNodeHidden(file, tree, UTIL);
  assert.deepEqual([...both], [MATH, UTIL], "insertion order is kept for the link");
  assert.deepEqual([...file], [MATH], "the earlier set is not modified");
  const folderShown = withNodeShown(both, UTIL);
  assert.deepEqual(coveredNodes(folderShown), [MATH], "showing the folder again leaves the file hidden on its own");
  assert.throws(() => withNodeHidden(both, tree, UTIL), /hidden once/);
  assert.throws(() => withNodeHidden(NO_HIDDEN_NODES, tree, REST), /path/);
  assert.throws(() => withNodeShown(NO_HIDDEN_NODES, README), /only hidden nodes/);
});

test("the path table names exactly the nodes that can be hidden, on the real fixture", () => {
  const real = decodePullRequestData(loadFixtureJson(REAL_FIXTURE)).tree;
  const index = buildTreeIndex(real);
  const nodeByPath = buildHideableNodeByPath(real, index.paths);
  let hideable = 0;
  for (let node = 0; node < real.nodeCount; node++) {
    if (!isHideableNode(real, node)) {
      assert.ok(node === 0 || real.kinds[node] === NodeKind.rest);
      continue;
    }
    hideable++;
    assert.equal(nodeByPath.get(index.paths[node] ?? ""), node);
  }
  assert.equal(nodeByPath.size, hideable);
});
