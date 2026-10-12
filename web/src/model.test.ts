// Methodology: the tiny fixture's numbers are small enough to compute by
// hand, so each test states the expected weights explicitly. Then a
// property check on the real fixture: every directory's weight equals the
// sum of its children under every combination of filters.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePullRequestData, FileStatus, type Tree } from "./decode.ts";
import {
  buildTreeIndex,
  computeSubtreeMembership,
  computeWeights,
  DEFAULT_FILTERS,
  ESTIMATED_BYTES_PER_CHANGED_LINE,
  type Filters,
  findDirectoryByPath,
  hasActiveCategoryFilters,
  isGeneratedPath,
  presentStatusMask,
  SizeMode,
  TYPE_KEY_NONE,
  typeKeyOf,
  withDefaultCategoryFilters,
} from "./model.ts";
import { parsePathPattern } from "./pattern.ts";
import { loadFixtureJson, REAL_FIXTURE, TINY_FIXTURE } from "./test-support.ts";

// Tiny fixture node indices (see web/fixtures/wtreef-example-1.json).
const ROOT = 0, SRC = 1, LOCKFILE = 2, README = 3, DOCS = 4, LICENSE = 5, APP = 6, OLD = 7;
const RENAMED = 8, UTIL = 9, INDEX = 10, COMPONENTS = 11, REST = 12, MATH = 13, MATH_TEST = 14;

function loadTree(name: string): Tree {
  return decodePullRequestData(loadFixtureJson(name)).tree;
}

function weightsFor(tree: Tree, filters: Filters): Float64Array {
  const weights = new Float64Array(tree.nodeCount);
  computeWeights(tree, buildTreeIndex(tree), filters, weights);
  return weights;
}

test("derives paths, depths and children", () => {
  const tree = loadTree(TINY_FIXTURE);
  const index = buildTreeIndex(tree);
  assert.equal(index.paths[MATH], "src/util/math.ts");
  assert.equal(index.paths[REST], "");
  assert.equal(index.paths[ROOT], "");
  assert.equal(index.depths[MATH], 3);
  const srcChildren = [...index.childIndices.subarray(index.childStart[SRC], index.childStart[SRC + 1])];
  assert.deepEqual(srcChildren, [APP, OLD, RENAMED, UTIL, INDEX, COMPONENTS, REST]);
  assert.equal(findDirectoryByPath(tree, index, "src/util"), UTIL);
  assert.equal(findDirectoryByPath(tree, index, "src/app.ts"), -1);
});

test("summarizes statuses, types, churn and subtree totals", () => {
  const tree = loadTree(TINY_FIXTURE);
  const index = buildTreeIndex(tree);
  assert.deepEqual([...index.statusCounts], [0, 2, 3, 1, 1]);
  assert.deepEqual(index.typeBuckets, [
    { key: "ts", count: 5 },
    { key: "json", count: 1 },
    { key: "md", count: 1 },
  ]);
  assert.equal(index.generatedChangedCount, 1);
  assert.equal(index.churnMax, 580);
  assert.deepEqual([...index.changedFiles], [LOCKFILE, OLD, MATH, APP, MATH_TEST, README, RENAMED]);
  assert.equal(index.subtreeAdditions[ROOT], 435);
  assert.equal(index.subtreeDeletions[ROOT], 378);
  assert.equal(index.subtreeFiles[SRC], 1 + 1 + 1 + 1 + 12 + 7 + 2);
  assert.equal(index.subtreeChangedFiles[SRC], 5);
  const everyChangedStatus = (1 << FileStatus.added) | (1 << FileStatus.modified) | (1 << FileStatus.deleted) | (1 << FileStatus.renamed);
  assert.equal(presentStatusMask(index), everyChangedStatus);
});

// Byte-based expectations below are only meaningful when sizing by context.
const CONTEXT_FILTERS = { ...DEFAULT_FILTERS, sizeMode: SizeMode.context };

test("context weights use bytes and estimate files without bytes", () => {
  const tree = loadTree(TINY_FIXTURE);
  const weights = weightsFor(tree, CONTEXT_FILTERS);
  assert.equal(weights[APP], 4200);
  assert.equal(weights[OLD], 85 * ESTIMATED_BYTES_PER_CHANGED_LINE);
  assert.equal(weights[RENAMED], 900);
  assert.equal(weights[COMPONENTS], 25000);
  assert.equal(weights[REST], 9000);
  assert.equal(weights[UTIL], 1500 + 800);
  assert.equal(weights[SRC], 4200 + 3400 + 900 + 2300 + 300 + 25000 + 9000);
  assert.equal(weights[ROOT], (weights[SRC] ?? 0) + 120000 + 2000 + 50000 + 1069);
});

