// The sidebar, top to bottom: the Filter section, the changed files, and the
// legend. The changed files are the ones that pass the filters inside the
// zoomed folder, shown as a folder tree (the default) or as a flat list,
// heaviest churn first. Either view is also the accessible twin of the
// canvas: every tile's numbers are reachable here as links to the diff.

import { assert } from "./assert.ts";
import { churnIntensity } from "./color.ts";
import type { Tree } from "./decode.ts";
import { append, element, link } from "./dom.ts";
import type { FilterSection } from "./filter-section.ts";
import {
  computeFileTree,
  createFileTree,
  type FileTree,
  FileView,
  isFolderRow,
  NO_ROW,
  rowLabel,
} from "./file-tree.ts";
import { formatAdditions, formatCount, formatDeletions, plural } from "./format.ts";
import type { TreeIndex } from "./model.ts";
import { createSegmented, type Segmented, type SegmentedOption, syncSegmented } from "./segmented.ts";
import { statusClassName, statusLabel, statusLetter, statusOf } from "./status.ts";
import { createLegend } from "./ui.ts";

/** Rendering is bounded; past this, filters are the better tool than scrolling. */
const LIST_ROWS_MAX = 400;
/** Higher than the list's: folders add rows, and closing them is a second way to get under it. */
const TREE_ROWS_MAX = 2000;
const NO_NODE = -1;
const HEADING_ID = "changed-files-heading";

const FILE_VIEW_OPTIONS: readonly SegmentedOption<FileView>[] = [
  { value: FileView.tree, label: "Tree", description: "Changed files in their folders" },
  { value: FileView.list, label: "List", description: "Changed files by lines changed, most first" },
];

export interface SidebarCallbacks {
  readonly onHoverRow: (node: number) => void;
  readonly onLeaveRows: () => void;
  readonly onFileView: (fileView: FileView) => void;
  readonly onFolderExpanded: (chainTop: number, chainEnd: number, expanded: boolean) => void;
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
  /** List rows by file node. */
  readonly rowByNode: Map<number, HTMLElement>;
  /** Tree rows by row index, as far as they are rendered. */
  readonly treeRows: HTMLElement[];
  /** The view the rows were last rendered for. */
  fileView: FileView;
  highlightedNode: number;
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
  readonly diffUrls: readonly string[];
  readonly fallbackUrl: string;
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
    rowByNode: new Map(),
    treeRows: [],
    fileView: FileView.tree,
    highlightedNode: NO_NODE,
  };
  attachListEvents(list, callbacks);
  attachTreeEvents(sidebar, callbacks);
  return sidebar;
}

/** Delegated listeners: one set for the whole list instead of one per row. */
function attachListEvents(list: HTMLElement, callbacks: SidebarCallbacks): void {
  const rowNode = (target: EventTarget | null): number => {
    if (!(target instanceof Element)) return NO_NODE;
    const row = target.closest<HTMLElement>(".file-row");
    return row === null ? NO_NODE : Number(row.dataset["node"] ?? NO_NODE);
  };
  list.addEventListener("mouseover", (event) => {
    const node = rowNode(event.target);
    if (node !== NO_NODE) callbacks.onHoverRow(node);
  });
  list.addEventListener("mouseleave", callbacks.onLeaveRows);
  list.addEventListener("focusin", (event) => {
    const node = rowNode(event.target);
    if (node !== NO_NODE) callbacks.onHoverRow(node);
  });
  list.addEventListener("focusout", callbacks.onLeaveRows);
}

function attachTreeEvents(sidebar: Sidebar, callbacks: SidebarCallbacks): void {
  sidebar.treeView.addEventListener("click", (event) => {
    const row = treeRowOf(event.target);
    if (row === NO_ROW) return;
    if (!isFolderRow(sidebar.tree, sidebar.fileTree, row)) return;
    toggleFolder(sidebar, callbacks, row);
  });
}

/** The row index of the tree row containing `target`, or NO_ROW. */
function treeRowOf(target: EventTarget | null): number {
  if (!(target instanceof Element)) return NO_ROW;
  const row = target.closest<HTMLElement>(".tree-row");
  return row === null ? NO_ROW : Number(row.dataset["row"] ?? NO_ROW);
}

