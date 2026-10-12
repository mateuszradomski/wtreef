// Methodology: the tiny fixture's changed files are few enough to sum by
// hand, so each case states its totals. Filters that only change how tiles
// are drawn (size mode, Unchanged, an invalid pattern) must leave the totals
// and the unfiltered header alone; every filter that can take a changed file
// away must mark them as filtered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePullRequestData, FileStatus } from "./decode.ts";
import { buildTreeIndex, computeWeights, DEFAULT_FILTERS, type Filters, SizeMode } from "./model.ts";
import { parsePathPattern } from "./pattern.ts";
import { loadFixtureJson, TINY_FIXTURE } from "./test-support.ts";
import { describeHeaderTotals, filtersHideChangedFiles, sumShownChanges } from "./totals.ts";

// Tiny fixture node indices (see web/fixtures/wtreef-example-1.json).
const SRC = 1, UTIL = 9;

const data = decodePullRequestData(loadFixtureJson(TINY_FIXTURE));
const index = buildTreeIndex(data.tree);

function totalsFor(filters: Filters) {
  const weights = new Float64Array(data.tree.nodeCount);
  computeWeights(data.tree, index, filters, weights);
  return sumShownChanges(data.tree, index, weights);
}

test("only filters that can take a changed file away count as filtering", () => {
  assert.equal(filtersHideChangedFiles(DEFAULT_FILTERS), false);
  assert.equal(filtersHideChangedFiles({ ...DEFAULT_FILTERS, sizeMode: SizeMode.context }), false);
  assert.equal(filtersHideChangedFiles({ ...DEFAULT_FILTERS, showUnchanged: false }), false);
  assert.equal(filtersHideChangedFiles({ ...DEFAULT_FILTERS, include: parsePathPattern("(") }), false, "an invalid pattern is ignored");
  assert.equal(filtersHideChangedFiles({ ...DEFAULT_FILTERS, include: parsePathPattern("src") }), true);
  assert.equal(filtersHideChangedFiles({ ...DEFAULT_FILTERS, exclude: parsePathPattern("test") }), true);
  assert.equal(filtersHideChangedFiles({ ...DEFAULT_FILTERS, hiddenStatuses: 1 << FileStatus.added }), true);
  assert.equal(filtersHideChangedFiles({ ...DEFAULT_FILTERS, hiddenTypes: new Set(["md"]) }), true);
  assert.equal(filtersHideChangedFiles({ ...DEFAULT_FILTERS, showGenerated: false }), true);
  assert.equal(filtersHideChangedFiles({ ...DEFAULT_FILTERS, hiddenNodes: new Set([UTIL]) }), true);
});

test("shown totals sum the changed files that pass every filter", () => {
  assert.deepEqual(totalsFor(DEFAULT_FILTERS), { additions: 435, deletions: 378, files: 7 });
  // util holds math.ts (+60) and math.test.ts (+30).
  assert.deepEqual(totalsFor({ ...DEFAULT_FILTERS, hiddenNodes: new Set([UTIL]) }), { additions: 345, deletions: 378, files: 5 });
  // The lockfile is generated (+300 −280); README.md is the only .md (+5 −1).
  const noLockfileNoDocs = { ...DEFAULT_FILTERS, showGenerated: false, hiddenTypes: new Set(["md"]) };
  assert.deepEqual(totalsFor(noLockfileNoDocs), { additions: 130, deletions: 97, files: 5 });
  assert.deepEqual(totalsFor({ ...DEFAULT_FILTERS, hiddenNodes: new Set([SRC]), include: parsePathPattern("lock") }), {
    additions: 300,
    deletions: 280,
    files: 1,
  });
});

test("size mode and Unchanged do not change the totals", () => {
  const churn = totalsFor({ ...DEFAULT_FILTERS, hiddenNodes: new Set([UTIL]) });
  assert.deepEqual(totalsFor({ ...DEFAULT_FILTERS, sizeMode: SizeMode.context, hiddenNodes: new Set([UTIL]) }), churn);
  assert.deepEqual(totalsFor({ ...DEFAULT_FILTERS, sizeMode: SizeMode.context, showUnchanged: false, hiddenNodes: new Set([UTIL]) }), churn);
});

test("unfiltered, the header shows the pull request's own numbers", () => {
  // Even when they differ from the tree's, as with a truncated file list.
  const header = describeHeaderTotals({ ...data.pullRequest, additions: 10519, changedFiles: 93 }, DEFAULT_FILTERS, totalsFor(DEFAULT_FILTERS));
  assert.equal(header.filtered, false);
  assert.deepEqual([header.additions, header.deletions, header.files], [10519, 378, 93]);
  assert.equal(header.filesText, "93 files");
});

test("filtered, the header shows what is left, out of the whole, and says so", () => {
  const filters = { ...DEFAULT_FILTERS, hiddenNodes: new Set([UTIL]) };
  const pullRequest = { ...data.pullRequest, additions: 10519, deletions: 109, changedFiles: 93 };
  const header = describeHeaderTotals(pullRequest, filters, totalsFor(filters));
  assert.equal(header.filtered, true);
  assert.deepEqual([header.additions, header.deletions, header.files], [345, 378, 5]);
  assert.equal(header.filesText, "5 of 93 files");
  assert.equal(header.description, "Filtered. Whole PR: +10,519 −109 across 93 files.");
  const nothingShown = { additions: 0, deletions: 0, files: 0 };
  assert.equal(describeHeaderTotals({ ...pullRequest, changedFiles: 1 }, filters, nothingShown).filesText, "0 of 1 file");
});
