// Methodology: one report per stage, checking that the bar only grows as a
// load moves through its stages and never claims to be done.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { LoadProgress } from "./decode.ts";
import { progressFraction, progressText } from "./load-progress.ts";

function report(stage: LoadProgress["stage"], filesFetched = 0, filesTotal = 0, treeEntries = 0): LoadProgress {
  return { stage, filesFetched, filesTotal, treeEntries };
}

test("nothing is measured before the files are listed", () => {
  assert.equal(progressFraction(report("idle")), null);
  assert.equal(progressFraction(report("pullRequest")), null);
  assert.equal(progressText(report("idle")), null);
  assert.equal(progressText(report("pullRequest")), "Asking GitHub for the pull request…");
});

test("the bar grows through every stage and never fills", () => {
  const reports = [
    report("files", 100, 2800),
    report("files", 1200, 2800),
    report("files", 2800, 2800),
    report("tree", 2800, 2800, 0),
    report("tree", 2800, 2800, 45_210),
    report("tree", 2800, 2800, 1_000_000),
  ];
  const fractions = reports.map((each) => progressFraction(each) ?? Number.NaN);
  for (let index = 1; index < fractions.length; index++) {
    assert.ok(fractions[index]! >= fractions[index - 1]!, `fraction ${index} does not shrink`);
  }
  assert.ok(fractions[0]! > 0);
  assert.ok(fractions.at(-1)! < 1);
});

test("a pull request without changed files is listed at once", () => {
  assert.equal(progressFraction(report("files", 0, 0)), progressFraction(report("tree")));
});

test("the line under the bar counts what is known", () => {
  assert.equal(progressText(report("files", 1200, 2800)), "Listing changed files: 1,200 of 2,800");
  assert.equal(progressText(report("tree")), "Reading the repository…");
  assert.equal(progressText(report("tree", 0, 0, 1)), "Reading the repository: 1 file");
  assert.equal(progressText(report("tree", 0, 0, 45_210)), "Reading the repository: 45,210 files");
});
