// The pull request view controller. One state object; events only mutate
// it and set dirty flags, and a single requestAnimationFrame callback does
// the work in a fixed order. That batches pointer moves to one hit test
// per frame and keeps relayout to resize, filter, zoom and mode changes.

import { assert } from "./assert.ts";
import { NodeKind, type PullRequestData, type Tree } from "./decode.ts";
import { computeDiffUrls } from "./diff.ts";
import { element, requireElement } from "./dom.ts";
import { hitTest, isDirectoryFrameHit, NO_NODE } from "./hit.ts";
import { computeLayout, createLayout, type Layout } from "./layout.ts";
import {
  buildTreeIndex,
  computeSearchMatches,
  computeSubtreeMembership,
  computeWeights,
  DEFAULT_FILTERS,
  type Filters,
  isChangedFile,
  type TreeIndex,
} from "./model.ts";
import { type ChartPalette, computeTileStyles, drawBase, drawHighlight, readChartPalette, type TileStyles } from "./render.ts";

export const HoverSource = { none: 0, canvas: 1, list: 2 } as const;
export type HoverSource = (typeof HoverSource)[keyof typeof HoverSource];

export interface ViewState {
  readonly data: PullRequestData;
  readonly tree: Tree;
  readonly index: TreeIndex;
  /** Filled asynchronously after load; "" until then and for unchanged nodes. */
  diffUrls: readonly string[];
  filters: Filters;
  zoomNode: number;
  readonly weights: Float64Array;
  readonly searchMatches: Uint8Array;
  readonly insideZoom: Uint8Array;
  readonly layout: Layout;
  palette: ChartPalette;
  styles: TileStyles;
  width: number;
  height: number;
  pixelRatio: number;
  pointerX: number;
  pointerY: number;
  pointerInside: boolean;
  hoveredNode: number;
  hoverSource: HoverSource;
  weightsDirty: boolean;
  searchDirty: boolean;
  layoutDirty: boolean;
  baseDirty: boolean;
  pointerDirty: boolean;
  overlayDirty: boolean;
  frameRequested: boolean;
}

interface MapElements {
  readonly container: HTMLElement;
  readonly base: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  readonly baseContext: CanvasRenderingContext2D;
  readonly overlayContext: CanvasRenderingContext2D;
  readonly empty: HTMLElement;
}

export interface View {
  readonly state: ViewState;
  readonly map: MapElements;
}

export function mountPullRequestView(root: HTMLElement, data: PullRequestData): View {
  const map = createMapElements();
  root.replaceChildren(element("div", "pr-view"));
  const shell = requireElement(root.firstElementChild, ".pr-view") as HTMLElement;
  const main = element("div", "pr-main");
  main.append(map.container);
  shell.append(main);

  const view: View = { state: createState(data), map };
  attachMapEvents(view);
  attachWindowEvents(view);
  void computeDiffUrls(data.pullRequest, view.state.index, data.tree.nodeCount).then((urls) => {
    view.state.diffUrls = urls;
  });
  requestFrame(view);
  return view;
}

function createState(data: PullRequestData): ViewState {
  const { tree } = data;
  const index = buildTreeIndex(tree);
  const palette = readChartPalette(readCssToken);
  return {
    data,
    tree,
    index,
    diffUrls: [],
    filters: DEFAULT_FILTERS,
    zoomNode: 0,
    weights: new Float64Array(tree.nodeCount),
    searchMatches: new Uint8Array(tree.nodeCount),
    insideZoom: new Uint8Array(tree.nodeCount),
    layout: createLayout(tree.nodeCount),
    palette,
    styles: computeTileStyles(tree, index, palette),
    width: 0,
    height: 0,
    pixelRatio: window.devicePixelRatio || 1,
    pointerX: 0,
    pointerY: 0,
    pointerInside: false,
    hoveredNode: NO_NODE,
    hoverSource: HoverSource.none,
    weightsDirty: true,
    searchDirty: true,
    layoutDirty: true,
    baseDirty: true,
    pointerDirty: false,
    overlayDirty: true,
    frameRequested: false,
  };
}

function readCssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}

function createMapElements(): MapElements {
  const container = element("div", "map");
  const base = element("canvas", "map-canvas");
  const overlay = element("canvas", "map-canvas map-overlay");
  base.setAttribute("aria-hidden", "true");
  overlay.setAttribute("role", "img");
  overlay.setAttribute("aria-label", "Treemap of the repository; changed files are colored. The file list is the accessible equivalent.");
  const empty = element("div", "map-empty");
  empty.hidden = true;
  container.append(base, overlay, empty);
  const baseContext = base.getContext("2d", { alpha: false });
  const overlayContext = overlay.getContext("2d", { alpha: true });
  assert(baseContext !== null, "canvas 2d context is available");
  assert(overlayContext !== null, "canvas 2d context is available");
  return { container, base, overlay, baseContext, overlayContext, empty };
}

export function requestFrame(view: View): void {
  if (view.state.frameRequested) return;
  view.state.frameRequested = true;
  requestAnimationFrame(() => runFrame(view));
}

