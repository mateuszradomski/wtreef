// The Filter section at the top of the sidebar: quiet checkbox rows for
// status, type, unchanged context and generated files, each with a count,
// and the files and folders hidden one by one, each with a way back. Built
// once per PR; syncFilterSection mirrors the filters into it. It never owns
// state: every toggle goes through a callback.

import { assert } from "./assert.ts";
import type { FileStatus, Tree } from "./decode.ts";
import { setTooltip } from "./control-tooltip.ts";
import { append, button, element, pathText } from "./dom.ts";
import { formatCount } from "./format.ts";
import { createIcon, IconKind } from "./icons.ts";
import { type Filters, hasActiveCategoryFilters, SizeMode, TYPE_KEY_NONE, TYPE_KEY_OTHER, type TreeIndex } from "./model.ts";
import { displayPath } from "./node-actions.ts";
import { CHANGED_STATUSES, statusClassName, statusDescription, statusLabel } from "./status.ts";

export interface FilterSectionCallbacks {
  readonly onToggleStatus: (status: FileStatus) => void;
  readonly onToggleType: (key: string) => void;
  readonly onToggleUnchanged: () => void;
  readonly onToggleGenerated: () => void;
  readonly onShowHidden: (node: number) => void;
  readonly onShowAllHidden: () => void;
  readonly onReset: () => void;
}

export interface FilterSection {
  readonly root: HTMLElement;
  readonly summary: HTMLElement;
  readonly statusRows: ReadonlyMap<FileStatus, HTMLButtonElement>;
  readonly typeRows: ReadonlyMap<string, HTMLButtonElement>;
  readonly unchangedRow: HTMLButtonElement;
  readonly unchangedNote: HTMLElement;
  readonly unchangedFileCount: number;
  readonly generatedRow: HTMLButtonElement | null;
  readonly hidden: HiddenGroup;
  readonly reset: HTMLButtonElement;
}

/** The Hidden group: shown only while something is hidden, rebuilt only when the hidden set changes. */
interface HiddenGroup {
  readonly root: HTMLElement;
  readonly list: HTMLElement;
  readonly tree: Tree;
  readonly paths: readonly string[];
  /** The set the list was built for; sets are values, so identity tells a change. */
  rendered: ReadonlySet<number> | null;
}

const UNCHANGED_CHURN_NOTE = "Context mode only";
/** The second line of every checkbox row's tooltip: what unticking does. */
const UNTICK_NOTE = "Untick to take them off the map and the file list.";
const UNCHANGED_TOOLTIP = "Unchanged files and folders around the changes, in gray. They show where the changes sit in the codebase.";
const UNCHANGED_CHURN_TOOLTIP =
  "Unchanged files and folders around the changes. Churn sizes tiles by changed lines, so unchanged files have no size and are left out.";

function typeLabel(key: string): string {
  if (key === TYPE_KEY_NONE) return "no extension";
  if (key === TYPE_KEY_OTHER) return "other";
  return `.${key}`;
}

function typeDescription(key: string): string {
  if (key === TYPE_KEY_NONE) return "Changed files with no extension, such as Makefile or .gitignore.";
  if (key === TYPE_KEY_OTHER) return "Changed files of the less common types, grouped together.";
  return `Changed files ending in .${key}`;
}

/** `startOpen` is false on narrow screens, where the section sits between the map and the file list. */
export function createFilterSection(tree: Tree, index: TreeIndex, callbacks: FilterSectionCallbacks, startOpen: boolean): FilterSection {
  const root = element("section", "filter-section");
  const details = element("details", "filter-details");
  details.open = startOpen;
  const summary = element("summary", "section-heading filter-summary", "Filter");
  const groups = element("div", "filter-groups");
  const statusRows = createStatusRows(groups, index, callbacks);
  const typeRows = createTypeRows(groups, index, callbacks);
  const show = createShowRows(groups, index, callbacks);
  const hidden = createHiddenGroup(tree, index, callbacks);
  groups.append(hidden.root);
  append(details, summary, groups);
  // Outside the summary: a button inside it would also toggle the section.
  const reset = button("text-button filter-reset", "Reset");
  setTooltip(
    reset,
    "Turn every filter in this section back on and show hidden files and folders again. Size, Include and Exclude stay as they are.",
  );
  reset.addEventListener("click", callbacks.onReset);
  append(root, details, reset);

  const unchangedFileCount = (index.subtreeFiles[0] ?? 0) - index.changedFiles.length;
  assert(unchangedFileCount >= 0, "changed files are a subset of all files");
  return { root, summary, statusRows, typeRows, ...show, unchangedFileCount, hidden, reset };
}

