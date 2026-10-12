// The changed files as a folder tree, for the sidebar's Tree view: only the
// changed files that pass the filters, plus the folders on their paths,
// rooted at the zoomed folder. A folder whose only visible child is a folder
// merges with it into one row ("packages/frontend/src"), as in GitHub's pull
// request file tree and VS Code's compact folders.
//
// Pure and iterative: one reverse pass aggregates the visible files into
// their folders (parents precede children), and an explicit stack emits rows
// in display order. Buffers are allocated once per tree and reused, like the
// layout's.

import { assert } from "./assert.ts";
import { NodeKind, type Tree } from "./decode.ts";
import { isChangedFile, type TreeIndex } from "./model.ts";

/** How the sidebar shows the changed files: a folder tree, or a flat list by churn. */
export const FileView = { tree: "tree", list: "list" } as const;
export type FileView = (typeof FileView)[keyof typeof FileView];

export const NO_ROW = -1;
const NO_NODE = -1;

/**
 * Case-insensitive, accent-aware names, as file trees in GitHub and editors
 * sort them. A Collator rather than localeCompare: it is built once, and
 * every option is spelled out instead of inherited from the runtime.
 */
const NAME_COLLATOR = new Intl.Collator("en", {
  usage: "sort",
  sensitivity: "accent",
  numeric: false,
  ignorePunctuation: false,
  caseFirst: "false",
});

export interface FileTree {
  /** Display children of node `i`, folders first, then files, each by name: `childIndices[childStart[i] .. childStart[i + 1])`. Only folders and changed files can ever be shown, so nothing else is listed. */
  readonly childStart: Uint32Array;
  readonly childIndices: Uint32Array;
  /** Per node, under the current filters: the changed files that pass them in its subtree (0 or 1 for a file), and their lines. */
  readonly visibleFiles: Uint32Array;
  readonly visibleAdditions: Float64Array;
  readonly visibleDeletions: Float64Array;
  /** The row that shows each node, or NO_ROW. Every folder of a merged chain maps to the chain's row. */
  readonly rowOfNode: Int32Array;
  rootNode: number;
  rowCount: number;
  /** The file, or the deepest folder of the chain: the one whose children follow the row. */
  readonly rowNodes: Uint32Array;
  /** The chain's first folder; the same as rowNodes for files and unmerged folders. */
  readonly rowChainTops: Uint32Array;
  /** 1 for rows directly under the root, as aria-level counts. */
  readonly rowLevels: Uint32Array;
  readonly rowParents: Int32Array;
  readonly rowExpanded: Uint8Array;
  /** aria-setsize and aria-posinset: the row's siblings under the same parent, and its 1-based place among them. */
  readonly rowSetSizes: Uint32Array;
  readonly rowPositions: Uint32Array;
  // The explicit stack that replaces recursion. Every node is pushed at most once.
  readonly stackNodes: Uint32Array;
  readonly stackParents: Int32Array;
  readonly stackSetSizes: Uint32Array;
  readonly stackPositions: Uint32Array;
}

export function createFileTree(tree: Tree, index: TreeIndex): FileTree {
  const { nodeCount } = tree;
  assert(nodeCount >= 1, "a tree has at least a root");
  return {
    ...buildDisplayChildren(tree, index),
    visibleFiles: new Uint32Array(nodeCount),
    visibleAdditions: new Float64Array(nodeCount),
    visibleDeletions: new Float64Array(nodeCount),
    rowOfNode: new Int32Array(nodeCount).fill(NO_ROW),
    rootNode: 0,
    rowCount: 0,
    rowNodes: new Uint32Array(nodeCount),
    rowChainTops: new Uint32Array(nodeCount),
    rowLevels: new Uint32Array(nodeCount),
    rowParents: new Int32Array(nodeCount),
    rowExpanded: new Uint8Array(nodeCount),
    rowSetSizes: new Uint32Array(nodeCount),
    rowPositions: new Uint32Array(nodeCount),
    stackNodes: new Uint32Array(nodeCount),
    stackParents: new Int32Array(nodeCount),
    stackSetSizes: new Uint32Array(nodeCount),
    stackPositions: new Uint32Array(nodeCount),
  };
}

