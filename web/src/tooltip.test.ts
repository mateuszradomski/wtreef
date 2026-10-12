// Methodology: describe one node of every kind in the tiny fixture and
// check the facts a reviewer needs (path, status, churn, size, counts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePullRequestData } from "./decode.ts";
import { buildTreeIndex } from "./model.ts";
import { loadFixtureJson, TINY_FIXTURE } from "./test-support.ts";
import { describeNode } from "./tooltip.ts";

const data = decodePullRequestData(loadFixtureJson(TINY_FIXTURE));
const index = buildTreeIndex(data.tree);
const describe = (node: number) => describeNode(data.tree, index, node);

test("changed files show path, status, churn, size and what a click does", () => {
  const app = describe(6);
  assert.equal(app.title, "src/app.ts");
  assert.deepEqual(app.status, { className: "status-modified", label: "Modified" });
  assert.deepEqual(app.facts, ["+40 −12", "4.1 KB"]);
  assert.equal(app.action, "Click to open the diff");
});

test("deleted files say they are gone instead of showing a size", () => {
  const old = describe(7);
  assert.equal(old.status?.label, "Deleted");
  assert.deepEqual(old.facts, ["+0 −85", "not in the head commit"]);
});

test("context nodes show counts and sizes without a status", () => {
  assert.deepEqual(describe(11), { title: "src/components/", status: null, facts: ["unchanged folder", "12 files", "24 KB"], action: "" });
  assert.deepEqual(describe(12), { title: "Other files in src/", status: null, facts: ["7 unchanged files", "8.8 KB"], action: "" });
  assert.deepEqual(describe(5), { title: "LICENSE", status: null, facts: ["unchanged", "1.0 KB"], action: "" });
});

test("folders summarize their changes and name the folder a click zooms into", () => {
  const util = describe(9);
  assert.equal(util.title, "src/util/");
  assert.deepEqual(util.facts, ["2 of 2 files changed", "+90 −0", "2.2 KB"]);
  assert.equal(util.action, "Click to zoom into util");
});