function createStatusRows(groups: HTMLElement, index: TreeIndex, callbacks: FilterSectionCallbacks): Map<FileStatus, HTMLButtonElement> {
  const rows = new Map<FileStatus, HTMLButtonElement>();
  const group = createGroup("Status", "filter-grid");
  for (const status of CHANGED_STATUSES) {
    const count = index.statusCounts[status] ?? 0;
    if (count === 0) continue;
    const row = createRow(statusLabel(status), formatCount(count), statusClassName(status));
    setTooltip(row, statusDescription(status), UNTICK_NOTE);
    row.addEventListener("click", () => callbacks.onToggleStatus(status));
    rows.set(status, row);
    group.rows.append(row);
  }
  if (rows.size > 0) groups.append(group.root);
  return rows;
}

function createTypeRows(groups: HTMLElement, index: TreeIndex, callbacks: FilterSectionCallbacks): Map<string, HTMLButtonElement> {
  const rows = new Map<string, HTMLButtonElement>();
  const group = createGroup("Type", "filter-grid");
  for (const bucket of index.typeBuckets) {
    const row = createRow(typeLabel(bucket.key), formatCount(bucket.count), "");
    setTooltip(row, typeDescription(bucket.key), UNTICK_NOTE);
    row.addEventListener("click", () => callbacks.onToggleType(bucket.key));
    rows.set(bucket.key, row);
    group.rows.append(row);
  }
  // A single type has nothing to filter against.
  if (rows.size > 1) groups.append(group.root);
  return rows;
}

function createShowRows(
  groups: HTMLElement,
  index: TreeIndex,
  callbacks: FilterSectionCallbacks,
): { unchangedRow: HTMLButtonElement; unchangedNote: HTMLElement; generatedRow: HTMLButtonElement | null } {
  const group = createGroup("Show", "filter-column");
  const unchangedRow = createRow("Unchanged", UNCHANGED_CHURN_NOTE, "");
  // aria-disabled rather than disabled: the row stays focusable and hoverable, so its tooltip can say why it is off.
  unchangedRow.addEventListener("click", () => {
    if (unchangedRow.getAttribute("aria-disabled") !== "true") callbacks.onToggleUnchanged();
  });
  const unchangedNote = unchangedRow.querySelector<HTMLElement>(".filter-count");
  assert(unchangedNote !== null, "every row has a count");
  group.rows.append(unchangedRow);
  let generatedRow: HTMLButtonElement | null = null;
  if (index.generatedChangedCount > 0) {
    generatedRow = createRow("Generated", formatCount(index.generatedChangedCount), "");
    const examples = "lockfiles, minified bundles, source maps, snapshots, and build output such as dist/ and vendor/";
    setTooltip(generatedRow, `Files a tool writes rather than a person: ${examples}.`, UNTICK_NOTE);
    generatedRow.addEventListener("click", callbacks.onToggleGenerated);
    group.rows.append(generatedRow);
  }
  groups.append(group.root);
  return { unchangedRow, unchangedNote, generatedRow };
}

function createHiddenGroup(tree: Tree, index: TreeIndex, callbacks: FilterSectionCallbacks): HiddenGroup {
  const root = element("div", "filter-group hidden-group");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Hidden");
  root.hidden = true;
  const heading = element("div", "filter-group-label hidden-heading");
  const label = element("span", "", "Hidden");
  label.setAttribute("aria-hidden", "true");
  setTooltip(label, "Files and folders you hid, with everything inside them. The map, the file list and the totals leave them out.");
  const showAll = button("text-button hidden-show-all", "Show all");
  setTooltip(showAll, "Show every hidden file and folder again.");
  showAll.addEventListener("click", callbacks.onShowAllHidden);
  const list = element("ul", "hidden-list");
  list.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const restore = event.target.closest<HTMLElement>(".hidden-restore");
    if (restore === null) return;
    const node = Number(restore.dataset["node"]);
    assert(Number.isInteger(node) && node > 0, "restore buttons name a hidden node");
    callbacks.onShowHidden(node);
  });
  append(root, append(heading, label, showAll), list);
  return { root, list, tree, paths: index.paths, rendered: null };
}

