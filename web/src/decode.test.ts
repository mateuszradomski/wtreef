// Methodology: decode the committed fixtures (one hand-written, one built
// from a real PR) and check the typed output; then break one contract
// invariant at a time in a copy of the tiny fixture and expect a throw that
// names the broken rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeApiError, decodePullRequestData, FileStatus, NodeKind, parseRetryAfter } from "./decode.ts";
import { loadFixtureJson, REAL_FIXTURE, TINY_FIXTURE } from "./test-support.ts";

type TreeJson = Record<string, unknown[]>;

function tinyWithTree(mutate: (tree: TreeJson) => void): Record<string, unknown> {
  const json = loadFixtureJson(TINY_FIXTURE);
  mutate(json["tree"] as TreeJson);
  return json;
}

test("decodes the tiny fixture into typed columns", () => {
  const data = decodePullRequestData(loadFixtureJson(TINY_FIXTURE));
  assert.equal(data.pullRequest.owner, "wtreef");
  assert.equal(data.pullRequest.state, "merged");
  assert.equal(data.tree.nodeCount, 15);
  assert.ok(data.tree.parents instanceof Int32Array);
  assert.ok(data.tree.bytes instanceof Float64Array);
  assert.equal(data.tree.kinds[12], NodeKind.rest);
  assert.equal(data.tree.statuses[7], FileStatus.deleted);
  assert.equal(data.tree.deletions[7], 85);
  assert.equal(data.truncatedFiles, false);
  assert.equal(data.fetchedAtMs, Date.parse("2026-10-12T13:00:00Z"));
});

test("decodes the real l2beat fixture", () => {
  const data = decodePullRequestData(loadFixtureJson(REAL_FIXTURE));
  assert.equal(data.pullRequest.number, 13157);
  assert.ok(data.tree.nodeCount > 100);
  let changedFiles = 0;
  for (let index = 0; index < data.tree.nodeCount; index++) {
    if (data.tree.statuses[index] !== FileStatus.unchanged) changedFiles++;
  }
  assert.equal(changedFiles, data.pullRequest.changedFiles);
});

const violations: ReadonlyArray<[string, (tree: TreeJson) => void, RegExp]> = [
  ["root with a name", (tree) => (tree["names"]![0] = "x"), /root name/],
  ["root with a parent", (tree) => (tree["parents"]![0] = 0), /root parent/],
  ["parent after child", (tree) => (tree["parents"]![6] = 9), /after its parent/],
  ["file as a parent", (tree) => (tree["parents"]![6] = 2), /must be a directory/],
  ["directory with bytes", (tree) => (tree["bytes"]![1] = 10), /must not carry bytes/],
  ["file counting twice", (tree) => (tree["fileCounts"]![3] = 2), /count as one file/],
  ["unchanged file with additions", (tree) => (tree["additions"]![5] = 1), /no additions/],
  ["collapsed directory with a status", (tree) => (tree["statuses"]![4] = 2), /must be unchanged/],
  ["rest node with no files", (tree) => (tree["fileCounts"]![12] = 0), /at least one file/],
  ["rest node with a name", (tree) => (tree["names"]![12] = "more"), /must be unnamed/],
  ["name with a slash", (tree) => (tree["names"]![6] = "a/b"), /must not contain/],
  ["empty file name", (tree) => (tree["names"]![6] = ""), /must have a name/],
  ["duplicate sibling", (tree) => (tree["names"]![7] = "app.ts"), /duplicates a sibling/],
  ["unknown kind", (tree) => (tree["kinds"]![5] = 4), /at most 3/],
  ["unknown status", (tree) => (tree["statuses"]![6] = 5), /at most 4/],
  ["negative bytes", (tree) => (tree["bytes"]![6] = -1), /at least 0/],
  ["fractional additions", (tree) => (tree["additions"]![6] = 1.5), /integer/],
  ["short column", (tree) => tree["deletions"]!.pop(), /one entry per node/],
  ["directory without changes", (tree) => {
    tree["statuses"]![13] = 0;
    tree["additions"]![13] = 0;
    tree["statuses"]![14] = 0;
    tree["additions"]![14] = 0;
  }, /must contain a changed file/],
];

for (const [name, mutate, message] of violations) {
  test(`rejects ${name}`, () => {
    assert.throws(() => decodePullRequestData(tinyWithTree(mutate)), message);
  });
}

test("rejects a second rest node in one directory", () => {
  const json = tinyWithTree((tree) => {
    tree["names"]!.push("");
    tree["parents"]!.push(1);
    tree["kinds"]!.push(3);
    tree["statuses"]!.push(0);
    tree["bytes"]!.push(10);
    tree["additions"]!.push(0);
    tree["deletions"]!.push(0);
    tree["fileCounts"]!.push(1);
  });
  assert.throws(() => decodePullRequestData(json), /duplicates a sibling/);
});

test("rejects bad pull request metadata", () => {
  const cases: ReadonlyArray<[string, unknown, RegExp]> = [
    ["owner", "-bad", /owner/],
    ["repo", "..", /repo/],
    ["state", "draft", /state/],
    ["headSha", "abc", /headSha/],
    ["url", "https://example.com/x", /github\.com/],
    ["additions", -1, /at least 0/],
  ];
  for (const [field, value, message] of cases) {
    const json = loadFixtureJson(TINY_FIXTURE);
    (json["pullRequest"] as Record<string, unknown>)[field] = value;
    assert.throws(() => decodePullRequestData(json), message, field);
  }
});

test("rejects an unknown wire format version", () => {
  const json = loadFixtureJson(TINY_FIXTURE);
  json["version"] = 2;
  assert.throws(() => decodePullRequestData(json), /version/);
});

test("decodes error responses and pairs codes with HTTP statuses", () => {
  const nowMs = Date.parse("2026-10-12T13:00:00Z");
  const rateLimited = decodeApiError(429, { error: "too_many_requests", message: "slow down" }, "30", nowMs);
  assert.equal(rateLimited.code, "too_many_requests");
  assert.equal(rateLimited.retryAfterSeconds, 30);
  const notFound = decodeApiError(404, { error: "not_found", message: "nope" }, null, nowMs);
  assert.equal(notFound.retryAfterSeconds, null);
  assert.throws(() => decodeApiError(500, { error: "not_found", message: "x" }, null, nowMs), /HTTP 404/);
  assert.throws(() => decodeApiError(404, { error: "teapot", message: "x" }, null, nowMs), /known code/);
});

test("parses Retry-After as seconds or an HTTP date", () => {
  const nowMs = Date.parse("2026-10-12T13:00:00Z");
  assert.equal(parseRetryAfter("120", nowMs), 120);
  assert.equal(parseRetryAfter("Mon, 12 Oct 2026 13:01:30 GMT", nowMs), 90);
  assert.equal(parseRetryAfter("Mon, 12 Oct 2026 12:00:00 GMT", nowMs), 0);
  assert.equal(parseRetryAfter("soon", nowMs), null);
  assert.equal(parseRetryAfter(null, nowMs), null);
});