/** The only place that does work. Order matters: each step may dirty the next. */
function runFrame(view: View): void {
  const { state } = view;
  state.frameRequested = false;
  if (state.weightsDirty) {
    computeWeights(state.tree, state.index, state.filters, state.weights);
    computeSubtreeMembership(state.tree, state.zoomNode, state.insideZoom);
    state.weightsDirty = false;
    state.layoutDirty = true;
  }
  if (state.searchDirty) {
    computeSearchMatches(state.tree, state.index, state.filters.search, state.searchMatches);
    state.searchDirty = false;
    state.baseDirty = true;
  }
  if (state.layoutDirty) {
    relayout(view);
    state.layoutDirty = false;
    state.baseDirty = true;
    state.pointerDirty = true;
  }
  if (state.baseDirty) {
    drawBase(view.map.baseContext, sceneOf(state), state.pixelRatio);
    state.baseDirty = false;
  }
  if (state.pointerDirty) {
    updateCanvasHover(view);
    state.pointerDirty = false;
  }
  if (state.overlayDirty) {
    drawHighlight(view.map.overlayContext, state.layout, state.palette, state.hoveredNode, state.pixelRatio);
    state.overlayDirty = false;
  }
}

function sceneOf(state: ViewState) {
  return {
    tree: state.tree,
    index: state.index,
    layout: state.layout,
    styles: state.styles,
    palette: state.palette,
    searchMatches: state.searchMatches,
    searchActive: state.filters.search.trim() !== "",
  };
}

function relayout(view: View): void {
  const { state, map } = view;
  const backingWidth = Math.max(1, Math.round(state.width * state.pixelRatio));
  const backingHeight = Math.max(1, Math.round(state.height * state.pixelRatio));
  for (const canvas of [map.base, map.overlay]) {
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
  }
  computeLayout(state.tree, state.index, state.weights, state.zoomNode, state.width, state.height, state.layout);
  map.empty.hidden = state.layout.drawCount > 0 || state.width === 0;
  map.empty.textContent = "No files match these filters.";
  state.overlayDirty = true;
}

function updateCanvasHover(view: View): void {
  const { state, map } = view;
  if (state.hoverSource === HoverSource.list) return;
  const node = state.pointerInside
    ? hitTest(state.tree, state.index, state.layout, state.pointerX, state.pointerY)
    : NO_NODE;
  const hovered = node === state.layout.rootNode ? NO_NODE : node;
  map.overlay.classList.toggle("is-clickable", isClickable(state, hovered));
  if (hovered === state.hoveredNode) return;
  state.hoveredNode = hovered;
  state.hoverSource = hovered === NO_NODE ? HoverSource.none : HoverSource.canvas;
  state.overlayDirty = true;
}

function isClickable(state: ViewState, node: number): boolean {
  if (node === NO_NODE) return false;
  if (isChangedFile(state.tree, node)) return true;
  return isDirectoryFrameHit(state.tree, state.layout, node);
}

function attachMapEvents(view: View): void {
  const { state, map } = view;
  map.overlay.addEventListener("pointermove", (event) => {
    state.pointerX = event.offsetX;
    state.pointerY = event.offsetY;
    state.pointerInside = true;
    state.pointerDirty = true;
    if (state.hoverSource === HoverSource.list) state.hoverSource = HoverSource.none;
    requestFrame(view);
  });
  map.overlay.addEventListener("pointerleave", () => {
    state.pointerInside = false;
    state.pointerDirty = true;
    requestFrame(view);
  });
  map.overlay.addEventListener("click", (event) => {
    const node = hitTest(state.tree, state.index, state.layout, event.offsetX, event.offsetY);
    activateNode(view, node);
  });
  const resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (entry === undefined) return;
    state.width = Math.floor(entry.contentRect.width);
    state.height = Math.floor(entry.contentRect.height);
    state.pixelRatio = window.devicePixelRatio || 1;
    state.layoutDirty = true;
    requestFrame(view);
  });
  resizeObserver.observe(map.container);
}

/** Click or Enter on a node: changed files open their diff, directories zoom in. */
export function activateNode(view: View, node: number): void {
  const { state } = view;
  if (node === NO_NODE) return;
  if (isChangedFile(state.tree, node)) {
    const url = state.diffUrls[node] ?? "";
    if (url !== "") window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  if (isDirectoryFrameHit(state.tree, state.layout, node)) zoomTo(view, node);
}

export function zoomTo(view: View, node: number): void {
  const { state } = view;
  assert(state.tree.kinds[node] === NodeKind.directory, "only directories can be zoomed into");
  if (node === state.zoomNode) return;
  state.zoomNode = node;
  state.hoveredNode = NO_NODE;
  state.hoverSource = HoverSource.none;
  state.weightsDirty = true;
  requestFrame(view);
}

function zoomOut(view: View): void {
  const { state } = view;
  if (state.zoomNode === 0) return;
  zoomTo(view, state.tree.parents[state.zoomNode] ?? 0);
}

function attachWindowEvents(view: View): void {
  const { state } = view;
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !isTypingTarget(event.target)) zoomOut(view);
  });
  const colorScheme = window.matchMedia("(prefers-color-scheme: light)");
  colorScheme.addEventListener("change", () => {
    state.palette = readChartPalette(readCssToken);
    state.styles = computeTileStyles(state.tree, state.index, state.palette);
    state.baseDirty = true;
    state.overlayDirty = true;
    requestFrame(view);
  });
  watchPixelRatio(view);
}

/**
 * devicePixelRatio has no change event, but a resolution media query that
 * matches only the current ratio does. Moving the window to another screen
 * fires it without any resize, so the listener re-targets the new ratio.
 */
function watchPixelRatio(view: View): void {
  let query = window.matchMedia(`(resolution: ${view.state.pixelRatio}dppx)`);
  const onChange = (): void => {
    query.removeEventListener("change", onChange);
    view.state.pixelRatio = window.devicePixelRatio || 1;
    view.state.layoutDirty = true;
    requestFrame(view);
    query = window.matchMedia(`(resolution: ${view.state.pixelRatio}dppx)`);
    query.addEventListener("change", onChange);
  };
  query.addEventListener("change", onChange);
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}
