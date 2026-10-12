// Files and folders the reviewer hid. The set holds node indices; hiding a
// node hides its whole subtree. Sets are values: every change returns a new
// one, so the view can tell a change by identity and Undo can restore an
// earlier set exactly. Entries are never merged, so hiding a file and then
// its folder keeps both, and showing the folder again leaves the file hidden.

import { assert } from "./assert.ts";
import { NodeKind, type Tree } from "./decode.ts";

/** Links carry at most this many hidden paths, and the view lets no more be hidden, so a link always reproduces the view. */
export const HIDDEN_NODES_MAX = 200;
/** Longer paths in a link are dropped: GitHub paths are far shorter, so only edited links carry them. */
export const HIDDEN_PATH_LENGTH_MAX = 1024;

export const NO_HIDDEN_NODES: ReadonlySet<number> = new Set();

/** Nodes with a path: files, folders and collapsed folders. The root and rest nodes have none, so a link could not name them. */
export function isHideableNode(tree: Tree, node: number): boolean {
  assert(node >= 0 && node < tree.nodeCount, "the node exists");
  if (node === 0) return false;
  return tree.kinds[node] !== NodeKind.rest;
}

export function withNodeHidden(hidden: ReadonlySet<number>, tree: Tree, node: number): ReadonlySet<number> {
  assert(isHideableNode(tree, node), "only nodes with a path can be hidden");
  assert(!hidden.has(node), "a node is hidden once");
  assert(hidden.size < HIDDEN_NODES_MAX, "the hidden set is bounded");
  const next = new Set(hidden);
  next.add(node);
  return next;
}

export function withNodeShown(hidden: ReadonlySet<number>, node: number): ReadonlySet<number> {
  assert(hidden.has(node), "only hidden nodes can be shown again");
  const next = new Set(hidden);
  next.delete(node);
  return next;
}

/** True when `node` or one of its ancestors is hidden. Walks up at most the tree's depth. */
export function isInsideHiddenSubtree(tree: Tree, hidden: ReadonlySet<number>, node: number): boolean {
  assert(node >= 0 && node < tree.nodeCount, "the node exists");
  if (hidden.size === 0) return false;
  let current = node;
  for (let depth = 0; depth < tree.nodeCount; depth++) {
    if (hidden.has(current)) return true;
    if (current === 0) return false;
    current = tree.parents[current] ?? 0;
  }
  assert(false, "ancestors are bounded by the tree depth");
}

/**
 * `node` when nothing on its path is hidden; otherwise the parent of the
 * highest hidden node on it, the deepest folder that is still shown. The
 * root cannot be hidden, so there always is one.
 */
export function nearestShownAncestor(tree: Tree, hidden: ReadonlySet<number>, node: number): number {
  assert(node >= 0 && node < tree.nodeCount, "the node exists");
  assert(!hidden.has(0), "the root cannot be hidden");
  let shown = node;
  let current = node;
  for (let depth = 0; depth < tree.nodeCount; depth++) {
    if (current === 0) {
      assert(!isInsideHiddenSubtree(tree, hidden, shown), "the result is shown");
      return shown;
    }
    if (hidden.has(current)) shown = tree.parents[current] ?? 0;
    current = tree.parents[current] ?? 0;
  }
  assert(false, "ancestors are bounded by the tree depth");
}

/** Full path to node, for every node that can be hidden. Built once per pull request to read links. */
export function buildHideableNodeByPath(tree: Tree, paths: readonly string[]): ReadonlyMap<string, number> {
  assert(paths.length === tree.nodeCount, "one path per node");
  const nodeByPath = new Map<string, number>();
  for (let node = 1; node < tree.nodeCount; node++) {
    if (!isHideableNode(tree, node)) continue;
    const path = paths[node] ?? "";
    assert(path !== "", "hideable nodes have a path");
    assert(!nodeByPath.has(path), "sibling names are unique, so paths are too");
    nodeByPath.set(path, node);
  }
  return nodeByPath;
}
