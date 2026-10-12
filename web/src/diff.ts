// GitHub anchors each file in a PR's "Files changed" tab at
// #diff-{sha256hex(path)}. A file's anchor is hashed the first time its
// link is needed and then kept: the file list builds a screenful of rows at
// a time, and a click on a tile must call window.open synchronously or
// popup blockers step in.

import { assert } from "./assert.ts";
import type { PullRequest } from "./decode.ts";
import { sha256Hex } from "./sha256.ts";

export function filesTabUrl(pullRequest: PullRequest): string {
  const owner = encodeURIComponent(pullRequest.owner);
  const repo = encodeURIComponent(pullRequest.repo);
  return `https://github.com/${owner}/${repo}/pull/${pullRequest.number}/files`;
}

export interface DiffUrls {
  /** "" when there is no pull request, as for a local branch: then no file has a diff. */
  readonly filesTab: string;
  /** Paths by node, as in TreeIndex. */
  readonly paths: readonly string[];
  /** Links by node; "" until a node's link is first asked for. */
  readonly urls: string[];
}

export function createDiffUrls(pullRequest: PullRequest | null, paths: readonly string[]): DiffUrls {
  const filesTab = pullRequest === null ? "" : filesTabUrl(pullRequest);
  return { filesTab, paths, urls: new Array<string>(paths.length).fill("") };
}

/** The link to a changed file's diff in the files tab; "" when there is no pull request. */
export function diffUrl(diffUrls: DiffUrls, node: number): string {
  if (diffUrls.filesTab === "") return "";
  const known = diffUrls.urls[node] ?? "";
  if (known !== "") return known;
  const path = diffUrls.paths[node] ?? "";
  assert(path !== "", "only files with a path have a diff");
  const url = `${diffUrls.filesTab}#diff-${sha256Hex(path)}`;
  diffUrls.urls[node] = url;
  return url;
}
