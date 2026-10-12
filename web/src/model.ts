// Derived data over a decoded tree, and the filters that turn it into
// per-node weights. Everything here is pure and runs in single forward or
// reverse passes: parents precede children, so no recursion is needed.

import { assert } from "./assert.ts";
import { FileStatus, NodeKind, type Tree } from "./decode.ts";
import { activeRegex, EMPTY_PATH_PATTERN, type PathPattern, patternSource } from "./pattern.ts";

/** Changed files with no head bytes (deleted, or missing from a truncated tree) are sized from their churn. */
export const ESTIMATED_BYTES_PER_CHANGED_LINE = 40;
const ESTIMATED_BYTES_MIN = 40;
/** Type chips show this many extensions; the rest fold into "other". */
const TYPE_BUCKETS_NAMED_MAX = 8;
export const TYPE_KEY_NONE = "(none)";
export const TYPE_KEY_OTHER = "(other)";
const TYPE_BUCKET_NONE = 255;

const GENERATED_FILE_NAMES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "composer.lock",
  "Gemfile.lock",
]);
const GENERATED_FILE_SUFFIXES: readonly string[] = [".min.js", ".min.css", ".map", ".snap"];
const GENERATED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(["dist", "build", "vendor", "__generated__", "generated"]);
const GENERATED_NAME_INFIX = ".generated.";

export interface TypeBucket {
  readonly key: string;
  readonly count: number;
}

export interface TreeIndex {
  /** Children of node `i` are `childIndices[childStart[i] .. childStart[i + 1])`, in index order. */
  readonly childStart: Uint32Array;
  readonly childIndices: Uint32Array;
  readonly depths: Uint32Array;
  /** Full path; "" for the root and for rest nodes, which have no path. */
  readonly paths: readonly string[];
  readonly generated: Uint8Array;
  /** Index into `typeBuckets` for changed files; TYPE_BUCKET_NONE otherwise. */
  readonly typeBucketOfNode: Uint8Array;
  readonly typeBuckets: readonly TypeBucket[];
  readonly statusCounts: Uint32Array;
  readonly generatedChangedCount: number;
  /** Unfiltered subtree totals, for tooltips and headers. */
  readonly subtreeBytes: Float64Array;
  readonly subtreeAdditions: Float64Array;
  readonly subtreeDeletions: Float64Array;
  readonly subtreeFiles: Float64Array;
  readonly subtreeChangedFiles: Uint32Array;
  /** Changed file nodes sorted by churn descending, then path ascending. */
  readonly changedFiles: Uint32Array;
  readonly churnMax: number;
}

export const SizeMode = { context: "context", churn: "churn" } as const;
export type SizeMode = (typeof SizeMode)[keyof typeof SizeMode];

export interface Filters {
  readonly sizeMode: SizeMode;
  /** Bit `1 << status` set means files with that status are hidden. */
  readonly hiddenStatuses: number;
  readonly hiddenTypes: ReadonlySet<string>;
  readonly showUnchanged: boolean;
  readonly showGenerated: boolean;
  /** Keeps only files whose path matches, when valid. */
  readonly include: PathPattern;
  /** Drops files whose path matches, when valid. */
  readonly exclude: PathPattern;
}

export const DEFAULT_FILTERS: Filters = {
  // Churn keeps every change visible; context sizes by bytes, where a large
  // unchanged folder can shrink the actual changes to nothing.
  sizeMode: SizeMode.churn,
  hiddenStatuses: 0,
  hiddenTypes: new Set(),
  showUnchanged: true,
  showGenerated: true,
  include: EMPTY_PATH_PATTERN,
  exclude: EMPTY_PATH_PATTERN,
};

export function isChangedFile(tree: Tree, node: number): boolean {
  return tree.kinds[node] === NodeKind.file && tree.statuses[node] !== FileStatus.unchanged;
}

export function churnOf(tree: Tree, node: number): number {
  return (tree.additions[node] ?? 0) + (tree.deletions[node] ?? 0);
}