test("churn weights count changed lines and drop context", () => {
  const tree = loadTree(TINY_FIXTURE);
  const weights = weightsFor(tree, { ...DEFAULT_FILTERS, sizeMode: SizeMode.churn });
  assert.equal(weights[RENAMED], 1, "a pure rename still gets a sliver");
  assert.equal(weights[OLD], 85);
  assert.equal(weights[INDEX], 0);
  assert.equal(weights[COMPONENTS], 0);
  assert.equal(weights[REST], 0);
  assert.equal(weights[LICENSE], 0);
  assert.equal(weights[ROOT], 435 + 378 + 1);
});

test("filters zero out leaves before aggregation", () => {
  const tree = loadTree(TINY_FIXTURE);
  const noAdded = weightsFor(tree, { ...CONTEXT_FILTERS, hiddenStatuses: 1 << FileStatus.added });
  assert.equal(noAdded[UTIL], 0);
  assert.equal(noAdded[MATH], 0);

  const noTs = weightsFor(tree, { ...CONTEXT_FILTERS, hiddenTypes: new Set(["ts"]) });
  assert.equal(noTs[APP], 0);
  assert.equal(noTs[INDEX], 300, "type filters apply to changed files only");

  const noContext = weightsFor(tree, { ...CONTEXT_FILTERS, showUnchanged: false });
  assert.equal(noContext[DOCS], 0);
  assert.equal(noContext[REST], 0);
  assert.equal(noContext[ROOT], 120000 + 2000 + 4200 + 3400 + 900 + 2300);

  const noGenerated = weightsFor(tree, { ...CONTEXT_FILTERS, showGenerated: false });
  assert.equal(noGenerated[LOCKFILE], 0);
  assert.equal(noGenerated[README], 2000);
});

test("aggregation holds on the real fixture under every filter combination", () => {
  const tree = loadTree(REAL_FIXTURE);
  const index = buildTreeIndex(tree);
  const weights = new Float64Array(tree.nodeCount);
  for (const sizeMode of [SizeMode.context, SizeMode.churn]) {
    for (const showUnchanged of [true, false]) {
      for (const hiddenStatuses of [0, 1 << FileStatus.added, 1 << FileStatus.modified]) {
        computeWeights(tree, index, { ...DEFAULT_FILTERS, sizeMode, showUnchanged, hiddenStatuses }, weights);
        const childSums = new Float64Array(tree.nodeCount);
        for (let node = 1; node < tree.nodeCount; node++) childSums[tree.parents[node] ?? 0]! += weights[node] ?? 0;
        for (let node = 0; node < tree.nodeCount; node++) {
          if (tree.kinds[node] === 0) assert.equal(weights[node], childSums[node], `node ${node}`);
        }
      }
    }
  }
});

/** The leaves with weight under `filters`, in node order. */
function visibleLeaves(tree: Tree, filters: Filters): number[] {
  const weights = weightsFor(tree, filters);
  const leaves: number[] = [];
  for (let node = 0; node < tree.nodeCount; node++) {
    if (tree.kinds[node] !== 0 && (weights[node] ?? 0) > 0) leaves.push(node);
  }
  return leaves;
}

function withPatterns(base: Filters, include: string, exclude: string): Filters {
  return { ...base, include: parsePathPattern(include), exclude: parsePathPattern(exclude) };
}

test("include keeps only leaves whose full path matches, ignoring case", () => {
  const tree = loadTree(TINY_FIXTURE);
  assert.deepEqual(visibleLeaves(tree, withPatterns(DEFAULT_FILTERS, "MATH", "")), [MATH, MATH_TEST]);
  assert.deepEqual(visibleLeaves(tree, withPatterns(DEFAULT_FILTERS, "^src/[^/]+$", "")), [APP, OLD, RENAMED]);
  // Context: unchanged files match too, but the rest node has no path to match and is hidden.
  assert.deepEqual(visibleLeaves(tree, withPatterns(CONTEXT_FILTERS, "^src/", "")), [APP, OLD, RENAMED, INDEX, COMPONENTS, MATH, MATH_TEST]);
});

test("exclude drops matching leaves and keeps rest nodes", () => {
  const tree = loadTree(TINY_FIXTURE);
  const weights = weightsFor(tree, withPatterns(CONTEXT_FILTERS, "", "\\.test\\.|^docs/"));
  assert.equal(weights[MATH_TEST], 0);
  assert.equal(weights[DOCS], 0, "a collapsed folder matches as its path plus a slash");
  assert.equal(weights[REST], 9000, "a rest node has no path, so no exclude can name it");
  assert.equal(weights[UTIL], 1500);
});

