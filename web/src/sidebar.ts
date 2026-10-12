// The sidebar, top to bottom: the Filter section, the changed files, and the
// legend. The changed files are the ones that pass the filters inside the
// zoomed folder, shown as a folder tree (the default) or as a flat list,
// heaviest churn first. Either view is also the accessible twin of the
// canvas: every tile's numbers are reachable here as links to the diff.

import { assert } from "./assert.ts";
import { churnIntensity } from "./color.ts";
import type { Tree } from "./decode.ts";
import type { MenuOpening } from "./context-menu.ts";
import { setTooltip } from "./control-tooltip.ts";
import { type DiffUrls, diffUrl } from "./diff.ts";
import { append, element, link } from "./dom.ts";
import type { FilterSection } from "./filter-section.ts";
import {
  computeFileTree,
  createFileTree,
  type FileTree,
  FileView,
  isFolderRow,
  nearestRow,
  NO_ROW,
  rowForHoveredNode,
  rowLabel,
  treeKeyAction,
  TreeKeyKind,
} from "./file-tree.ts";
import { formatAdditions, formatCount, formatDeletions, plural } from "./format.ts";
import { createIcon, IconKind } from "./icons.ts";
import { attachLongPress, isLongPressClick, longPressOpenedMenu } from "./long-press.ts";
import type { TreeIndex } from "./model.ts";
import { HIDE_KEY } from "./node-actions.ts";
import { createSegmented, type Segmented, type SegmentedOption, syncSegmented } from "./segmented.ts";
import { statusClassName, statusLabel, statusLetter, statusOf } from "./status.ts";
import { createLegend } from "./ui.ts";
import { createVirtualRows, ensureVirtualRow, resetVirtualRows, type VirtualRows, virtualRow, virtualRowOf } from "./virtual-rows.ts";

/** Every list and tree row is this tall (see .file-row and .tree-row in style.css): rows are placed by index. */
const ROW_HEIGHT_PX = 32;
const NO_NODE = -1;
const HEADING_ID = "changed-files-heading";
const ROW_SELECTOR = ".file-row, .tree-row";
/** A menu opened from the keyboard has no pointer to open at; it opens under the row, this far in from its end. */
const KEYBOARD_MENU_INSET_PX = 16;

const FILE_VIEW_OPTIONS: readonly SegmentedOption<FileView>[] = [
  { value: FileView.tree, label: "Tree", description: "Changed files in their folders, as on the map." },
  { value: FileView.list, label: "List", description: "Changed files in one list, most lines changed first." },
];

export interface SidebarCallbacks {
  readonly onHoverRow: (node: number) => void;
  readonly onLeaveRows: () => void;
  readonly onFileView: (fileView: FileView) => void;
  readonly onFolderExpanded: (chainTop: number, chainEnd: number, expanded: boolean) => void;
  /** Right-click, long press or the context menu key on a row. */
  readonly onRowMenu: (node: number, opening: MenuOpening) => void;
  /** Alt-click on a row, or its hide control. */
  readonly onHideRow: (node: number) => void;
}

export interface Sidebar {
  readonly root: HTMLElement;
  readonly filter: FilterSection;
  readonly heading: HTMLElement;
  readonly count: HTMLElement;
  readonly fileViewChoice: Segmented<FileView>;
  readonly list: HTMLElement;
  readonly treeView: HTMLElement;
  readonly footer: HTMLElement;
  readonly tree: Tree;
  /** The Tree view's row model; its buffers are allocated once per pull request. */
  readonly fileTree: FileTree;
  /** The List view's row model: the files it shows, in order, and each file's place among them. */
  readonly listNodes: number[];
  readonly listRowOfNode: Int32Array;
  /** Only the rows near the visible part of each view are in the DOM. */
  readonly listRows: VirtualRows;
  readonly treeRows: VirtualRows;
  /** What the rows were last rendered from; rows scrolled into view are built from it too. */
  input: ChangedFilesInput | null;
  /** The view the rows were last rendered for. */
  fileView: FileView;
  /** The marked row's index in the current view, rendered or not. */
  highlightedRow: number;
  /** The node whose row is the tree's one Tab stop; it survives re-renders, falling back to its nearest shown ancestor. */
  activeTreeNode: number;
}

