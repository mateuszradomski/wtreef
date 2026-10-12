// The sidebar, top to bottom: the Filter section, the changed-file list,
// and the legend. The list holds the changed files that pass the filters
// inside the zoomed folder, heaviest churn first. It is also the accessible
// twin of the canvas: every tile's numbers are reachable here as links to
// the diff.

import { assert } from "./assert.ts";
import { churnIntensity } from "./color.ts";
import type { Tree } from "./decode.ts";
import { append, element, link } from "./dom.ts";
import type { FilterSection } from "./filter-section.ts";
import { formatAdditions, formatCount, formatDeletions } from "./format.ts";
import type { TreeIndex } from "./model.ts";
import { statusClassName, statusLabel, statusLetter, statusOf } from "./status.ts";
import { createLegend } from "./ui.ts";

/** Rendering is bounded; past this, filters are the better tool than scrolling. */
const LIST_ROWS_MAX = 400;
const NO_NODE = -1;

export interface SidebarCallbacks {
  readonly onHoverRow: (node: number) => void;
  readonly onLeaveRows: () => void;
}

export interface Sidebar {
  readonly root: HTMLElement;
  readonly filter: FilterSection;
  readonly heading: HTMLElement;
  readonly count: HTMLElement;
  readonly list: HTMLElement;
  readonly footer: HTMLElement;
  readonly rowByNode: Map<number, HTMLAnchorElement>;
  highlightedNode: number;
}

export interface FileListInput {
  readonly tree: Tree;
  readonly index: TreeIndex;
  readonly weights: Float64Array;
  readonly insideZoom: Uint8Array;
  readonly diffUrls: readonly string[];
  readonly fallbackUrl: string;
  readonly zoomPath: string;
}

export function createSidebar(filter: FilterSection, callbacks: SidebarCallbacks): Sidebar {
  const root = element("aside", "sidebar");
  root.setAttribute("aria-label", "Filters and changed files");
  const files = element("section", "files-section");
  const header = element("div", "files-header");
  const heading = element("h2", "section-heading files-heading", "Changed files");
  const count = element("span", "files-count mono");
  append(header, heading, count);
  const list = element("ol", "file-list");
  const footer = element("p", "file-list-footer");
  footer.hidden = true;
  append(files, header, list, footer);
  append(root, filter.root, files, createLegend());

  // Delegated listeners: one set for the whole list instead of one per row.
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
  return { root, filter, heading, count, list, footer, rowByNode: new Map(), highlightedNode: NO_NODE };
}

export function renderFileList(sidebar: Sidebar, input: FileListInput): void {
  const { tree, index } = input;
  sidebar.rowByNode.clear();
  sidebar.highlightedNode = NO_NODE;
  const rows: HTMLElement[] = [];
  let matching = 0;
  for (const node of index.changedFiles) {
    if ((input.weights[node] ?? 0) <= 0) continue;
    if (input.insideZoom[node] !== 1) continue;
    matching++;
    if (rows.length >= LIST_ROWS_MAX) continue;
    const row = createRow(tree, index, node, input);
    sidebar.rowByNode.set(node, row);
    rows.push(append(element("li", ""), row));
  }
  assert(rows.length <= LIST_ROWS_MAX, "the list is bounded");
  sidebar.list.replaceChildren(...rows);
  const total = index.changedFiles.length;
  sidebar.count.textContent = matching === total ? formatCount(total) : `${formatCount(matching)} of ${formatCount(total)}`;
  sidebar.heading.textContent = input.zoomPath === "" ? "Changed files" : `Changed in ${input.zoomPath}/`;
  sidebar.footer.hidden = matching <= LIST_ROWS_MAX && matching > 0;
  sidebar.footer.textContent =
    matching === 0
      ? "No changed files match these filters."
      : `${formatCount(matching - LIST_ROWS_MAX)} more files. Narrow them down with the filters or a path pattern.`;
}

function createRow(tree: Tree, index: TreeIndex, node: number, input: FileListInput): HTMLAnchorElement {
  const path = index.paths[node] ?? "";
  const url = input.diffUrls[node] ?? "";
  const row = link("file-row", url === "" ? input.fallbackUrl : url, "", true);
  row.dataset["node"] = String(node);
  const status = statusOf(tree.statuses[node] ?? 0);
  const letter = element("span", `file-status ${statusClassName(status)}`, statusLetter(status));
  letter.title = statusLabel(status);

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
  const additionsElement = element("span", additions === 0 ? "file-additions is-zero" : "file-additions", formatAdditions(additions));
  const deletionsElement = element("span", deletions === 0 ? "file-deletions is-zero" : "file-deletions", formatDeletions(deletions));
  row.setAttribute("aria-label", `${statusLabel(status)} ${path}, ${additions} added, ${deletions} deleted. Opens the diff on GitHub.`);
  append(row, letter, pathElement, additionsElement, deletionsElement, createChurnBar(additions, deletions, index.churnMax));
  return row;
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

/** Marks the row for `node` (or none). `reveal` scrolls it into view, for hovers that start on the map. */
export function highlightRow(sidebar: Sidebar, node: number, reveal: boolean): void {
  if (sidebar.highlightedNode === node) return;
  sidebar.rowByNode.get(sidebar.highlightedNode)?.classList.remove("is-highlighted");
  sidebar.highlightedNode = node;
  const row = sidebar.rowByNode.get(node);
  if (row === undefined) return;
  row.classList.add("is-highlighted");
  if (reveal) row.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
}
