// What can be done to one file or folder from the map or the file views,
// and how such a node is named in menus and messages. Pure, so the menu's
// contents are tested without a DOM; the view runs the actions.

import { assert } from "./assert.ts";
import { NodeKind, type Tree } from "./decode.ts";
import { isHideableNode } from "./hidden.ts";
import { isChangedFile } from "./model.ts";

export const NodeAction = { openDiff: "openDiff", zoom: "zoom", hide: "hide", copyPath: "copyPath" } as const;
export type NodeAction = (typeof NodeAction)[keyof typeof NodeAction];

/** The key that hides the hovered or focused node; shown next to every hide item. */
export const HIDE_KEY = "H";

export interface NodeMenuItem {
  readonly action: NodeAction;
  readonly label: string;
  /** A key that does the same outside the menu; "" for none. */
  readonly shortcut: string;
}

const OPEN_DIFF: NodeMenuItem = { action: NodeAction.openDiff, label: "Open diff on GitHub", shortcut: "" };
const ZOOM: NodeMenuItem = { action: NodeAction.zoom, label: "Zoom into folder", shortcut: "" };
const HIDE_FILE: NodeMenuItem = { action: NodeAction.hide, label: "Hide file", shortcut: HIDE_KEY };
const HIDE_FOLDER: NodeMenuItem = { action: NodeAction.hide, label: "Hide folder", shortcut: HIDE_KEY };
const HIDE: NodeMenuItem = { action: NodeAction.hide, label: "Hide", shortcut: HIDE_KEY };
const COPY_PATH: NodeMenuItem = { action: NodeAction.copyPath, label: "Copy path", shortcut: "" };

/**
 * The menu for `node`: a changed file opens its diff (when there is one to
 * open: a local branch has none on GitHub), a folder zooms in, and unchanged
 * context (a file or a collapsed folder) can only be hidden. The root and
 * rest nodes have no path, so they get no menu.
 */
export function nodeMenuItems(tree: Tree, node: number, hasDiffs: boolean = true): readonly NodeMenuItem[] {
  if (!isHideableNode(tree, node)) return [];
  if (isChangedFile(tree, node)) return hasDiffs ? [OPEN_DIFF, HIDE_FILE, COPY_PATH] : [HIDE_FILE, COPY_PATH];
  if (tree.kinds[node] === NodeKind.directory) return [ZOOM, HIDE_FOLDER, COPY_PATH];
  assert(tree.kinds[node] === NodeKind.file || tree.kinds[node] === NodeKind.collapsedDirectory, "what is left is context");
  return [HIDE, COPY_PATH];
}

/** The path as the app shows it everywhere: folders end in "/". */
export function displayPath(tree: Tree, paths: readonly string[], node: number): string {
  assert(isHideableNode(tree, node), "only nodes with a path are named");
  const path = paths[node] ?? "";
  assert(path !== "", "hideable nodes have a path");
  const kind = tree.kinds[node];
  return kind === NodeKind.directory || kind === NodeKind.collapsedDirectory ? `${path}/` : path;
}