export interface ChangedFilesInput {
  readonly fileView: FileView;
  readonly tree: Tree;
  readonly index: TreeIndex;
  readonly weights: Float64Array;
  readonly insideZoom: Uint8Array;
  readonly zoomNode: number;
  readonly zoomPath: string;
  readonly collapsedFolders: ReadonlySet<number>;
  readonly diffUrls: DiffUrls;
}

export function createSidebar(filter: FilterSection, tree: Tree, index: TreeIndex, callbacks: SidebarCallbacks): Sidebar {
  const root = element("aside", "sidebar");
  root.setAttribute("aria-label", "Filters and changed files");
  const files = element("section", "files-section");
  const header = element("div", "files-header");
  const heading = element("h2", "section-heading files-heading", "Changed files");
  heading.id = HEADING_ID;
  const count = element("span", "files-count mono");
  const fileViewChoice = createSegmented("segmented-small", FILE_VIEW_OPTIONS, callbacks.onFileView);
  fileViewChoice.root.setAttribute("aria-label", "Show changed files as");
  append(header, heading, count, fileViewChoice.root);
  const list = element("ol", "file-list");
  const treeView = element("div", "file-tree");
  treeView.setAttribute("role", "tree");
  treeView.setAttribute("aria-labelledby", HEADING_ID);
  const footer = element("p", "file-list-footer");
  footer.hidden = true;
  append(files, header, list, treeView, footer);
  append(root, filter.root, files, createLegend());

  // Rows are built on demand from the sidebar, which holds the rows: they only scroll into view after it is assigned.
  let created: Sidebar | null = null;
  const getSidebar = (): Sidebar => {
    assert(created !== null, "rows are built only after the sidebar is");
    return created;
  };
  const sidebar: Sidebar = {
    root,
    filter,
    heading,
    count,
    fileViewChoice,
    list,
    treeView,
    footer,
    tree,
    fileTree: createFileTree(tree, index),
    listNodes: [],
    listRowOfNode: new Int32Array(tree.nodeCount).fill(NO_ROW),
    listRows: createVirtualRows(list, ROW_HEIGHT_PX, (row) => createListRow(getSidebar(), row)),
    treeRows: createVirtualRows(treeView, ROW_HEIGHT_PX, (row) => createTreeRow(getSidebar(), row)),
    input: null,
    fileView: FileView.tree,
    highlightedRow: NO_ROW,
    activeTreeNode: NO_NODE,
  };
  created = sidebar;
  for (const container of [list, treeView]) {
    attachHoverEvents(container, callbacks);
    attachRowActionEvents(container, callbacks);
  }
  attachTreeEvents(sidebar, callbacks);
  return sidebar;
}

/**
 * The node a list or tree row names, for the row containing `target`: a
 * file, or the last folder of a tree row's chain, whose frame the map
 * outlines. NO_NODE outside rows.
 */
export function rowNodeOf(target: EventTarget | null): number {
  if (!(target instanceof Element)) return NO_NODE;
  const row = target.closest<HTMLElement>(ROW_SELECTOR);
  if (row === null) return NO_NODE;
  const node = Number(row.dataset["node"] ?? NO_NODE);
  assert(Number.isInteger(node) && node > 0, "rows name a file or folder below the root");
  return node;
}

/** Delegated listeners: one set per container instead of one per row. */
function attachHoverEvents(container: HTMLElement, callbacks: SidebarCallbacks): void {
  container.addEventListener("mouseover", (event) => {
    const node = rowNodeOf(event.target);
    if (node === NO_NODE) return;
    drawHideIcon(event.target);
    callbacks.onHoverRow(node);
  });
  container.addEventListener("mouseleave", callbacks.onLeaveRows);
  container.addEventListener("focusin", (event) => {
    const node = rowNodeOf(event.target);
    if (node === NO_NODE) return;
    drawHideIcon(event.target);
    callbacks.onHoverRow(node);
  });
  container.addEventListener("focusout", callbacks.onLeaveRows);
}

/**
 * The secondary actions on a row: right-click, a long press or the context
 * menu key open the menu, and Alt-click or the hide control hide it. Clicks
 * are caught on the way down, so none of these reaches the row: it would
 * follow the link (some browsers download a link on Alt-click) or open the
 * folder.
 */
