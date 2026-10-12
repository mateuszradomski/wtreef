// GitHub anchors each file in a PR's "Files changed" tab at
// #diff-{sha256hex(path)}. The hashes are computed once after load, because
// crypto.subtle is async and a click handler must call window.open
// synchronously or popup blockers step in.

import { assert } from "./assert.ts";
import type { PullRequest } from "./decode.ts";
import type { TreeIndex } from "./model.ts";

export function filesTabUrl(pullRequest: PullRequest): string {
  const owner = encodeURIComponent(pullRequest.owner);
  const repo = encodeURIComponent(pullRequest.repo);
  return `https://github.com/${owner}/${repo}/pull/${pullRequest.number}/files`;
}

function hexOf(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Returns one URL per node: the file's diff anchor for changed files, and
 * "" for everything else. Falls back to the plain files tab when the page
 * is not a secure context and crypto.subtle is missing.
 */
export async function computeDiffUrls(pullRequest: PullRequest, index: TreeIndex, nodeCount: number): Promise<string[]> {
  const urls: string[] = new Array<string>(nodeCount).fill("");
  const base = filesTabUrl(pullRequest);
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    for (const node of index.changedFiles) urls[node] = base;
    return urls;
  }
  const encoder = new TextEncoder();
  const digests = await Promise.all(
    Array.from(index.changedFiles, (node) => subtle.digest("SHA-256", encoder.encode(index.paths[node] ?? ""))),
  );
  assert(digests.length === index.changedFiles.length, "one digest per changed file");
  for (let position = 0; position < digests.length; position++) {
    const node = index.changedFiles[position] ?? 0;
    const digest = digests[position];
    assert(digest !== undefined, "digest exists for every changed file");
    urls[node] = `${base}#diff-${hexOf(digest)}`;
  }
  return urls;
}