/**
 * Rebuilds the list in path order, so related entries sit together. A
 * restore button that had focus hands it to the one now in its place, or
 * to the next control once the list is empty, since its own row is gone.
 */
function renderHiddenList(section: FilterSection, hiddenNodes: ReadonlySet<number>): void {
  const { hidden } = section;
  const buttons = [...hidden.list.querySelectorAll<HTMLElement>(".hidden-restore")];
  const focused = buttons.findIndex((restore) => restore === document.activeElement);
  const entries = [...hiddenNodes].map((node) => ({ node, path: displayPath(hidden.tree, hidden.paths, node) }));
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  hidden.list.replaceChildren(...entries.map((entry) => createHiddenRow(entry.node, entry.path)));
  hidden.root.hidden = entries.length === 0;
  hidden.rendered = hiddenNodes;
  if (focused < 0) return;
  const next = hidden.list.querySelectorAll<HTMLElement>(".hidden-restore")[Math.min(focused, entries.length - 1)];
  (next ?? section.summary).focus({ preventScroll: true });
}

function createHiddenRow(node: number, path: string): HTMLElement {
  const row = element("li", "hidden-row");
  const shown = pathText("hidden-path", path);
  setTooltip(shown, path);
  const restore = button("hidden-restore", "", `Show ${path} again`);
  setTooltip(restore, "Show it on the map and in the file list again.");
  restore.dataset["node"] = String(node);
  restore.append(createIcon(IconKind.show));
  return append(row, shown, restore);
}

function createGroup(label: string, rowsClassName: string): { root: HTMLElement; rows: HTMLElement } {
  const root = element("div", "filter-group");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", label);
  const heading = element("div", "filter-group-label", label);
  heading.setAttribute("aria-hidden", "true");
  const rows = element("div", rowsClassName);
  append(root, heading, rows);
  return { root, rows };
}

/** A checkbox row: a 12px box (in the status color, if any), the label, and a right-aligned count or note. */
function createRow(label: string, note: string, statusClass: string): HTMLButtonElement {
  const row = button("filter-row", "");
  const box = element("span", statusClass === "" ? "filter-box" : `filter-box ${statusClass}`);
  box.setAttribute("aria-hidden", "true");
  append(row, box, element("span", "filter-label", label), element("span", "filter-count", note));
  return row;
}

function setPressed(row: HTMLButtonElement, pressed: boolean): void {
  row.setAttribute("aria-pressed", pressed ? "true" : "false");
}

export function syncFilterSection(section: FilterSection, filters: Filters): void {
  for (const [status, row] of section.statusRows) {
    setPressed(row, (filters.hiddenStatuses & (1 << status)) === 0);
  }
  for (const [key, row] of section.typeRows) {
    setPressed(row, !filters.hiddenTypes.has(key));
  }
  const isChurn = filters.sizeMode === SizeMode.churn;
  section.unchangedRow.setAttribute("aria-disabled", isChurn ? "true" : "false");
  if (isChurn) {
    setTooltip(section.unchangedRow, UNCHANGED_CHURN_TOOLTIP, "Switch Size to Context to see them.");
  } else {
    setTooltip(section.unchangedRow, UNCHANGED_TOOLTIP, "Untick to show only what changed.");
  }
  setPressed(section.unchangedRow, filters.showUnchanged);
  section.unchangedNote.textContent = isChurn ? UNCHANGED_CHURN_NOTE : formatCount(section.unchangedFileCount);
  if (section.generatedRow !== null) setPressed(section.generatedRow, filters.showGenerated);
  if (section.hidden.rendered !== filters.hiddenNodes) renderHiddenList(section, filters.hiddenNodes);
  section.reset.hidden = !hasActiveCategoryFilters(filters);
}