export function buildTreeIndex(tree: Tree): TreeIndex {
  const { childStart, childIndices } = buildChildren(tree);
  const { paths, depths } = buildPaths(tree);
  const generated = new Uint8Array(tree.nodeCount);
  for (let node = 1; node < tree.nodeCount; node++) {
    generated[node] = isGeneratedNode(tree, node, paths[node] ?? "") ? 1 : 0;
  }
  const { typeBuckets, typeBucketOfNode } = buildTypeBuckets(tree);
  const statusCounts = new Uint32Array(FileStatus.renamed + 1);
  let generatedChangedCount = 0;
  for (let node = 0; node < tree.nodeCount; node++) {
    if (!isChangedFile(tree, node)) continue;
    statusCounts[tree.statuses[node] ?? 0]! += 1;
    generatedChangedCount += generated[node] ?? 0;
  }
  const changedFiles = sortChangedFiles(tree, paths);
  let churnMax = 0;
  for (const node of changedFiles) churnMax = Math.max(churnMax, churnOf(tree, node));
  return {
    childStart,
    childIndices,
    depths,
    paths,
    generated,
    typeBucketOfNode,
    typeBuckets,
    statusCounts,
    generatedChangedCount,
    ...buildSubtreeTotals(tree),
    changedFiles,
    churnMax,
  };
}

function buildChildren(tree: Tree): { childStart: Uint32Array; childIndices: Uint32Array } {
  const childStart = new Uint32Array(tree.nodeCount + 1);
  for (let node = 1; node < tree.nodeCount; node++) {
    childStart[(tree.parents[node] ?? 0) + 1]! += 1;
  }
  for (let node = 0; node < tree.nodeCount; node++) {
    childStart[node + 1]! += childStart[node] ?? 0;
  }
  const cursor = childStart.slice(0, tree.nodeCount);
  const childIndices = new Uint32Array(Math.max(0, tree.nodeCount - 1));
  for (let node = 1; node < tree.nodeCount; node++) {
    const parent = tree.parents[node] ?? 0;
    childIndices[cursor[parent]!] = node;
    cursor[parent]! += 1;
  }
  assert(childStart[tree.nodeCount] === tree.nodeCount - 1, "every non-root node is someone's child");
  return { childStart, childIndices };
}

function buildPaths(tree: Tree): { paths: string[]; depths: Uint32Array } {
  const paths: string[] = new Array<string>(tree.nodeCount);
  const depths = new Uint32Array(tree.nodeCount);
  paths[0] = "";
  for (let node = 1; node < tree.nodeCount; node++) {
    const parent = tree.parents[node] ?? 0;
    const parentPath = paths[parent] ?? "";
    depths[node] = (depths[parent] ?? 0) + 1;
    if (tree.kinds[node] === NodeKind.rest) {
      paths[node] = "";
    } else {
      paths[node] = parentPath === "" ? (tree.names[node] ?? "") : `${parentPath}/${tree.names[node] ?? ""}`;
    }
  }
  return { paths, depths };
}

/** Lockfiles, minified bundles, source maps, snapshots, and anything under build output directories. */
export function isGeneratedPath(path: string, isDirectory: boolean): boolean {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  const directoryCount = isDirectory ? segments.length : segments.length - 1;
  for (let segment = 0; segment < directoryCount; segment++) {
    if (GENERATED_DIRECTORY_NAMES.has(segments[segment] ?? "")) return true;
  }
  if (isDirectory) return false;
  if (GENERATED_FILE_NAMES.has(name)) return true;
  if (name.includes(GENERATED_NAME_INFIX)) return true;
  const nameLower = name.toLowerCase();
  return GENERATED_FILE_SUFFIXES.some((suffix) => nameLower.endsWith(suffix));
}

function isGeneratedNode(tree: Tree, node: number, path: string): boolean {
  const kind = tree.kinds[node];
  if (kind === NodeKind.rest) return false;
  return isGeneratedPath(path, kind !== NodeKind.file);
}

/** Lowercased extension after the last dot; dotfiles and extensionless names map to TYPE_KEY_NONE. */
export function typeKeyOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return TYPE_KEY_NONE;
  return name.slice(dot + 1).toLowerCase();
}