function toggleFolder(sidebar: Sidebar, callbacks: SidebarCallbacks, row: number): void {
  const { fileTree } = sidebar;
  assert(row < fileTree.rowCount, "rendered rows come from the current model");
  const top = fileTree.rowChainTops[row] ?? 0;
  const end = fileTree.rowNodes[row] ?? 0;
  callbacks.onFolderExpanded(top, end, fileTree.rowExpanded[row] !== 1);
}

export function syncFileViewChoice(sidebar: Sidebar, fileView: FileView): void {
  syncSegmented(sidebar.fileViewChoice, fileView);
}

/** Rebuilds the rows of the chosen view; the other view's container is emptied and hidden. */
export function renderChangedFiles(sidebar: Sidebar, input: ChangedFilesInput): void {
  sidebar.fileView = input.fileView;
  sidebar.highlightedNode = NO_NODE;
  sidebar.rowByNode.clear();
  sidebar.treeRows.length = 0;
  sidebar.list.hidden = input.fileView !== FileView.list;
  sidebar.treeView.hidden = input.fileView !== FileView.tree;
  sidebar.heading.textContent = input.zoomPath === "" ? "Changed files" : `Changed in ${input.zoomPath}/`;
  const total = input.index.changedFiles.length;
  let matching = 0;
  let footer = "";
  if (input.fileView === FileView.list) {
    sidebar.treeView.replaceChildren();
    matching = renderFileList(sidebar, input);
    if (matching > LIST_ROWS_MAX) {
      footer = `${formatCount(matching - LIST_ROWS_MAX)} more files. Narrow them down with the filters or a path pattern.`;
    }
  } else {
    sidebar.list.replaceChildren();
    matching = renderFileTree(sidebar, input);
    const hiddenRows = sidebar.fileTree.rowCount - sidebar.treeRows.length;
    if (hiddenRows > 0) footer = `${plural(hiddenRows, "more row", "more rows")}. Close folders, or narrow them down with the filters.`;
  }
  if (matching === 0) footer = "No changed files match these filters.";
  sidebar.count.textContent = matching === total ? formatCount(total) : `${formatCount(matching)} of ${formatCount(total)}`;
  sidebar.footer.hidden = footer === "";
  sidebar.footer.textContent = footer;
}

/** Returns how many changed files pass the filters inside the zoom. */
function renderFileList(sidebar: Sidebar, input: ChangedFilesInput): number {
  const rows: HTMLElement[] = [];
  let matching = 0;
  for (const node of input.index.changedFiles) {
    if ((input.weights[node] ?? 0) <= 0) continue;
    if (input.insideZoom[node] !== 1) continue;
    matching++;
    if (rows.length >= LIST_ROWS_MAX) continue;
    const row = createListRow(node, input);
    sidebar.rowByNode.set(node, row);
    rows.push(append(element("li", ""), row));
  }
  assert(rows.length <= LIST_ROWS_MAX, "the list is bounded");
  sidebar.list.replaceChildren(...rows);
  return matching;
}

function createListRow(node: number, input: ChangedFilesInput): HTMLAnchorElement {
  const { tree, index } = input;
  const path = index.paths[node] ?? "";
  const row = link("file-row", diffUrlOf(input, node), "", true);
  row.dataset["node"] = String(node);
  const status = statusOf(tree.statuses[node] ?? 0);

  // Inside a zoomed folder, the folder's own path is in the heading; rows show what is below it.
  const zoomPrefix = input.zoomPath === "" ? "" : `${input.zoomPath}/`;
  const shownPath = path.startsWith(zoomPrefix) ? path.slice(zoomPrefix.length) : path;
  const slash = shownPath.lastIndexOf("/");
  const pathElement = element("span", "file-path");
  if (slash >= 0) pathElement.append(element("span", "file-directory", shownPath.slice(0, slash + 1)));
  pathElement.append(element("span", "file-name", shownPath.slice(slash + 1)));
  pathElement.title = path;

  const additions = tree.additions[node] ?? 0;
  const deletions = tree.deletions[node] ?? 0;
  row.setAttribute("aria-label", `${statusLabel(status)} ${path}, ${additions} added, ${deletions} deleted. Opens the diff on GitHub.`);
  append(row, createStatusLetter(tree, node), pathElement, ...createLineCounts(additions, deletions), createChurnBar(additions, deletions, index.churnMax));
  return row;
}

