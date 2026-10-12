// Methodology: compare against node:crypto's independent SHA-256 for every
// changed file in the tiny fixture, and check that context nodes get no link.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decodePullRequestData } from "./decode.ts";
import { computeDiffUrls } from "./diff.ts";
import { buildTreeIndex } from "./model.ts";
import { loadFixtureJson, TINY_FIXTURE } from "./test-support.ts";

test("links each changed file to its anchor in the files tab", async () => {
  const data = decodePullRequestData(loadFixtureJson(TINY_FIXTURE));
  const index = buildTreeIndex(data.tree);
  const urls = await computeDiffUrls(data.pullRequest, index, data.tree.nodeCount);
  for (const node of index.changedFiles) {
    const hash = createHash("sha256").update(index.paths[node] ?? "").digest("hex");
    assert.equal(urls[node], `https://github.com/wtreef/example/pull/1/files#diff-${hash}`);
  }
  assert.equal(urls[0], "");
  assert.equal(urls[5], "", "unchanged LICENSE has no diff");
});