function buildTypeBuckets(tree: Tree): { typeBuckets: TypeBucket[]; typeBucketOfNode: Uint8Array } {
  const countByKey = new Map<string, number>();
  for (let node = 0; node < tree.nodeCount; node++) {
    if (!isChangedFile(tree, node)) continue;
    const key = typeKeyOf(tree.names[node] ?? "");
    countByKey.set(key, (countByKey.get(key) ?? 0) + 1);
  }
  const ranked = [...countByKey].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const named = ranked.slice(0, TYPE_BUCKETS_NAMED_MAX);
  const typeBuckets: TypeBucket[] = named.map(([key, count]) => ({ key, count }));
  const otherCount = ranked.slice(TYPE_BUCKETS_NAMED_MAX).reduce((sum, [, count]) => sum + count, 0);
  if (otherCount > 0) typeBuckets.push({ key: TYPE_KEY_OTHER, count: otherCount });
  assert(typeBuckets.length < TYPE_BUCKET_NONE, "type buckets fit in a byte");

  const bucketByKey = new Map(named.map(([key], bucket) => [key, bucket]));
  const otherBucket = typeBuckets.length - 1;
  const typeBucketOfNode = new Uint8Array(tree.nodeCount).fill(TYPE_BUCKET_NONE);
  for (let node = 0; node < tree.nodeCount; node++) {
    if (!isChangedFile(tree, node)) continue;
    typeBucketOfNode[node] = bucketByKey.get(typeKeyOf(tree.names[node] ?? "")) ?? otherBucket;
  }
  return { typeBuckets, typeBucketOfNode };
}

function buildSubtreeTotals(tree: Tree) {
  const subtreeBytes = new Float64Array(tree.bytes);
  const subtreeAdditions = Float64Array.from(tree.additions);
  const subtreeDeletions = Float64Array.from(tree.deletions);
  const subtreeFiles = Float64Array.from(tree.fileCounts);
  const subtreeChangedFiles = new Uint32Array(tree.nodeCount);
  for (let node = tree.nodeCount - 1; node >= 1; node--) {
    if (isChangedFile(tree, node)) subtreeChangedFiles[node] = 1;
    const parent = tree.parents[node] ?? 0;
    subtreeBytes[parent]! += subtreeBytes[node] ?? 0;
    subtreeAdditions[parent]! += subtreeAdditions[node] ?? 0;
    subtreeDeletions[parent]! += subtreeDeletions[node] ?? 0;
    subtreeFiles[parent]! += subtreeFiles[node] ?? 0;
    subtreeChangedFiles[parent]! += subtreeChangedFiles[node] ?? 0;
  }
  return { subtreeBytes, subtreeAdditions, subtreeDeletions, subtreeFiles, subtreeChangedFiles };
}

function sortChangedFiles(tree: Tree, paths: readonly string[]): Uint32Array {
  const nodes: number[] = [];
  for (let node = 0; node < tree.nodeCount; node++) {
    if (isChangedFile(tree, node)) nodes.push(node);
  }
  nodes.sort((a, b) => {
    const churnDifference = churnOf(tree, b) - churnOf(tree, a);
    if (churnDifference !== 0) return churnDifference;
    const pathA = paths[a] ?? "";
    const pathB = paths[b] ?? "";
    return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
  });
  return Uint32Array.from(nodes);
}

/** Context weight: head bytes, or an estimate from churn when a changed file has none. */
function contextWeightOfChangedFile(bytes: number, additions: number, deletions: number): number {
  if (bytes > 0) return bytes;
  return Math.max(ESTIMATED_BYTES_MIN, (additions + deletions) * ESTIMATED_BYTES_PER_CHANGED_LINE);
}

function churnWeightOfChangedFile(additions: number, deletions: number): number {
  return Math.max(additions + deletions, 1);
}

/** Bitmask over type bucket indices, built once per filter change. */
function hiddenTypeMask(index: TreeIndex, hiddenTypes: ReadonlySet<string>): number {
  let mask = 0;
  for (let bucket = 0; bucket < index.typeBuckets.length; bucket++) {
    if (hiddenTypes.has(index.typeBuckets[bucket]?.key ?? "")) mask |= 1 << bucket;
  }
  return mask;
}

/**
 * Writes each node's weight under `filters` into `weights`: leaves first,
 * then one reverse pass sums children into directories. Filtered-out
 * leaves weigh 0, and zero-weight nodes are not laid out.
 */
export function computeWeights(tree: Tree, index: TreeIndex, filters: Filters, weights: Float64Array): void {
  assert(weights.length === tree.nodeCount, "weights must have one slot per node");
  const typeMask = hiddenTypeMask(index, filters.hiddenTypes);
  const showContext = filters.showUnchanged && filters.sizeMode === SizeMode.context;
  const include = activeRegex(filters.include);
  const exclude = activeRegex(filters.exclude);
  for (let node = 0; node < tree.nodeCount; node++) {
    const weight = leafWeight(tree, index, node, filters, typeMask, showContext);
    // Patterns run last and only on visible leaves: a regex test is the most expensive check here.
    weights[node] = weight > 0 && !passesPathPatterns(tree, index, node, include, exclude) ? 0 : weight;
  }
  for (let node = tree.nodeCount - 1; node >= 1; node--) {
    weights[tree.parents[node] ?? 0]! += weights[node] ?? 0;
  }
}