function attachRowActionEvents(container: HTMLElement, callbacks: SidebarCallbacks): void {
  const press = attachLongPress(container, (point) => {
    const node = rowNodeOf(point.target);
    if (node !== NO_NODE) callbacks.onRowMenu(node, { clientX: point.clientX, clientY: point.clientY, byTouch: true });
  });
  container.addEventListener("contextmenu", (event) => {
    const node = rowNodeOf(event.target);
    if (node === NO_NODE) return;
    event.preventDefault();
    if (longPressOpenedMenu(press)) return;
    const anchor = menuAnchor(event);
    callbacks.onRowMenu(node, { clientX: anchor.x, clientY: anchor.y, byTouch: false });
  });
  container.addEventListener(
    "click",
    (event) => {
      const node = rowNodeOf(event.target);
      if (node === NO_NODE) return;
      const endsLongPress = isLongPressClick(press);
      const onHideControl = event.target instanceof Element && event.target.closest(".row-hide") !== null;
      if (!endsLongPress && !event.altKey && !onHideControl) return;
      event.preventDefault();
      event.stopPropagation();
      if (!endsLongPress) callbacks.onHideRow(node);
    },
    { capture: true },
  );
}

/**
 * The pointer, or for the context menu key (no pointer, or one elsewhere)
 * a point under the end of the focused row, so the menu flips back over
 * the row rather than out over the map.
 */
function menuAnchor(event: MouseEvent): { x: number; y: number } {
  assert(event.target instanceof Element, "context menus open on rows");
  const row = event.target.closest(ROW_SELECTOR);
  assert(row !== null, "context menus open on rows");
  const rect = row.getBoundingClientRect();
  const insideX = event.clientX >= rect.left && event.clientX <= rect.right;
  const insideY = event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (insideX && insideY) return { x: event.clientX, y: event.clientY };
  return { x: rect.right - KEYBOARD_MENU_INSET_PX, y: rect.bottom };
}

function attachTreeEvents(sidebar: Sidebar, callbacks: SidebarCallbacks): void {
  sidebar.treeView.addEventListener("click", (event) => {
    const row = treeRowOf(event.target);
    if (row === NO_ROW) return;
    if (!isFolderRow(sidebar.tree, sidebar.fileTree, row)) return;
    toggleFolder(sidebar, callbacks, row);
  });
  // A click focuses the row too, so the Tab stop follows the mouse as well as the keys.
  sidebar.treeView.addEventListener("focusin", (event) => {
    const row = treeRowOf(event.target);
    if (row !== NO_ROW) moveTabStop(sidebar, row);
  });
  sidebar.treeView.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const row = treeRowOf(event.target);
    if (row === NO_ROW) return;
    const action = treeKeyAction(sidebar.tree, sidebar.fileTree, row, event.key);
    if (action.kind === TreeKeyKind.none) return;
    event.preventDefault();
    if (action.kind === TreeKeyKind.focus) {
      // The row may be out of view, and so not rendered yet; focusing it scrolls it in.
      ensureVirtualRow(sidebar.treeRows, action.row).focus({ preventScroll: false });
    } else {
      setFolderExpanded(sidebar, callbacks, action.row, action.kind === TreeKeyKind.expand);
    }
  });
}

/** Roving tabindex: exactly one row is in the Tab order, pinned so it stays rendered wherever the tree is scrolled. */
function moveTabStop(sidebar: Sidebar, row: number): void {
  const { fileTree, treeRows } = sidebar;
  assert(row >= 0 && row < fileTree.rowCount, "the Tab stop is a row");
  if (treeRows.pinned !== row) {
    const previousRow = virtualRow(treeRows, treeRows.pinned);
    if (previousRow !== null) previousRow.tabIndex = -1;
  }
  sidebar.activeTreeNode = fileTree.rowNodes[row] ?? 0;
  treeRows.pinned = row;
  ensureVirtualRow(treeRows, row).tabIndex = 0;
}

/** The row index of the tree row containing `target`, or NO_ROW. */
function treeRowOf(target: EventTarget | null): number {
  if (!(target instanceof Element)) return NO_ROW;
  const row = target.closest<HTMLElement>(".tree-row");
  return row === null ? NO_ROW : Number(row.dataset["row"] ?? NO_ROW);
}

