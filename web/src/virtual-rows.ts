// Windowed rows for the sidebar's long lists. Only the rows in or near the
// visible part of a container are in the DOM, each placed at its index
// times the row height; a spacer (the container's ::after, sized through
// --virtual-height) keeps the scroll height of all of them. A re-render
// builds a screenful of rows instead of thousands, so filtering, zooming
// and opening folders stay within a frame however long the list is.
//
// The container may scroll itself (the sidebar beside the map) or with
// the page (stacked under it on narrow screens): the visible part is the
// container's box clipped to the viewport either way.

import { assert } from "./assert.ts";

/** Rows built past each edge of the visible part, so a fast scroll does not show blank space before the next frame. */
const OVERSCAN_ROWS = 10;
const NO_ROW = -1;

export interface RowRange {
  readonly start: number;
  readonly end: number;
}

export interface VirtualRows {
  readonly container: HTMLElement;
  readonly rowHeight: number;
  readonly createRow: (index: number) => HTMLElement;
  count: number;
  /** Rendered rows by index, in DOM order by index so Tab and screen readers meet them in order. */
  readonly rows: Map<number, HTMLElement>;
  /** A row kept rendered wherever the list is scrolled: the tree's one Tab stop. */
  pinned: number;
}

export function createVirtualRows(container: HTMLElement, rowHeight: number, createRow: (index: number) => HTMLElement): VirtualRows {
  assert(rowHeight > 0, "rows have a height");
  const rows: VirtualRows = { container, rowHeight, createRow, count: 0, rows: new Map(), pinned: NO_ROW };
  const sync = () => syncVirtualRows(rows);
  container.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", sync, { passive: true });
  new ResizeObserver(sync).observe(container);
  return rows;
}

/**
 * The rows to build for the part of the list between `top` and `bottom`, in
 * pixels from the first row's top edge, with OVERSCAN_ROWS more on each side.
 * Empty when none of the list is visible.
 */
export function visibleRowRange(top: number, bottom: number, rowHeight: number, count: number): RowRange {
  assert(rowHeight > 0, "rows have a height");
  if (bottom <= top || count === 0) return { start: 0, end: 0 };
  const first = Math.floor(top / rowHeight);
  const last = Math.ceil(bottom / rowHeight);
  const start = Math.min(count, Math.max(0, first - OVERSCAN_ROWS));
  const end = Math.min(count, Math.max(0, last + OVERSCAN_ROWS));
  return end <= start ? { start: 0, end: 0 } : { start, end };
}

/** Replaces every row with rows for a list of `count`: the model behind them changed, so no index carries over, the pinned one included. */
export function resetVirtualRows(rows: VirtualRows, count: number): void {
  rows.count = count;
  rows.rows.clear();
  rows.pinned = NO_ROW;
  rows.container.style.setProperty("--virtual-height", `${count * rows.rowHeight}px`);
  rows.container.replaceChildren();
  syncVirtualRows(rows);
}

/**
 * Builds the rows that came into view and drops the ones that left it,
 * except the pinned row and the one holding focus: removing that would
 * drop keyboard focus to the page.
 */
export function syncVirtualRows(rows: VirtualRows): void {
  if (rows.count === 0 || rows.container.hidden) return;
  const range = currentRange(rows);
  for (const [index, row] of rows.rows) {
    if ((index >= range.start && index < range.end) || index === rows.pinned) continue;
    if (row.contains(document.activeElement)) continue;
    row.remove();
    rows.rows.delete(index);
  }
  for (let index = range.start; index < range.end; index++) ensureVirtualRow(rows, index);
  if (rows.pinned !== NO_ROW) ensureVirtualRow(rows, rows.pinned);
}

function currentRange(rows: VirtualRows): RowRange {
  const { container } = rows;
  const box = container.getBoundingClientRect();
  // Rows are placed in the padding box, which scrolls with the content.
  const origin = box.top + container.clientTop - container.scrollTop;
  const top = Math.max(box.top, 0) - origin;
  const bottom = Math.min(box.bottom, window.innerHeight) - origin;
  return visibleRowRange(top, bottom, rows.rowHeight, rows.count);
}

/** The row at `index` if it is rendered. */
export function virtualRow(rows: VirtualRows, index: number): HTMLElement | null {
  return rows.rows.get(index) ?? null;
}

/**
 * The row at `index`, built if it is not rendered, so it can take focus or
 * be scrolled to. Once it is in view, scrolling decides whether it stays.
 */
export function ensureVirtualRow(rows: VirtualRows, index: number): HTMLElement {
  assert(index >= 0 && index < rows.count, "the row exists");
  const existing = rows.rows.get(index);
  if (existing !== undefined) return existing;
  const row = rows.createRow(index);
  // CSSOM, not a style attribute: the CSP forbids inline styles but allows this.
  row.style.top = `${index * rows.rowHeight}px`;
  rows.container.insertBefore(row, nextRenderedRow(rows, index));
  rows.rows.set(index, row);
  return row;
}

/** The rendered row with the smallest index above `index`, or null to append. */
function nextRenderedRow(rows: VirtualRows, index: number): HTMLElement | null {
  let nextIndex = rows.count;
  let next: HTMLElement | null = null;
  for (const [rendered, row] of rows.rows) {
    if (rendered > index && rendered < nextIndex) {
      nextIndex = rendered;
      next = row;
    }
  }
  return next;
}

/** The index of the rendered row containing `target`, or -1. */
export function virtualRowOf(rows: VirtualRows, target: Node | null): number {
  if (target === null) return NO_ROW;
  for (const [index, row] of rows.rows) {
    if (row.contains(target)) return index;
  }
  return NO_ROW;
}
