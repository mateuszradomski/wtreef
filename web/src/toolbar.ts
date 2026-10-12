// The filter row: size mode, status / type chips, context toggles, search
// and reset. Built once per PR; syncToolbar mirrors the filters into it.
// The toolbar never owns state: every interaction goes through a callback
// that the controller turns into a new Filters value.

import type { FileStatus } from "./decode.ts";
import { append, button, element } from "./dom.ts";
import { formatCount } from "./format.ts";
import { type Filters, hasActiveFilters, SizeMode, TYPE_KEY_NONE, TYPE_KEY_OTHER, type TreeIndex } from "./model.ts";
import { CHANGED_STATUSES, statusClassName, statusLabel } from "./status.ts";

export interface ToolbarCallbacks {
  readonly onSizeMode: (mode: SizeMode) => void;
  readonly onToggleStatus: (status: FileStatus) => void;
  readonly onToggleType: (key: string) => void;
  readonly onToggleUnchanged: () => void;
  readonly onToggleGenerated: () => void;
  readonly onSearch: (text: string) => void;
  readonly onReset: () => void;
}

export interface Toolbar {
  readonly root: HTMLElement;
  readonly sizeButtons: ReadonlyMap<SizeMode, HTMLButtonElement>;
  readonly statusChips: ReadonlyMap<FileStatus, HTMLButtonElement>;
  readonly typeChips: ReadonlyMap<string, HTMLButtonElement>;
  readonly unchangedChip: HTMLButtonElement;
  readonly generatedChip: HTMLButtonElement | null;
  readonly search: HTMLInputElement;
  readonly reset: HTMLButtonElement;
}

const SIZE_MODE_LABELS: ReadonlyArray<readonly [SizeMode, string, string]> = [
  [SizeMode.context, "Context", "Size tiles by file size, with unchanged files around the changes"],
  [SizeMode.churn, "Churn", "Size tiles by lines added plus lines removed"],
];

function typeLabel(key: string): string {
  if (key === TYPE_KEY_NONE) return "no ext";
  if (key === TYPE_KEY_OTHER) return "other";
  return `.${key}`;
}

export function createToolbar(index: TreeIndex, callbacks: ToolbarCallbacks): Toolbar {
  const root = element("div", "toolbar");
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", "Filters");
  const sizeButtons = createSizeModeGroup(root, callbacks);
  const statusChips = createStatusGroup(root, index, callbacks);
  const typeChips = createTypeGroup(root, index, callbacks);
  const { unchangedChip, generatedChip } = createShowGroup(root, index, callbacks);
  const { wrapper, search } = createSearch(callbacks);
  const reset = button("text-button reset", "Reset");
  reset.title = "Show every file again and clear the search";
  reset.addEventListener("click", callbacks.onReset);
  root.append(append(element("div", "toolbar-end"), wrapper, reset));
  return { root, sizeButtons, statusChips, typeChips, unchangedChip, generatedChip, search, reset };
}

function createSizeModeGroup(root: HTMLElement, callbacks: ToolbarCallbacks): Map<SizeMode, HTMLButtonElement> {
  const sizeButtons = new Map<SizeMode, HTMLButtonElement>();
  const segmented = element("div", "segmented");
  segmented.setAttribute("role", "radiogroup");
  segmented.setAttribute("aria-label", "Size by");
  for (const [mode, label, description] of SIZE_MODE_LABELS) {
    const option = button("segment", label);
    option.setAttribute("role", "radio");
    option.title = description;
    option.addEventListener("click", () => callbacks.onSizeMode(mode));
    sizeButtons.set(mode, option);
    segmented.append(option);
  }
  root.append(group("Size by", segmented));
  return sizeButtons;
}

function createStatusGroup(root: HTMLElement, index: TreeIndex, callbacks: ToolbarCallbacks): Map<FileStatus, HTMLButtonElement> {
  const statusChips = new Map<FileStatus, HTMLButtonElement>();
  const chips = element("div", "chips");
  for (const status of CHANGED_STATUSES) {
    const count = index.statusCounts[status] ?? 0;
    if (count === 0) continue;
    const chip = createChip(statusLabel(status), count, `chip-box ${statusClassName(status)}`);
    chip.addEventListener("click", () => callbacks.onToggleStatus(status));
    statusChips.set(status, chip);
    chips.append(chip);
  }
  if (statusChips.size > 0) root.append(group("Status", chips));
  return statusChips;
}