function toggleFolder(sidebar: Sidebar, callbacks: SidebarCallbacks, row: number): void {
  setFolderExpanded(sidebar, callbacks, row, sidebar.fileTree.rowExpanded[row] !== 1);
}

function setFolderExpanded(sidebar: Sidebar, callbacks: SidebarCallbacks, row: number, expanded: boolean): void {
  const { fileTree } = sidebar;
  assert(row < fileTree.rowCount, "rendered rows come from the current model");
  assert(isFolderRow(sidebar.tree, fileTree, row), "only folders open and close");
  callbacks.onFolderExpanded(fileTree.rowChainTops[row] ?? 0, fileTree.rowNodes[row] ?? 0, expanded);
}

export function syncFileViewChoice(sidebar: Sidebar, fileView: FileView): void {
  syncSegmented(sidebar.fileViewChoice, fileView);
}

/** Rebuilds the rows of the chosen view; the other view's container is emptied and hidden. */
export function renderChangedFiles(sidebar: Sidebar, input: ChangedFilesInput): void {
  const focusedListRow = virtualRowOf(sidebar.listRows, document.activeElement);
  sidebar.input = input;
  sidebar.fileView = input.fileView;
  sidebar.highlightedRow = NO_ROW;
  sidebar.list.hidden = input.fileView !== FileView.list;
  sidebar.treeView.hidden = input.fileView !== FileView.tree;
  // The heading shares its line with the count and the view toggle, so it names only the zoomed folder; the breadcrumbs and the title have the path.
  const zoomName = input.zoomPath.slice(input.zoomPath.lastIndexOf("/") + 1);
  sidebar.heading.textContent = input.zoomPath === "" ? "Changed files" : `Changed in ${zoomName}/`;
  if (input.zoomPath === "") {
    delete sidebar.heading.dataset["tooltip"];
  } else {
    setTooltip(sidebar.heading, `Changed in ${input.zoomPath}/`);
  }
  const total = input.index.changedFiles.length;
  let matching = 0;
  if (input.fileView === FileView.list) {
    resetVirtualRows(sidebar.treeRows, 0);
    matching = renderFileList(sidebar, input);
    if (focusedListRow !== NO_ROW && matching > 0) focusListRow(sidebar, focusedListRow);
  } else {
    resetVirtualRows(sidebar.listRows, 0);
    matching = renderFileTree(sidebar, input);
  }
  const footer = matching === 0 ? "No changed files match these filters." : "";
  sidebar.count.textContent = matching === total ? formatCount(total) : `${formatCount(matching)} of ${formatCount(total)}`;
  sidebar.footer.hidden = footer === "";
  sidebar.footer.textContent = footer;
}

/** Returns how many changed files pass the filters inside the zoom. */
function renderFileList(sidebar: Sidebar, input: ChangedFilesInput): number {
  const { listNodes, listRowOfNode } = sidebar;
  const { tree } = input;
  for (const node of listNodes) listRowOfNode[node] = NO_ROW;
  listNodes.length = 0;
  let additionsMax = 0;
  let deletionsMax = 0;
  for (const node of input.index.changedFiles) {
    if ((input.weights[node] ?? 0) <= 0) continue;
    if (input.insideZoom[node] !== 1) continue;
    listRowOfNode[node] = listNodes.length;
    listNodes.push(node);
    additionsMax = Math.max(additionsMax, tree.additions[node] ?? 0);
    deletionsMax = Math.max(deletionsMax, tree.deletions[node] ?? 0);
  }
  setNumberColumnWidths(sidebar.list, additionsMax, deletionsMax);
  resetVirtualRows(sidebar.listRows, listNodes.length);
  return listNodes.length;
}

/**
 * Rows are independent grids, and only some are rendered, so the number
 * columns line up through widths set per render rather than by the rows in
 * the DOM: monospace digits, signs and separators are one ch each, so the
 * largest number sets each column.
 */
function setNumberColumnWidths(container: HTMLElement, additionsMax: number, deletionsMax: number): void {
  container.style.setProperty("--additions-width", `${formatAdditions(additionsMax).length}ch`);
  container.style.setProperty("--deletions-width", `${formatDeletions(deletionsMax).length}ch`);
}