test("include and exclude combine, and an invalid pattern is ignored", () => {
  const tree = loadTree(TINY_FIXTURE);
  const both = withPatterns(DEFAULT_FILTERS, "^src/", "util");
  assert.deepEqual(visibleLeaves(tree, both), [APP, OLD, RENAMED]);
  const invalidInclude = withPatterns(DEFAULT_FILTERS, "(", "util");
  assert.deepEqual(visibleLeaves(tree, invalidInclude), visibleLeaves(tree, withPatterns(DEFAULT_FILTERS, "", "util")));
  const invalidBoth = withPatterns(CONTEXT_FILTERS, "[", "(");
  assert.deepEqual(weightsFor(tree, invalidBoth), weightsFor(tree, CONTEXT_FILTERS));
});

test("aggregation holds on the real fixture with path patterns", () => {
  const tree = loadTree(REAL_FIXTURE);
  const index = buildTreeIndex(tree);
  const weights = new Float64Array(tree.nodeCount);
  const patterns: ReadonlyArray<readonly [string, string]> = [["\\.tsx$", ""], ["", "test"], ["frontend", "e2e|\\.json$"]];
  for (const sizeMode of [SizeMode.context, SizeMode.churn]) {
    for (const [include, exclude] of patterns) {
      computeWeights(tree, index, withPatterns({ ...DEFAULT_FILTERS, sizeMode }, include, exclude), weights);
      const childSums = new Float64Array(tree.nodeCount);
      for (let node = 1; node < tree.nodeCount; node++) childSums[tree.parents[node] ?? 0]! += weights[node] ?? 0;
      for (let node = 0; node < tree.nodeCount; node++) {
        if (tree.kinds[node] === 0) assert.equal(weights[node], childSums[node], `node ${node}`);
        if (tree.kinds[node] === 0 || (weights[node] ?? 0) === 0) continue;
        const path = index.paths[node] ?? "";
        if (include !== "") assert.match(path, new RegExp(include, "i"));
        if (exclude !== "") assert.doesNotMatch(path, new RegExp(exclude, "i"));
      }
    }
  }
});

test("subtree membership marks the zoomed directory and its descendants", () => {
  const tree = loadTree(TINY_FIXTURE);
  const inside = new Uint8Array(tree.nodeCount);
  computeSubtreeMembership(tree, UTIL, inside);
  assert.deepEqual([...inside].flatMap((flag, node) => (flag === 1 ? [node] : [])), [UTIL, MATH, MATH_TEST]);
});

test("recognizes lockfiles and generated paths", () => {
  const generated = [
    "package-lock.json",
    "web/yarn.lock",
    "Cargo.lock",
    "go.sum",
    "app.min.js",
    "app.MIN.CSS",
    "bundle.js.map",
    "__snapshots__/x.test.ts.snap",
    "packages/a/dist/index.js",
    "vendor/lib/x.go",
    "src/__generated__/schema.ts",
    "api.generated.ts",
  ];
  for (const path of generated) assert.ok(isGeneratedPath(path, false), path);
  const handwritten = ["src/build.ts", "distance.ts", "lock.json", "generated.md", "src/mapper.ts"];
  for (const path of handwritten) assert.ok(!isGeneratedPath(path, false), path);
  assert.ok(isGeneratedPath("packages/a/dist", true));
  assert.ok(!isGeneratedPath("packages/a/src", true));
});

test("derives type keys from file names", () => {
  assert.equal(typeKeyOf("index.TS"), "ts");
  assert.equal(typeKeyOf("types.d.ts"), "ts");
  assert.equal(typeKeyOf(".gitignore"), TYPE_KEY_NONE);
  assert.equal(typeKeyOf("Makefile"), TYPE_KEY_NONE);
  assert.equal(typeKeyOf("trailing."), TYPE_KEY_NONE);
});

test("category filters ignore size mode and path patterns, and reset to the defaults", () => {
  assert.equal(hasActiveCategoryFilters(DEFAULT_FILTERS), false);
  assert.equal(hasActiveCategoryFilters({ ...DEFAULT_FILTERS, sizeMode: SizeMode.context }), false);
  assert.equal(hasActiveCategoryFilters({ ...DEFAULT_FILTERS, include: parsePathPattern("x") }), false);
  assert.equal(hasActiveCategoryFilters({ ...DEFAULT_FILTERS, hiddenTypes: new Set(["md"]) }), true);
  assert.equal(hasActiveCategoryFilters({ ...DEFAULT_FILTERS, showUnchanged: false }), true);
  const changed: Filters = {
    ...DEFAULT_FILTERS,
    sizeMode: SizeMode.context,
    hiddenStatuses: 1 << FileStatus.added,
    showGenerated: false,
    exclude: parsePathPattern("test"),
  };
  const reset = withDefaultCategoryFilters(changed);
  assert.equal(hasActiveCategoryFilters(reset), false);
  assert.equal(reset.sizeMode, SizeMode.context);
  assert.equal(reset.exclude, changed.exclude);
});