/** Directories weigh nothing of their own; their weight is the sum computed afterwards. */
function leafWeight(tree: Tree, index: TreeIndex, node: number, filters: Filters, typeMask: number, showContext: boolean): number {
  if (tree.kinds[node] === NodeKind.directory) return 0;
  if (isChangedFile(tree, node)) return changedFileWeight(tree, index, node, filters, typeMask);
  if (!showContext) return 0;
  if (!filters.showGenerated && index.generated[node] === 1) return 0;
  return tree.bytes[node] ?? 0;
}

function changedFileWeight(tree: Tree, index: TreeIndex, node: number, filters: Filters, typeMask: number): number {
  const status = tree.statuses[node] ?? 0;
  if ((filters.hiddenStatuses & (1 << status)) !== 0) return 0;
  if ((typeMask & (1 << (index.typeBucketOfNode[node] ?? 0))) !== 0) return 0;
  if (!filters.showGenerated && index.generated[node] === 1) return 0;
  const additions = tree.additions[node] ?? 0;
  const deletions = tree.deletions[node] ?? 0;
  if (filters.sizeMode === SizeMode.churn) return churnWeightOfChangedFile(additions, deletions);
  return contextWeightOfChangedFile(tree.bytes[node] ?? 0, additions, deletions);
}

/**
 * Leaves match on their own path; their contents are unknown. Rest nodes
 * have no path, so no include can name them and no exclude can remove them.
 */
function passesPathPatterns(tree: Tree, index: TreeIndex, node: number, include: RegExp | null, exclude: RegExp | null): boolean {
  const kind = tree.kinds[node];
  assert(kind !== NodeKind.directory, "patterns apply to leaves; directories sum their children");
  if (kind === NodeKind.rest) return include === null;
  const subject = patternSubject(tree, index, node);
  if (include !== null && !include.test(subject)) return false;
  if (exclude !== null && exclude.test(subject)) return false;
  return true;
}

/** The text a pattern is tested against: the full path, with a trailing "/" for collapsed folders, as tooltips show them. */
function patternSubject(tree: Tree, index: TreeIndex, node: number): string {
  const path = index.paths[node] ?? "";
  assert(path !== "", "only the root and rest nodes have no path");
  return tree.kinds[node] === NodeKind.collapsedDirectory ? `${path}/` : path;
}

/** Marks `zoomNode` and every node below it. Parents precede children, so one forward pass suffices. */
export function computeSubtreeMembership(tree: Tree, zoomNode: number, inside: Uint8Array): void {
  assert(inside.length === tree.nodeCount, "membership must have one slot per node");
  assert(tree.kinds[zoomNode] === NodeKind.directory, "zoom target must be a directory");
  inside.fill(0);
  inside[zoomNode] = 1;
  for (let node = zoomNode + 1; node < tree.nodeCount; node++) {
    inside[node] = inside[tree.parents[node] ?? 0] ?? 0;
  }
}

/** Finds the expanded directory at `path`, or -1. "" is the root. */
export function findDirectoryByPath(tree: Tree, index: TreeIndex, path: string): number {
  for (let node = 0; node < tree.nodeCount; node++) {
    if (tree.kinds[node] === NodeKind.directory && index.paths[node] === path) return node;
  }
  return -1;
}

export function filtersEqual(a: Filters, b: Filters): boolean {
  if (a.sizeMode !== b.sizeMode) return false;
  if (a.hiddenStatuses !== b.hiddenStatuses) return false;
  if (a.showUnchanged !== b.showUnchanged) return false;
  if (a.showGenerated !== b.showGenerated) return false;
  if (patternSource(a.include) !== patternSource(b.include)) return false;
  if (patternSource(a.exclude) !== patternSource(b.exclude)) return false;
  if (a.hiddenTypes.size !== b.hiddenTypes.size) return false;
  for (const key of a.hiddenTypes) {
    if (!b.hiddenTypes.has(key)) return false;
  }
  return true;
}

/** True when anything Reset would undo differs from the defaults. Size mode is a view choice, not a filter. */
export function hasActiveFilters(filters: Filters): boolean {
  return !filtersEqual({ ...filters, sizeMode: DEFAULT_FILTERS.sizeMode }, DEFAULT_FILTERS);
}