/** The row now at `position` takes focus, the last one past the end: a hidden or filtered-out row gives way to the next. */
function focusListRow(sidebar: Sidebar, position: number): void {
  const item = ensureVirtualRow(sidebar.listRows, Math.min(position, sidebar.listNodes.length - 1));
  listRowLink(item).focus({ preventScroll: false });
}

/** A list item holds its row's link, which takes focus and the highlight. */
function listRowLink(item: HTMLElement): HTMLElement {
  const row = item.firstElementChild;
  assert(row instanceof HTMLElement, "list items hold their row");
  return row;
}

function renderedInput(sidebar: Sidebar): ChangedFilesInput {
  assert(sidebar.input !== null, "rows are built after a render");
  return sidebar.input;
}

function createListRow(sidebar: Sidebar, index: number): HTMLElement {
  const item = element("li", "");
  // Only rows near the visible part are rendered, so each says where it sits in the whole list.
  item.setAttribute("aria-setsize", String(sidebar.listNodes.length));
  item.setAttribute("aria-posinset", String(index + 1));
  const row = createFileRow(sidebar.listNodes[index] ?? 0, renderedInput(sidebar));
  if (index === sidebar.highlightedRow) row.classList.add("is-highlighted");
  return append(item, row);
}

function createFileRow(node: number, input: ChangedFilesInput): HTMLAnchorElement {
  const { tree, index } = input;
  const path = index.paths[node] ?? "";
  const row = link("file-row", diffUrl(input.diffUrls, node), "", true);
  row.dataset["node"] = String(node);
  const status = statusOf(tree.statuses[node] ?? 0);

  // Inside a zoomed folder, the folder's own path is in the heading; rows show what is below it.
  const zoomPrefix = input.zoomPath === "" ? "" : `${input.zoomPath}/`;
  const shownPath = path.startsWith(zoomPrefix) ? path.slice(zoomPrefix.length) : path;
  const slash = shownPath.lastIndexOf("/");
  const pathElement = element("span", "file-path");
  if (slash >= 0) pathElement.append(element("span", "file-directory", shownPath.slice(0, slash + 1)));
  pathElement.append(element("span", "file-name", shownPath.slice(slash + 1)));
  setTooltip(pathElement, path);

  const additions = tree.additions[node] ?? 0;
  const deletions = tree.deletions[node] ?? 0;
  row.setAttribute("aria-label", `${statusLabel(status)} ${path}, ${additions} added, ${deletions} deleted. Opens the diff on GitHub.`);
  const counts = createLineCounts(additions, deletions);
  append(row, createStatusLetter(tree, node), pathElement, createHideControl(tree.names[node] ?? "", false), ...counts, createChurnBar(additions, deletions, index.churnMax));
  return row;
}

function createStatusLetter(tree: Tree, node: number): HTMLElement {
  const status = statusOf(tree.statuses[node] ?? 0);
  const letter = element("span", `file-status ${statusClassName(status)}`, statusLetter(status));
  setTooltip(letter, statusLabel(status));
  return letter;
}

function createLineCounts(additions: number, deletions: number): [HTMLElement, HTMLElement] {
  return [
    element("span", additions === 0 ? "file-additions is-zero" : "file-additions", formatAdditions(additions)),
    element("span", deletions === 0 ? "file-deletions is-zero" : "file-deletions", formatDeletions(deletions)),
  ];
}

/** Length encodes churn on the same log scale as tile intensity; the split encodes added vs deleted. */
function createChurnBar(additions: number, deletions: number, churnMax: number): HTMLElement {
  const bar = element("span", "churn-bar");
  bar.setAttribute("aria-hidden", "true");
  const churn = additions + deletions;
  const filled = element("span", "churn-bar-filled");
  filled.style.width = `${Math.max(4, Math.round(churnIntensity(churn, churnMax) * 100))}%`;
  const added = element("span", "churn-bar-additions");
  added.style.flexGrow = String(additions);
  const deleted = element("span", "churn-bar-deletions");
  deleted.style.flexGrow = String(deletions);
  if (churn > 0) append(filled, added, deleted);
  return append(bar, filled);
}

/**
 * Returns how many changed files pass the filters inside the zoom. Rows are
 * rebuilt, so keyboard focus moves to the new row for the same node: closing
 * a folder with the keys keeps you on it.
 */
