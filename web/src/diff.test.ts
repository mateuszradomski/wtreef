// Methodology: compare against node:crypto's independent SHA-256, for every
// changed file in the real fixture's links and for raw inputs at the
// lengths where SHA-256 padding changes shape (55, 56 and 64 bytes need one
// more block than the byte before them), in ASCII and in multi-byte UTF-8.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decodePullRequestData } from "./decode.ts";
import { createDiffUrls, diffUrl } from "./diff.ts";
import { buildTreeIndex } from "./model.ts";
import { sha256Hex } from "./sha256.ts";
import { loadFixtureJson, REAL_FIXTURE, TINY_FIXTURE } from "./test-support.ts";

const expectedHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

test("without a pull request, as for a local branch, no file links anywhere", () => {
  const data = decodePullRequestData(loadFixtureJson(TINY_FIXTURE));
  const index = buildTreeIndex(data.tree);
  const urls = createDiffUrls(null, index.paths);
  for (const node of index.changedFiles) assert.equal(diffUrl(urls, node), "");
});

test("links each changed file to its anchor in the files tab", () => {
  const data = decodePullRequestData(loadFixtureJson(TINY_FIXTURE));
  const index = buildTreeIndex(data.tree);
  const urls = createDiffUrls(data.pullRequest, index.paths);
  for (const node of index.changedFiles) {
    const path = index.paths[node] ?? "";
    assert.equal(diffUrl(urls, node), `https://github.com/wtreef/example/pull/1/files#diff-${expectedHash(path)}`);
    assert.equal(diffUrl(urls, node), urls.urls[node], "a link is hashed once and kept");
  }
  assert.equal(urls.urls[5], "", "unchanged LICENSE is never hashed");
});

test("every changed path of a real pull request hashes as node:crypto does", () => {
  const data = decodePullRequestData(loadFixtureJson(REAL_FIXTURE));
  const index = buildTreeIndex(data.tree);
  for (const node of index.changedFiles) {
    const path = index.paths[node] ?? "";
    assert.equal(sha256Hex(path), expectedHash(path), path);
  }
});

test("hashes across block boundaries and multi-byte characters", () => {
  for (let length = 0; length <= 130; length++) {
    const ascii = "a".repeat(length);
    assert.equal(sha256Hex(ascii), expectedHash(ascii), `${length} ASCII bytes`);
  }
  for (const text of ["docs/żółw.md", "src/日本語/ファイル.ts", "emoji/🦀.rs", "é".repeat(40)]) {
    assert.equal(sha256Hex(text), expectedHash(text), text);
  }
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});