/** Sorting depends only on names and kinds, never on filters, so it runs once per tree. */
function buildDisplayChildren(tree: Tree, index: TreeIndex): { childStart: Uint32Array; childIndices: Uint32Array } {
  const childStart = new Uint32Array(tree.nodeCount + 1);
  const childIndices = new Uint32Array(Math.max(0, tree.nodeCount - 1));
  const siblings: number[] = [];
  let count = 0;
  for (let node = 0; node < tree.nodeCount; node++) {
    childStart[node] = count;
    siblings.length = 0;
    const end = index.childStart[node + 1] ?? 0;
    for (let cursor = index.childStart[node] ?? 0; cursor < end; cursor++) {
      const child = index.childIndices[cursor] ?? 0;
      if (tree.kinds[child] === NodeKind.directory || isChangedFile(tree, child)) siblings.push(child);
    }
    siblings.sort((a, b) => compareDisplayOrder(tree, a, b));
    for (const child of siblings) childIndices[count++] = child;
  }
  childStart[tree.nodeCount] = count;
  assert(count <= childIndices.length, "display children are a subset of all children");
  return { childStart, childIndices };
}

function compareDisplayOrder(tree: Tree, a: number, b: number): number {
  const folderA = tree.kinds[a] === NodeKind.directory;
  const folderB = tree.kinds[b] === NodeKind.directory;
  if (folderA !== folderB) return folderA ? -1 : 1;
  const nameA = tree.names[a] ?? "";
  const nameB = tree.names[b] ?? "";
  const collated = NAME_COLLATOR.compare(nameA, nameB);
  if (collated !== 0) return collated;
  // "README.md" and "readme.md" can be siblings; code-unit order keeps them apart deterministically.
  const ordinal = nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
  assert(ordinal !== 0 || a === b, "sibling names are unique");
  return ordinal;
}

/**
 * Recomputes the rows for `weights` (a changed file is visible when its
 * weight is positive), rooted at `rootNode`, with the folders in `collapsed`
 * closed. A chain row is closed when any of its folders is: closing one
 * hides everything below the chain's end either way.
 */
export function computeFileTree(
  tree: Tree,
  index: TreeIndex,
  weights: Float64Array,
  rootNode: number,
  collapsed: ReadonlySet<number>,
  fileTree: FileTree,
): void {
  assert(weights.length === tree.nodeCount, "weights must be sized for this tree");
  assert(fileTree.visibleFiles.length === tree.nodeCount, "the file tree must be sized for this tree");
  assert(tree.kinds[rootNode] === NodeKind.directory, "the tree is rooted at a folder");
  fileTree.rootNode = rootNode;
  aggregateVisibleFiles(tree, index, weights, fileTree);
  emitRows(tree, collapsed, fileTree);
  assert(fileTree.rowCount <= tree.nodeCount, "every row shows a distinct node");
}

function aggregateVisibleFiles(tree: Tree, index: TreeIndex, weights: Float64Array, fileTree: FileTree): void {
  const { visibleFiles, visibleAdditions, visibleDeletions } = fileTree;
  visibleFiles.fill(0);
  visibleAdditions.fill(0);
  visibleDeletions.fill(0);
  for (const node of index.changedFiles) {
    if ((weights[node] ?? 0) <= 0) continue;
    visibleFiles[node] = 1;
    visibleAdditions[node] = tree.additions[node] ?? 0;
    visibleDeletions[node] = tree.deletions[node] ?? 0;
  }
  for (let node = tree.nodeCount - 1; node >= 1; node--) {
    if (visibleFiles[node] === 0) continue;
    const parent = tree.parents[node] ?? 0;
    visibleFiles[parent]! += visibleFiles[node] ?? 0;
    visibleAdditions[parent]! += visibleAdditions[node] ?? 0;
    visibleDeletions[parent]! += visibleDeletions[node] ?? 0;
  }
}

/** Pre-order walk: pop a row, append it, and push its visible children (if open) in reverse so the first pops next. */
function emitRows(tree: Tree, collapsed: ReadonlySet<number>, fileTree: FileTree): void {
  fileTree.rowOfNode.fill(NO_ROW);
  fileTree.rowCount = 0;
  let stackSize = pushVisibleChildren(fileTree, fileTree.rootNode, NO_ROW, 0);
  for (let step = 0; stackSize > 0; step++) {
    assert(step < tree.nodeCount, "every node is popped at most once");
    stackSize--;
    const top = fileTree.stackNodes[stackSize] ?? 0;
    const isFolder = tree.kinds[top] === NodeKind.directory;
    const end = isFolder ? chainEndOf(tree, fileTree, top) : top;
    const expanded = isFolder && !isChainCollapsed(tree, collapsed, top, end);
    const row = appendRow(tree, fileTree, top, end, stackSize, expanded);
    if (expanded) stackSize = pushVisibleChildren(fileTree, end, row, stackSize);
  }
}