function renderFileTree(sidebar: Sidebar, input: ChangedFilesInput): number {
  const { fileTree } = sidebar;
  const hadFocus = sidebar.treeView.contains(document.activeElement);
  computeFileTree(input.tree, input.index, input.weights, input.zoomNode, input.collapsedFolders, fileTree);
  let additionsMax = 0;
  let deletionsMax = 0;
  for (let row = 0; row < fileTree.rowCount; row++) {
    const node = fileTree.rowNodes[row] ?? 0;
    additionsMax = Math.max(additionsMax, fileTree.visibleAdditions[node] ?? 0);
    deletionsMax = Math.max(deletionsMax, fileTree.visibleDeletions[node] ?? 0);
  }
  setNumberColumnWidths(sidebar.treeView, additionsMax, deletionsMax);
  resetVirtualRows(sidebar.treeRows, fileTree.rowCount);
  if (fileTree.rowCount > 0) restoreTabStop(sidebar, hadFocus);
  return fileTree.visibleFiles[input.zoomNode] ?? 0;
}

/** The rows are new and none is pinned yet, so there is no previous stop to demote. */
function restoreTabStop(sidebar: Sidebar, hadFocus: boolean): void {
  const found = sidebar.activeTreeNode === NO_NODE ? NO_ROW : nearestRow(sidebar.tree, sidebar.fileTree, sidebar.activeTreeNode);
  const row = found === NO_ROW ? 0 : found;
  moveTabStop(sidebar, row);
  if (hadFocus) ensureVirtualRow(sidebar.treeRows, row).focus({ preventScroll: false });
}

function createTreeRow(sidebar: Sidebar, index: number): HTMLElement {
  const input = renderedInput(sidebar);
  const { fileTree } = sidebar;
  const row = isFolderRow(input.tree, fileTree, index) ? createFolderRow(input, fileTree, index) : createTreeFileRow(input, fileTree, index);
  if (index === sidebar.treeRows.pinned) row.tabIndex = 0;
  if (index === sidebar.highlightedRow) row.classList.add("is-highlighted");
  return row;
}

/** Tree semantics in a flat list of rows: level, set size and position say what nesting would. */
function setTreeItem(row: HTMLElement, fileTree: FileTree, index: number): void {
  const level = fileTree.rowLevels[index] ?? 1;
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(level));
  row.setAttribute("aria-setsize", String(fileTree.rowSetSizes[index] ?? 1));
  row.setAttribute("aria-posinset", String(fileTree.rowPositions[index] ?? 1));
  row.dataset["row"] = String(index);
  row.dataset["node"] = String(fileTree.rowNodes[index] ?? 0);
  row.tabIndex = -1;
  // CSSOM, not a style attribute: the CSP forbids inline styles but allows this.
  row.style.setProperty("--tree-depth", String(level - 1));
}

function createFolderRow(input: ChangedFilesInput, fileTree: FileTree, index: number): HTMLElement {
  const node = fileTree.rowNodes[index] ?? 0;
  const expanded = fileTree.rowExpanded[index] === 1;
  const row = element("div", "tree-row tree-folder");
  setTreeItem(row, fileTree, index);
  row.setAttribute("aria-expanded", expanded ? "true" : "false");
  const label = rowLabel(input.tree, fileTree, index);
  const chevron = element("span", "tree-chevron");
  chevron.setAttribute("aria-hidden", "true");
  const name = createChainName(label);
  setTooltip(name, `${input.index.paths[node] ?? ""}/`);
  const additions = fileTree.visibleAdditions[node] ?? 0;
  const deletions = fileTree.visibleDeletions[node] ?? 0;
  const files = plural(fileTree.visibleFiles[node] ?? 0, "changed file", "changed files");
  const count = element("span", "tree-count", formatCount(fileTree.visibleFiles[node] ?? 0));
  setTooltip(count, files);
  row.setAttribute("aria-label", `${label}, ${files}, ${additions} added, ${deletions} deleted`);
  append(row, append(element("span", "tree-label"), chevron, name, count), createHideControl(label, true), ...createLineCounts(additions, deletions));
  return row;
}

