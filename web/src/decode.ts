// Parse, don't validate: the API JSON becomes typed arrays here, every
// invariant from docs/wire-format.md is checked once, and the rest of the
// client trusts the types. A violation is a server bug, so it throws.

import { assert } from "./assert.ts";
import { isOwnerName, isPullNumber, isRepoName } from "./route.ts";

export const NodeKind = { directory: 0, file: 1, collapsedDirectory: 2, rest: 3 } as const;
export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind];
const NODE_KIND_MAX = 3;

export const FileStatus = { unchanged: 0, added: 1, modified: 2, deleted: 3, renamed: 4 } as const;
export type FileStatus = (typeof FileStatus)[keyof typeof FileStatus];
const FILE_STATUS_MAX = 4;

export const PULL_REQUEST_STATES = ["open", "closed", "merged"] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

export const API_ERROR_CODES = [
  "bad_request",
  "not_found",
  "too_many_requests",
  "upstream_error",
  "github_rate_limited",
  "local_error",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<ApiErrorCode, number>> = {
  bad_request: 400,
  not_found: 404,
  too_many_requests: 429,
  upstream_error: 502,
  github_rate_limited: 503,
  local_error: 500,
};

export interface PullRequest {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: string;
  readonly state: PullRequestState;
  readonly baseRef: string;
  readonly headRef: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
}

/** A local branch: the working tree against where it left its base (GET /api/local). */
export interface Branch {
  /** The checkout's directory name. */
  readonly repo: string;
  /** "" when HEAD is detached. */
  readonly headRef: string;
  readonly baseRef: string;
  /** The merge base of baseRef and HEAD. */
  readonly baseSha: string;
  readonly headSha: string;
  readonly uncommitted: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
}

/** What the header totals describe: a pull request or a branch, as a whole. */
export interface ChangeSummary {
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
}

/** Struct of arrays; node `i` is the `i`-th element of every column. */
export interface Tree {
  readonly nodeCount: number;
  readonly names: readonly string[];
  readonly parents: Int32Array;
  readonly kinds: Uint8Array;
  readonly statuses: Uint8Array;
  readonly bytes: Float64Array;
  readonly additions: Uint32Array;
  readonly deletions: Uint32Array;
  readonly fileCounts: Uint32Array;
}

export interface PullRequestData {
  readonly kind: "pullRequest";
  readonly pullRequest: PullRequest;
  readonly tree: Tree;
  readonly truncatedFiles: boolean;
  readonly truncatedTree: boolean;
  readonly fetchedAtMs: number;
}

export interface BranchData {
  readonly kind: "branch";
  readonly branch: Branch;
  readonly tree: Tree;
  /** git lists everything, so nothing is ever missing. */
  readonly truncatedFiles: false;
  readonly truncatedTree: false;
  readonly fetchedAtMs: number;
}

/** Everything the treemap view can show. */
export type TreemapData = PullRequestData | BranchData;

export interface ApiError {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly httpStatus: number;
  /** Seconds to wait before retrying, when the server said so. */
  readonly retryAfterSeconds: number | null;
}

const WIRE_FORMAT_VERSION = 1;
const UINT32_MAX = 4294967295;
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const GITHUB_URL_PREFIX = "https://github.com/";

type JsonObject = Readonly<Record<string, unknown>>;
type IntegerColumn = Int32Array | Uint8Array | Uint32Array | Float64Array;

export function decodePullRequestData(json: unknown): PullRequestData {
  const object = expectObject(json, "response");
  assert(object["version"] === WIRE_FORMAT_VERSION, `response.version must be ${WIRE_FORMAT_VERSION}`);
  const truncated = expectObject(object["truncated"], "truncated");
  const fetchedAtText = expectString(object["fetchedAt"], "fetchedAt");
  const fetchedAtMs = Date.parse(fetchedAtText);
  assert(Number.isFinite(fetchedAtMs), "fetchedAt must be a timestamp");
  return {
    kind: "pullRequest",
    pullRequest: decodePullRequest(object["pullRequest"]),
    tree: decodeTree(object["tree"]),
    truncatedFiles: expectBoolean(truncated["files"], "truncated.files"),
    truncatedTree: expectBoolean(truncated["tree"], "truncated.tree"),
    fetchedAtMs,
  };
}

export function decodeBranchData(json: unknown): BranchData {
  const object = expectObject(json, "response");
  assert(object["version"] === WIRE_FORMAT_VERSION, `response.version must be ${WIRE_FORMAT_VERSION}`);
  const truncated = expectObject(object["truncated"], "truncated");
  assert(truncated["files"] === false && truncated["tree"] === false, "a local branch is never truncated");
  const fetchedAtMs = Date.parse(expectString(object["fetchedAt"], "fetchedAt"));
  assert(Number.isFinite(fetchedAtMs), "fetchedAt must be a timestamp");
  return {
    kind: "branch",
    branch: decodeBranch(object["branch"]),
    tree: decodeTree(object["tree"]),
    truncatedFiles: false,
    truncatedTree: false,
    fetchedAtMs,
  };
}

function decodeBranch(value: unknown): Branch {
  const object = expectObject(value, "branch");
  const repo = expectString(object["repo"], "branch.repo");
  const baseRef = expectString(object["baseRef"], "branch.baseRef");
  const baseSha = expectString(object["baseSha"], "branch.baseSha");
  const headSha = expectString(object["headSha"], "branch.headSha");
  assert(repo !== "", "branch.repo must not be empty");
  assert(baseRef !== "", "branch.baseRef must not be empty");
  assert(SHA_PATTERN.test(baseSha), "branch.baseSha must be a commit hash");
  assert(SHA_PATTERN.test(headSha), "branch.headSha must be a commit hash");
  return {
    repo,
    headRef: expectString(object["headRef"], "branch.headRef"),
    baseRef,
    baseSha,
    headSha,
    uncommitted: expectBoolean(object["uncommitted"], "branch.uncommitted"),
    additions: expectInteger(object["additions"], 0, Number.MAX_SAFE_INTEGER, "branch.additions"),
    deletions: expectInteger(object["deletions"], 0, Number.MAX_SAFE_INTEGER, "branch.deletions"),
    changedFiles: expectInteger(object["changedFiles"], 0, Number.MAX_SAFE_INTEGER, "branch.changedFiles"),
  };
}

function decodePullRequest(value: unknown): PullRequest {
  const object = expectObject(value, "pullRequest");
  const owner = expectString(object["owner"], "pullRequest.owner");
  const repo = expectString(object["repo"], "pullRequest.repo");
  const number = expectInteger(object["number"], 1, Number.MAX_SAFE_INTEGER, "pullRequest.number");
  const url = expectString(object["url"], "pullRequest.url");
  const state = expectString(object["state"], "pullRequest.state");
  const baseSha = expectString(object["baseSha"], "pullRequest.baseSha");
  const headSha = expectString(object["headSha"], "pullRequest.headSha");
  assert(isOwnerName(owner), "pullRequest.owner must be a GitHub owner name");
  assert(isRepoName(repo), "pullRequest.repo must be a GitHub repository name");
  assert(isPullNumber(number), "pullRequest.number must be a pull request number");
  assert(url.startsWith(GITHUB_URL_PREFIX), "pullRequest.url must point at github.com");
  assert(isPullRequestState(state), "pullRequest.state must be open, closed or merged");
  assert(SHA_PATTERN.test(baseSha), "pullRequest.baseSha must be a commit hash");
  assert(SHA_PATTERN.test(headSha), "pullRequest.headSha must be a commit hash");
  return {
    owner,
    repo,
    number,
    title: expectString(object["title"], "pullRequest.title"),
    url,
    author: expectString(object["author"], "pullRequest.author"),
    state,
    baseRef: expectString(object["baseRef"], "pullRequest.baseRef"),
    headRef: expectString(object["headRef"], "pullRequest.headRef"),
    baseSha,
    headSha,
    additions: expectInteger(object["additions"], 0, Number.MAX_SAFE_INTEGER, "pullRequest.additions"),
    deletions: expectInteger(object["deletions"], 0, Number.MAX_SAFE_INTEGER, "pullRequest.deletions"),
    changedFiles: expectInteger(object["changedFiles"], 0, Number.MAX_SAFE_INTEGER, "pullRequest.changedFiles"),
  };
}

function isPullRequestState(text: string): text is PullRequestState {
  return (PULL_REQUEST_STATES as readonly string[]).includes(text);
}

function decodeTree(value: unknown): Tree {
  const object = expectObject(value, "tree");
  const namesJson = expectArray(object["names"], "tree.names");
  const nodeCount = namesJson.length;
  assert(nodeCount >= 1, "tree must contain at least the root");
  assert(nodeCount <= UINT32_MAX, "tree is too large to index");

  const names: string[] = new Array<string>(nodeCount);
  for (let index = 0; index < nodeCount; index++) {
    names[index] = expectString(namesJson[index], "tree.names[]");
  }
  const tree: Tree = {
    nodeCount,
    names,
    parents: decodeColumn(object["parents"], new Int32Array(nodeCount), -1, 2147483647, "parents"),
    kinds: decodeColumn(object["kinds"], new Uint8Array(nodeCount), 0, NODE_KIND_MAX, "kinds"),
    statuses: decodeColumn(object["statuses"], new Uint8Array(nodeCount), 0, FILE_STATUS_MAX, "statuses"),
    bytes: decodeColumn(object["bytes"], new Float64Array(nodeCount), 0, Number.MAX_SAFE_INTEGER, "bytes"),
    additions: decodeColumn(object["additions"], new Uint32Array(nodeCount), 0, UINT32_MAX, "additions"),
    deletions: decodeColumn(object["deletions"], new Uint32Array(nodeCount), 0, UINT32_MAX, "deletions"),
    fileCounts: decodeColumn(object["fileCounts"], new Uint32Array(nodeCount), 0, UINT32_MAX, "fileCounts"),
  };
  checkTreeInvariants(tree);
  return tree;
}

function decodeColumn<Column extends IntegerColumn>(
  value: unknown,
  column: Column,
  minimum: number,
  maximum: number,
  name: string,
): Column {
  const values = expectArray(value, `tree.${name}`);
  assert(values.length === column.length, `tree.${name} must have one entry per node`);
  const context = `tree.${name}[]`;
  for (let index = 0; index < values.length; index++) {
    column[index] = expectInteger(values[index], minimum, maximum, context);
  }
  return column;
}

/** Checks every tree invariant from the contract. */
function checkTreeInvariants(tree: Tree): void {
  assert(tree.names[0] === "", "root name must be empty");
  assert(tree.parents[0] === -1, "root parent must be -1");
  assert(tree.kinds[0] === NodeKind.directory, "root must be a directory");
  for (let index = 0; index < tree.nodeCount; index++) {
    checkNodeValues(tree, index);
  }
  checkParentsAndNames(tree);
  checkDirectoriesContainChanges(tree);
}

function checkNodeValues(tree: Tree, index: number): void {
  const kind = tree.kinds[index];
  const status = tree.statuses[index] ?? -1;
  const additions = tree.additions[index] ?? -1;
  const deletions = tree.deletions[index] ?? -1;
  const fileCount = tree.fileCounts[index] ?? -1;
  const bytes = tree.bytes[index] ?? -1;
  if (kind === NodeKind.directory) {
    assert(status === 0, () => `directory ${index} must not carry a status`);
    assert(bytes === 0, () => `directory ${index} must not carry bytes`);
    assert(additions === 0, () => `directory ${index} must not carry additions`);
    assert(deletions === 0, () => `directory ${index} must not carry deletions`);
    assert(fileCount === 0, () => `directory ${index} must not carry a file count`);
  } else if (kind === NodeKind.file) {
    assert(fileCount === 1, () => `file ${index} must count as one file`);
    if (status === FileStatus.unchanged) {
      assert(additions === 0, () => `unchanged file ${index} must have no additions`);
      assert(deletions === 0, () => `unchanged file ${index} must have no deletions`);
    }
  } else {
    assert(kind === NodeKind.collapsedDirectory || kind === NodeKind.rest, () => `node ${index} has an unknown kind`);
    assert(status === FileStatus.unchanged, () => `context node ${index} must be unchanged`);
    assert(additions === 0, () => `context node ${index} must have no additions`);
    assert(deletions === 0, () => `context node ${index} must have no deletions`);
    assert(fileCount >= 1, () => `context node ${index} must represent at least one file`);
  }
}

function checkParentsAndNames(tree: Tree): void {
  // Sibling names by parent. Rest nodes have empty names, so the same sets
  // also enforce at most one rest node per directory.
  const siblingNames = new Map<number, Set<string>>();
  for (let index = 1; index < tree.nodeCount; index++) {
    const parent = tree.parents[index] ?? -1;
    const name = tree.names[index] ?? "";
    assert(parent >= 0, () => `node ${index} must have a parent`);
    assert(parent < index, () => `node ${index} must come after its parent`);
    assert(tree.kinds[parent] === NodeKind.directory, () => `parent of node ${index} must be a directory`);
    if (tree.kinds[index] === NodeKind.rest) {
      assert(name === "", () => `rest node ${index} must be unnamed`);
    } else {
      assert(name !== "", () => `node ${index} must have a name`);
      assert(!name.includes("/"), () => `name of node ${index} must not contain "/"`);
    }
    let names = siblingNames.get(parent);
    if (names === undefined) {
      names = new Set();
      siblingNames.set(parent, names);
    }
    assert(!names.has(name), () => `node ${index} duplicates a sibling`);
    names.add(name);
  }
}

function checkDirectoriesContainChanges(tree: Tree): void {
  const changedBelow = new Uint32Array(tree.nodeCount);
  for (let index = tree.nodeCount - 1; index >= 1; index--) {
    if (tree.kinds[index] === NodeKind.file && tree.statuses[index] !== FileStatus.unchanged) {
      changedBelow[index] = 1;
    }
    if (tree.kinds[index] === NodeKind.directory) {
      assert((changedBelow[index] ?? 0) > 0, () => `directory ${index} must contain a changed file`);
    }
    const parent = tree.parents[index] ?? 0;
    changedBelow[parent] = (changedBelow[parent] ?? 0) + (changedBelow[index] ?? 0);
  }
}

/** Decodes a non-200 API response. `json` is the parsed body. */
export function decodeApiError(httpStatus: number, json: unknown, retryAfterHeader: string | null, nowMs: number): ApiError {
  const object = expectObject(json, "error response");
  const code = expectString(object["error"], "error");
  assert(isApiErrorCode(code), "error must be a known code");
  assert(HTTP_STATUS_BY_ERROR_CODE[code] === httpStatus, `error ${code} must come with HTTP ${HTTP_STATUS_BY_ERROR_CODE[code]}`);
  return {
    code,
    message: expectString(object["message"], "message"),
    httpStatus,
    retryAfterSeconds: parseRetryAfter(retryAfterHeader, nowMs),
  };
}

function isApiErrorCode(text: string): text is ApiErrorCode {
  return (API_ERROR_CODES as readonly string[]).includes(text);
}

/** Retry-After is either delta-seconds or an HTTP date (RFC 9110 §10.2.3). */
export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (header === null) return null;
  const text = header.trim();
  if (/^[0-9]{1,9}$/.test(text)) return Number(text);
  const dateMs = Date.parse(text);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, Math.ceil((dateMs - nowMs) / 1000));
}

function expectObject(value: unknown, context: string): JsonObject {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `${context} must be an object`);
  return value as JsonObject;
}

function expectArray(value: unknown, context: string): readonly unknown[] {
  assert(Array.isArray(value), `${context} must be an array`);
  return value;
}

function expectString(value: unknown, context: string): string {
  assert(typeof value === "string", () => `${context} must be a string`);
  return value;
}

function expectBoolean(value: unknown, context: string): boolean {
  assert(typeof value === "boolean", `${context} must be a boolean`);
  return value;
}

/** Called once per value of every tree column, so a valid value returns before any check builds its message. */
function expectInteger(value: unknown, minimum: number, maximum: number, context: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum) return value;
  assert(typeof value === "number", `${context} must be a number`);
  assert(Number.isSafeInteger(value), `${context} must be an integer`);
  assert(value >= minimum, `${context} must be at least ${minimum}`);
  assert(value <= maximum, `${context} must be at most ${maximum}`);
  return value;
}