function pushVisibleChildren(fileTree: FileTree, node: number, parentRow: number, stackSize: number): number {
  const start = fileTree.childStart[node] ?? 0;
  const end = fileTree.childStart[node + 1] ?? 0;
  let setSize = 0;
  for (let cursor = start; cursor < end; cursor++) {
    if ((fileTree.visibleFiles[fileTree.childIndices[cursor] ?? 0] ?? 0) > 0) setSize++;
  }
  assert(setSize > 0 || (fileTree.visibleFiles[node] ?? 0) === 0, "a visible folder has a visible child");
  let size = stackSize;
  let position = setSize;
  for (let cursor = end - 1; cursor >= start; cursor--) {
    const child = fileTree.childIndices[cursor] ?? 0;
    if ((fileTree.visibleFiles[child] ?? 0) === 0) continue;
    assert(size < fileTree.stackNodes.length, "the stack holds each node at most once");
    fileTree.stackNodes[size] = child;
    fileTree.stackParents[size] = parentRow;
    fileTree.stackSetSizes[size] = setSize;
    fileTree.stackPositions[size] = position;
    size++;
    position--;
  }
  assert(position === 0, "every visible child was pushed");
  return size;
}

/** Follows folders whose only visible child is a folder; returns the last one. */
function chainEndOf(tree: Tree, fileTree: FileTree, top: number): number {
  let current = top;
  for (let depth = 0; depth < tree.nodeCount; depth++) {
    const only = onlyVisibleChild(fileTree, current);
    if (only === NO_NODE || tree.kinds[only] !== NodeKind.directory) return current;
    current = only;
  }
  assert(false, "chains are bounded by the tree depth");
}

function onlyVisibleChild(fileTree: FileTree, node: number): number {
  const end = fileTree.childStart[node + 1] ?? 0;
  let only = NO_NODE;
  for (let cursor = fileTree.childStart[node] ?? 0; cursor < end; cursor++) {
    const child = fileTree.childIndices[cursor] ?? 0;
    if ((fileTree.visibleFiles[child] ?? 0) === 0) continue;
    if (only !== NO_NODE) return NO_NODE;
    only = child;
  }
  return only;
}

function isChainCollapsed(tree: Tree, collapsed: ReadonlySet<number>, top: number, end: number): boolean {
  if (collapsed.size === 0) return false;
  let current = end;
  for (let depth = 0; depth < tree.nodeCount; depth++) {
    if (collapsed.has(current)) return true;
    if (current === top) return false;
    current = tree.parents[current] ?? 0;
  }
  assert(false, "a chain end descends from its top");
}

/** Writes the row for the stack entry at `slot` and maps every node of its chain to it. */
function appendRow(tree: Tree, fileTree: FileTree, top: number, end: number, slot: number, expanded: boolean): number {
  const row = fileTree.rowCount;
  const parentRow = fileTree.stackParents[slot] ?? NO_ROW;
  assert(parentRow < row, "parents are emitted before their children");
  fileTree.rowNodes[row] = end;
  fileTree.rowChainTops[row] = top;
  fileTree.rowParents[row] = parentRow;
  fileTree.rowLevels[row] = parentRow === NO_ROW ? 1 : (fileTree.rowLevels[parentRow] ?? 0) + 1;
  fileTree.rowExpanded[row] = expanded ? 1 : 0;
  fileTree.rowSetSizes[row] = fileTree.stackSetSizes[slot] ?? 0;
  fileTree.rowPositions[row] = fileTree.stackPositions[slot] ?? 0;
  fileTree.rowCount = row + 1;
  let current = end;
  for (let depth = 0; depth < tree.nodeCount; depth++) {
    assert(fileTree.rowOfNode[current] === NO_ROW, "a node is shown by one row");
    fileTree.rowOfNode[current] = row;
    if (current === top) return row;
    current = tree.parents[current] ?? 0;
  }
  assert(false, "a chain end descends from its top");
}

export function isFolderRow(tree: Tree, fileTree: FileTree, row: number): boolean {
  assert(row >= 0 && row < fileTree.rowCount, "the row exists");
  return tree.kinds[fileTree.rowNodes[row] ?? 0] === NodeKind.directory;
}

/** A file's name, or a chain's folder names joined by "/". */
export function rowLabel(tree: Tree, fileTree: FileTree, row: number): string {
  assert(row >= 0 && row < fileTree.rowCount, "the row exists");
  const top = fileTree.rowChainTops[row] ?? 0;
  const names: string[] = [];
  let current = fileTree.rowNodes[row] ?? 0;
  for (let depth = 0; depth < tree.nodeCount; depth++) {
    names.push(tree.names[current] ?? "");
    if (current === top) return names.reverse().join("/");
    current = tree.parents[current] ?? 0;
  }
  assert(false, "a chain end descends from its top");
}