/** As in the list, the leading folders give way first, so the folder whose files follow stays readable. */
function createChainName(label: string): HTMLElement {
  const name = element("span", "tree-name file-path");
  const slash = label.lastIndexOf("/");
  if (slash >= 0) name.append(element("span", "file-directory", label.slice(0, slash + 1)));
  name.append(element("span", "file-name", label.slice(slash + 1)));
  return name;
}

function createTreeFileRow(input: ChangedFilesInput, fileTree: FileTree, index: number): HTMLAnchorElement {
  const { tree } = input;
  const node = fileTree.rowNodes[index] ?? 0;
  const row = link("tree-row tree-file", diffUrl(input.diffUrls, node), "", true);
  setTreeItem(row, fileTree, index);
  const name = element("span", "tree-name", tree.names[node] ?? "");
  setTooltip(name, input.index.paths[node] ?? "");
  const additions = tree.additions[node] ?? 0;
  const deletions = tree.deletions[node] ?? 0;
  const status = statusLabel(statusOf(tree.statuses[node] ?? 0));
  row.setAttribute("aria-label", `${status} ${tree.names[node] ?? ""}, ${additions} added, ${deletions} deleted. Opens the diff on GitHub.`);
  const label = append(element("span", "tree-label"), createStatusLetter(tree, node), name);
  const counts = createLineCounts(additions, deletions);
  append(row, label, createHideControl(tree.names[node] ?? "", false), ...counts, createChurnBar(additions, deletions, input.index.churnMax));
  return row;
}

/**
 * Shown over the end of the name on hover and keyboard focus. It is not a
 * Tab stop, so the tree keeps its one (as the WAI-ARIA tree pattern asks of
 * secondary actions): from the keyboard, H and the context menu key do the
 * same. It is no <button> either, since links cannot contain one; clicks
 * reach it through attachRowActionEvents.
 */
function createHideControl(name: string, isFolder: boolean): HTMLElement {
  const control = element("span", "row-hide");
  control.setAttribute("role", "button");
  control.setAttribute("aria-label", `Hide ${name}`);
  control.setAttribute("aria-keyshortcuts", HIDE_KEY);
  const what = isFolder ? "Hide this folder, with everything in it," : "Hide this file";
  setTooltip(control, `${what} from the map and the file list.`, `Shortcut: ${HIDE_KEY}`);
  return control;
}

/**
 * Gives the row's hide control its icon the first time the row is hovered
 * or focused, the only times it shows. Cloning one per row at render made
 * a 2,000-row re-render about 40% slower.
 */
function drawHideIcon(target: EventTarget | null): void {
  assert(target instanceof Element, "only rows report hovers");
  const control = target.closest(ROW_SELECTOR)?.querySelector(".row-hide");
  if (control === null || control === undefined || control.firstChild !== null) return;
  control.append(createIcon(IconKind.hide));
}

/**
 * Marks the row for `node` (or none). In the tree, a node inside a closed
 * folder marks that folder's row; nothing opens on hover. `reveal` scrolls
 * the list to the row, for hovers that start on the map. The tree never
 * scrolls: it is in path order, so following the pointer across the map
 * would jump it back and forth.
 */
export function highlightRow(sidebar: Sidebar, node: number, reveal: boolean): void {
  const isList = sidebar.fileView === FileView.list;
  const row = isList ? listRowForNode(sidebar, node) : rowForHoveredNode(sidebar.tree, sidebar.fileTree, node);
  if (row === sidebar.highlightedRow) return;
  const rows = isList ? sidebar.listRows : sidebar.treeRows;
  const marked = (rendered: HTMLElement) => (isList ? listRowLink(rendered) : rendered);
  const previous = virtualRow(rows, sidebar.highlightedRow);
  if (previous !== null) marked(previous).classList.remove("is-highlighted");
  sidebar.highlightedRow = row;
  if (row === NO_ROW) return;
  // Rows out of view are not rendered: they pick the mark up when they are built.
  const shown = reveal && isList ? ensureVirtualRow(rows, row) : virtualRow(rows, row);
  if (shown === null) return;
  marked(shown).classList.add("is-highlighted");
  if (reveal && isList) shown.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
}

/** NO_ROW for files the list does not show. */
function listRowForNode(sidebar: Sidebar, node: number): number {
  if (node < 0) return NO_ROW;
  return sidebar.listRowOfNode[node] ?? NO_ROW;
}
