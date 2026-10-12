// Methodology: ask for the menu of one node of every kind in the tiny
// fixture and compare it with the menus the design names: changed files,
// folders, unchanged context, and nodes with no path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePullRequestData } from "./decode.ts";
import { buildTreeIndex } from "./model.ts";
import { displayPath, nodeMenuItems } from "./node-actions.ts";
import { loadFixtureJson, TINY_FIXTURE } from "./test-support.ts";

// Tiny fixture node indices (see web/fixtures/wtreef-example-1.json).
const ROOT = 0, DOCS = 4, LICENSE = 5, APP = 6, OLD = 7, UTIL = 9, REST = 12;

const tree = decodePullRequestData(loadFixtureJson(TINY_FIXTURE)).tree;
const index = buildTreeIndex(tree);
const labels = (node: number) => nodeMenuItems(tree, node).map((item) => (item.shortcut === "" ? item.label : `${item.label} [${item.shortcut}]`));

test("changed files open their diff, hide, or copy their path", () => {
  assert.deepEqual(labels(APP), ["Open diff on GitHub", "Hide file [H]", "Copy path"]);
  assert.deepEqual(labels(OLD), ["Open diff on GitHub", "Hide file [H]", "Copy path"], "deleted files still have a diff");
});

test("a local branch has no diff on GitHub, so its changed files only hide or copy", () => {
  const branchLabels = nodeMenuItems(tree, APP, false).map((item) => item.label);
  assert.deepEqual(branchLabels, ["Hide file", "Copy path"]);
  assert.deepEqual(nodeMenuItems(tree, UTIL, false).map((item) => item.label), ["Zoom into folder", "Hide folder", "Copy path"]);
});

test("folders zoom in, hide, or copy their path", () => {
  assert.deepEqual(labels(UTIL), ["Zoom into folder", "Hide folder [H]", "Copy path"]);
});

test("unchanged files and collapsed folders can only be hidden or copied", () => {
  assert.deepEqual(labels(LICENSE), ["Hide [H]", "Copy path"]);
  assert.deepEqual(labels(DOCS), ["Hide [H]", "Copy path"]);
});

test("the root and rest nodes have no path, so no menu", () => {
  assert.deepEqual(labels(ROOT), []);
  assert.deepEqual(labels(REST), []);
});

test("folders are named with a trailing slash, files without", () => {
  assert.equal(displayPath(tree, index.paths, UTIL), "src/util/");
  assert.equal(displayPath(tree, index.paths, DOCS), "docs/");
  assert.equal(displayPath(tree, index.paths, APP), "src/app.ts");
  assert.throws(() => displayPath(tree, index.paths, REST), /path/);
});