/** The row showing `node`, or else the nearest ancestor that has one (a closed folder hides its descendants). */
export function nearestRow(tree: Tree, fileTree: FileTree, node: number): number {
  if (node < 0) return NO_ROW;
  assert(node < tree.nodeCount, "the node exists");
  let current = node;
  for (let depth = 0; depth < tree.nodeCount; depth++) {
    const row = fileTree.rowOfNode[current] ?? NO_ROW;
    if (row !== NO_ROW) return row;
    if (current === fileTree.rootNode || current === 0) return NO_ROW;
    current = tree.parents[current] ?? 0;
  }
  assert(false, "ancestors are bounded by the tree depth");
}

/** The row to mark for a hovered tile: none for context and filtered-out tiles, which the tree does not list. */
export function rowForHoveredNode(tree: Tree, fileTree: FileTree, node: number): number {
  if (node < 0) return NO_ROW;
  if ((fileTree.visibleFiles[node] ?? 0) === 0) return NO_ROW;
  return nearestRow(tree, fileTree, node);
}

/**
 * The collapsed set after opening or closing the chain `top`..`end`.
 * Closing marks the chain's end, whose children the row hides. Opening
 * clears every folder in the chain, since any one of them keeps it closed.
 */
export function withFolderExpanded(
  collapsed: ReadonlySet<number>,
  tree: Tree,
  top: number,
  end: number,
  expanded: boolean,
): ReadonlySet<number> {
  assert(tree.kinds[top] === NodeKind.directory, "only folders open and close");
  assert(tree.kinds[end] === NodeKind.directory, "only folders open and close");
  const next = new Set(collapsed);
  if (!expanded) {
    next.add(end);
    return next;
  }
  let current = end;
  for (let depth = 0; depth < tree.nodeCount; depth++) {
    next.delete(current);
    if (current === top) return next;
    current = tree.parents[current] ?? 0;
  }
  assert(false, "a chain end descends from its top");
}

/** What a key does in the tree, after the WAI-ARIA tree view pattern. */
export const TreeKeyKind = { none: 0, focus: 1, expand: 2, collapse: 3 } as const;
export type TreeKeyKind = (typeof TreeKeyKind)[keyof typeof TreeKeyKind];

export interface TreeKeyAction {
  readonly kind: TreeKeyKind;
  readonly row: number;
}

const NO_KEY_ACTION: TreeKeyAction = { kind: TreeKeyKind.none, row: NO_ROW };

/**
 * The action for `key` pressed on `row`. Arrows, Home and End are always
 * handled, if only by staying put, so they never scroll the list; `none`
 * leaves the key to the browser, as for Enter on a file, which follows its
 * link.
 */
export function treeKeyAction(tree: Tree, fileTree: FileTree, row: number, key: string): TreeKeyAction {
  const { rowCount } = fileTree;
  assert(row >= 0 && row < rowCount, "keys go to rows");
  if (key === "ArrowDown") return focusRow(Math.min(row + 1, rowCount - 1));
  if (key === "ArrowUp") return focusRow(Math.max(row - 1, 0));
  if (key === "Home") return focusRow(0);
  if (key === "End") return focusRow(rowCount - 1);
  const isFolder = isFolderRow(tree, fileTree, row);
  const expanded = fileTree.rowExpanded[row] === 1;
  if (key === "ArrowRight") {
    if (!isFolder) return focusRow(row);
    if (!expanded) return { kind: TreeKeyKind.expand, row };
    const child = row + 1;
    return child < rowCount && fileTree.rowParents[child] === row ? focusRow(child) : focusRow(row);
  }
  if (key === "ArrowLeft") {
    if (isFolder && expanded) return { kind: TreeKeyKind.collapse, row };
    const parent = fileTree.rowParents[row] ?? NO_ROW;
    return parent === NO_ROW ? focusRow(row) : focusRow(parent);
  }
  if (key === "Enter" || key === " ") {
    if (isFolder) return { kind: expanded ? TreeKeyKind.collapse : TreeKeyKind.expand, row };
    // A file row is a link: Enter follows it natively, and Space would only scroll the list.
    return key === "Enter" ? NO_KEY_ACTION : focusRow(row);
  }
  return NO_KEY_ACTION;
}

function focusRow(row: number): TreeKeyAction {
  assert(row >= 0, "focus goes to a row");
  return { kind: TreeKeyKind.focus, row };
}