function createTypeGroup(root: HTMLElement, index: TreeIndex, callbacks: ToolbarCallbacks): Map<string, HTMLButtonElement> {
  const typeChips = new Map<string, HTMLButtonElement>();
  const chips = element("div", "chips");
  for (const bucket of index.typeBuckets) {
    const chip = createChip(typeLabel(bucket.key), bucket.count, "chip-box");
    chip.addEventListener("click", () => callbacks.onToggleType(bucket.key));
    typeChips.set(bucket.key, chip);
    chips.append(chip);
  }
  // A single type has nothing to filter against.
  if (typeChips.size > 1) root.append(group("Type", chips));
  return typeChips;
}

function createShowGroup(
  root: HTMLElement,
  index: TreeIndex,
  callbacks: ToolbarCallbacks,
): { unchangedChip: HTMLButtonElement; generatedChip: HTMLButtonElement | null } {
  const chips = element("div", "chips");
  const unchangedChip = createChip("Unchanged", -1, "chip-box chip-box-context");
  unchangedChip.title = "Unchanged files and folders around the changes (Context mode only)";
  unchangedChip.addEventListener("click", callbacks.onToggleUnchanged);
  chips.append(unchangedChip);
  let generatedChip: HTMLButtonElement | null = null;
  if (index.generatedChangedCount > 0) {
    generatedChip = createChip("Generated", index.generatedChangedCount, "chip-box");
    generatedChip.title = "Lockfiles, minified bundles, source maps, snapshots and build output";
    generatedChip.addEventListener("click", callbacks.onToggleGenerated);
    chips.append(generatedChip);
  }
  root.append(group("Show", chips));
  return { unchangedChip, generatedChip };
}

function group(label: string, content: HTMLElement): HTMLElement {
  const container = element("div", "toolbar-group");
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", label);
  return append(container, element("span", "toolbar-label", label), content);
}

/** A toggle chip: square checkbox, label, count. `count < 0` hides the count. */
function createChip(label: string, count: number, boxClassName: string): HTMLButtonElement {
  const chip = button("chip", "");
  chip.append(element("span", boxClassName), element("span", "chip-label", label));
  if (count >= 0) chip.append(element("span", "chip-count", formatCount(count)));
  return chip;
}

function createSearch(callbacks: ToolbarCallbacks): { wrapper: HTMLElement; search: HTMLInputElement } {
  const wrapper = element("label", "search");
  const search = element("input", "search-input");
  search.type = "search";
  search.placeholder = "Filter paths";
  search.spellcheck = false;
  search.autocomplete = "off";
  search.setAttribute("aria-label", "Filter paths");
  search.addEventListener("input", () => callbacks.onSearch(search.value));
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || event.key === "Enter") search.blur();
  });
  const hint = element("kbd", "search-hint", "/");
  hint.setAttribute("aria-hidden", "true");
  wrapper.append(search, hint);
  return { wrapper, search };
}

function setPressed(chip: HTMLButtonElement, pressed: boolean): void {
  chip.setAttribute("aria-pressed", pressed ? "true" : "false");
}

export function syncToolbar(toolbar: Toolbar, filters: Filters): void {
  for (const [mode, option] of toolbar.sizeButtons) {
    const active = mode === filters.sizeMode;
    option.setAttribute("aria-checked", active ? "true" : "false");
    option.classList.toggle("is-active", active);
  }
  for (const [status, chip] of toolbar.statusChips) {
    setPressed(chip, (filters.hiddenStatuses & (1 << status)) === 0);
  }
  for (const [key, chip] of toolbar.typeChips) {
    setPressed(chip, !filters.hiddenTypes.has(key));
  }
  setPressed(toolbar.unchangedChip, filters.showUnchanged);
  toolbar.unchangedChip.disabled = filters.sizeMode === SizeMode.churn;
  if (toolbar.generatedChip !== null) setPressed(toolbar.generatedChip, filters.showGenerated);
  if (toolbar.search.value !== filters.search) toolbar.search.value = filters.search;
  toolbar.reset.hidden = !hasActiveFilters(filters);
}