/** Until the anchors are hashed (or if hashing failed), the files tab is the closest page. */
function diffUrlOf(input: ChangedFilesInput, node: number): string {
  const url = input.diffUrls[node] ?? "";
  return url === "" ? input.fallbackUrl : url;
}

function createStatusLetter(tree: Tree, node: number): HTMLElement {
  const status = statusOf(tree.statuses[node] ?? 0);
  const letter = element("span", `file-status ${statusClassName(status)}`, statusLetter(status));
  letter.title = statusLabel(status);
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

/** Returns how many changed files pass the filters inside the zoom. */
function renderFileTree(sidebar: Sidebar, input: ChangedFilesInput): number {
  const { fileTree } = sidebar;
  computeFileTree(input.tree, input.index, input.weights, input.zoomNode, input.collapsedFolders, fileTree);
  const rendered = Math.min(fileTree.rowCount, TREE_ROWS_MAX);
  let additionsWidth = 0;
  let deletionsWidth = 0;
  for (let row = 0; row < rendered; row++) {
    const node = fileTree.rowNodes[row] ?? 0;
    additionsWidth = Math.max(additionsWidth, formatAdditions(fileTree.visibleAdditions[node] ?? 0).length);
    deletionsWidth = Math.max(deletionsWidth, formatDeletions(fileTree.visibleDeletions[node] ?? 0).length);
    const isFolder = isFolderRow(input.tree, fileTree, row);
    sidebar.treeRows.push(isFolder ? createFolderRow(input, fileTree, row) : createTreeFileRow(input, fileTree, row));
  }
  assert(sidebar.treeRows.length <= TREE_ROWS_MAX, "the tree is bounded");
  // Monospace digits, signs and separators are one ch each, so the widest text sets each column.
  sidebar.treeView.style.setProperty("--tree-additions-width", `${additionsWidth}ch`);
  sidebar.treeView.style.setProperty("--tree-deletions-width", `${deletionsWidth}ch`);
  sidebar.treeView.replaceChildren(...sidebar.treeRows);
  return fileTree.visibleFiles[input.zoomNode] ?? 0;
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
  name.title = `${input.index.paths[node] ?? ""}/`;
  const additions = fileTree.visibleAdditions[node] ?? 0;
  const deletions = fileTree.visibleDeletions[node] ?? 0;
  const files = plural(fileTree.visibleFiles[node] ?? 0, "changed file", "changed files");
  const count = element("span", "tree-count", formatCount(fileTree.visibleFiles[node] ?? 0));
  count.title = files;
  row.setAttribute("aria-label", `${label}, ${files}, ${additions} added, ${deletions} deleted`);
  append(row, append(element("span", "tree-label"), chevron, name, count), ...createLineCounts(additions, deletions));
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
  const row = link("tree-row tree-file", diffUrlOf(input, node), "", true);
  setTreeItem(row, fileTree, index);
  const name = element("span", "tree-name", tree.names[node] ?? "");
  name.title = input.index.paths[node] ?? "";
  const additions = tree.additions[node] ?? 0;
  const deletions = tree.deletions[node] ?? 0;
  const status = statusLabel(statusOf(tree.statuses[node] ?? 0));
  row.setAttribute("aria-label", `${status} ${tree.names[node] ?? ""}, ${additions} added, ${deletions} deleted. Opens the diff on GitHub.`);
  const label = append(element("span", "tree-label"), createStatusLetter(tree, node), name);
  append(row, label, ...createLineCounts(additions, deletions), createChurnBar(additions, deletions, input.index.churnMax));
  return row;
}

/** Marks the list row for `node` (or none). `reveal` scrolls it into view, for hovers that start on the map. */
export function highlightRow(sidebar: Sidebar, node: number, reveal: boolean): void {
  if (sidebar.fileView !== FileView.list) return;
  if (sidebar.highlightedNode === node) return;
  sidebar.rowByNode.get(sidebar.highlightedNode)?.classList.remove("is-highlighted");
  sidebar.highlightedNode = node;
  const row = sidebar.rowByNode.get(node);
  if (row === undefined) return;
  row.classList.add("is-highlighted");
  if (reveal) row.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
}
