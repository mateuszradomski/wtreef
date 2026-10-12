// The Filter section at the top of the sidebar: quiet checkbox rows for
// status, type, unchanged context and generated files, each with a count.
// Built once per PR; syncFilterSection mirrors the filters into it. It never
// owns state: every toggle goes through a callback.

import { assert } from "./assert.ts";
import type { FileStatus } from "./decode.ts";
import { append, button, element } from "./dom.ts";
import { formatCount } from "./format.ts";
import { type Filters, hasActiveCategoryFilters, SizeMode, TYPE_KEY_NONE, TYPE_KEY_OTHER, type TreeIndex } from "./model.ts";
import { CHANGED_STATUSES, statusClassName, statusLabel } from "./status.ts";

export interface FilterSectionCallbacks {
  readonly onToggleStatus: (status: FileStatus) => void;
  readonly onToggleType: (key: string) => void;
  readonly onToggleUnchanged: () => void;
  readonly onToggleGenerated: () => void;
  readonly onReset: () => void;
}

export interface FilterSection {
  readonly root: HTMLElement;
  readonly statusRows: ReadonlyMap<FileStatus, HTMLButtonElement>;
  readonly typeRows: ReadonlyMap<string, HTMLButtonElement>;
  readonly unchangedRow: HTMLButtonElement;
  readonly unchangedNote: HTMLElement;
  readonly unchangedFileCount: number;
  readonly generatedRow: HTMLButtonElement | null;
  readonly reset: HTMLButtonElement;
}

const UNCHANGED_CHURN_NOTE = "Context mode only";

function typeLabel(key: string): string {
  if (key === TYPE_KEY_NONE) return "no extension";
  if (key === TYPE_KEY_OTHER) return "other";
  return `.${key}`;
}

/** `startOpen` is false on narrow screens, where the section sits between the map and the file list. */
export function createFilterSection(index: TreeIndex, callbacks: FilterSectionCallbacks, startOpen: boolean): FilterSection {
  const root = element("section", "filter-section");
  const details = element("details", "filter-details");
  details.open = startOpen;
  const summary = element("summary", "section-heading filter-summary", "Filter");
  const groups = element("div", "filter-groups");
  const statusRows = createStatusRows(groups, index, callbacks);
  const typeRows = createTypeRows(groups, index, callbacks);
  const show = createShowRows(groups, index, callbacks);
  append(details, summary, groups);
  // Outside the summary: a button inside it would also toggle the section.
  const reset = button("text-button filter-reset", "Reset");
  reset.title = "Show every status, type, and hidden file and folder again";
  reset.addEventListener("click", callbacks.onReset);
  append(root, details, reset);

  const unchangedFileCount = (index.subtreeFiles[0] ?? 0) - index.changedFiles.length;
  assert(unchangedFileCount >= 0, "changed files are a subset of all files");
  return { root, statusRows, typeRows, ...show, unchangedFileCount, reset };
}

function createStatusRows(groups: HTMLElement, index: TreeIndex, callbacks: FilterSectionCallbacks): Map<FileStatus, HTMLButtonElement> {
  const rows = new Map<FileStatus, HTMLButtonElement>();
  const group = createGroup("Status", "filter-grid");
  for (const status of CHANGED_STATUSES) {
    const count = index.statusCounts[status] ?? 0;
    if (count === 0) continue;
    const row = createRow(statusLabel(status), formatCount(count), statusClassName(status));
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
  unchangedRow.title = "Unchanged files and folders around the changes. Only Context mode draws them.";
  unchangedRow.addEventListener("click", callbacks.onToggleUnchanged);
  const unchangedNote = unchangedRow.querySelector<HTMLElement>(".filter-count");
  assert(unchangedNote !== null, "every row has a count");
  group.rows.append(unchangedRow);
  let generatedRow: HTMLButtonElement | null = null;
  if (index.generatedChangedCount > 0) {
    generatedRow = createRow("Generated", formatCount(index.generatedChangedCount), "");
    generatedRow.title = "Lockfiles, minified bundles, source maps, snapshots and build output";
    generatedRow.addEventListener("click", callbacks.onToggleGenerated);
    group.rows.append(generatedRow);
  }
  groups.append(group.root);
  return { unchangedRow, unchangedNote, generatedRow };
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
  section.unchangedRow.disabled = isChurn;
  setPressed(section.unchangedRow, filters.showUnchanged);
  section.unchangedNote.textContent = isChurn ? UNCHANGED_CHURN_NOTE : formatCount(section.unchangedFileCount);
  if (section.generatedRow !== null) setPressed(section.generatedRow, filters.showGenerated);
  section.reset.hidden = !hasActiveCategoryFilters(filters);
}
