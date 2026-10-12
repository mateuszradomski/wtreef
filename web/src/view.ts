// The pull request view controller. One state object; events only mutate
// it and set dirty flags, and a single requestAnimationFrame callback does
// the work in a fixed order. That batches pointer moves to one hit test
// per frame and keeps relayout to resize, filter, zoom and mode changes.

import { assert } from "./assert.ts";
import { NodeKind, type PullRequestData, type Tree } from "./decode.ts";
import { computeDiffUrls, filesTabUrl } from "./diff.ts";
import { append, element } from "./dom.ts";
import { hitTest, isDirectoryFrameHit, NO_NODE } from "./hit.ts";
import { chainEnd, chainTop, computeLayout, createLayout, type Layout, LayoutFlag } from "./layout.ts";
import {
  buildTreeIndex,
  computeSubtreeMembership,
  computeWeights,
  DEFAULT_FILTERS,
  type Filters,
  filtersEqual,
  findDirectoryByPath,
  isChangedFile,
  type TreeIndex,
} from "./model.ts";
import { parsePathPattern } from "./pattern.ts";
import { parseViewQuery, serializeViewQuery } from "./query.ts";
import { type ChartPalette, computeTileStyles, drawBase, drawHighlight, readChartPalette, type TileStyles } from "./render.ts";
import { createSidebar, highlightRow, renderFileList, type Sidebar } from "./sidebar.ts";
import { createToolbar, syncToolbar, type Toolbar, type ToolbarCallbacks } from "./toolbar.ts";
import { createTooltip, describeNode, fillTooltip, hideTooltip, moveTooltip, type Tooltip } from "./tooltip.ts";
import { createBreadcrumbs, createHeader, createLegend, createTruncationBanner, renderBreadcrumbs } from "./ui.ts";

const HoverSource = { none: 0, canvas: 1, list: 2 } as const;
type HoverSource = (typeof HoverSource)[keyof typeof HoverSource];

export interface ViewState {
  readonly data: PullRequestData;
  readonly tree: Tree;
  readonly index: TreeIndex;
  /** Filled asynchronously after load; "" until then and for unchanged nodes. */
  diffUrls: readonly string[];
  filters: Filters;
  zoomNode: number;
  readonly weights: Float64Array;
  readonly insideZoom: Uint8Array;
  readonly layout: Layout;
  palette: ChartPalette;
  styles: TileStyles;
  width: number;
  height: number;
  pixelRatio: number;
  /** Pointer in canvas coordinates, for hit testing. */
  pointerX: number;
  pointerY: number;
  /** Pointer in viewport coordinates, for placing the tooltip. */
  pointerClientX: number;
  pointerClientY: number;
  pointerInside: boolean;
  hoveredNode: number;
  hoverSource: HoverSource;
  weightsDirty: boolean;
  layoutDirty: boolean;
  baseDirty: boolean;
  pointerDirty: boolean;
  overlayDirty: boolean;
  controlsDirty: boolean;
  urlDirty: boolean;
  listDirty: boolean;
  highlightDirty: boolean;
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
  readonly toolbar: Toolbar;
  readonly crumbList: HTMLElement;
  readonly sidebar: Sidebar;
  readonly tooltip: Tooltip;
}

export function mountPullRequestView(root: HTMLElement, data: PullRequestData, search: string): View {
  const state = createState(data, search);
  const map = createMapElements();
  // Toolbar and sidebar callbacks need the view, which holds them; they
  // only run after mount, by which time `view` is assigned.
  let view: View | null = null;
  const getView = (): View => {
    assert(view !== null, "events fire only after mount");
    return view;
  };
  const toolbar = createToolbar(state.index, toolbarCallbacks(getView));
  const sidebar = createSidebar({
    onHoverRow: (node) => hoverFromList(getView(), node),
    onLeaveRows: () => leaveList(getView()),
  });
  const { nav, list } = createBreadcrumbs();
  view = { state, map, toolbar, crumbList: list, sidebar, tooltip: createTooltip() };

  const shell = element("div", "pr-view");
  shell.append(createHeader(data));
  const banner = createTruncationBanner(data, state.index.changedFiles.length);
  if (banner !== null) shell.append(banner);
  shell.append(toolbar.root, append(element("div", "crumb-row"), nav, createLegend()));
  shell.append(append(element("div", "pr-main"), map.container, sidebar.root), view.tooltip.root);
  root.replaceChildren(shell);
  document.title = `${data.pullRequest.owner}/${data.pullRequest.repo}#${data.pullRequest.number} · wtreef`;

  attachMapEvents(view);
  attachWindowEvents(view);
  const mounted = view;
  computeDiffUrls(data.pullRequest, state.index, data.tree.nodeCount).then(
    (urls) => {
      mounted.state.diffUrls = urls;
      mounted.state.listDirty = true;
      requestFrame(mounted);
    },
    (error: unknown) => {
      // Links keep pointing at the files tab, which is still the right page.
      console.error("wtreef: could not hash paths for diff anchors", error);
    },
  );
  requestFrame(view);
  return view;
}

function toolbarCallbacks(getView: () => View): ToolbarCallbacks {
  const update = (change: (filters: Filters) => Filters) => {
    const view = getView();
    applyFilters(view, change(view.state.filters));
  };
  return {
    onSizeMode: (mode) => update((filters) => ({ ...filters, sizeMode: mode })),
    onToggleStatus: (status) => update((filters) => ({ ...filters, hiddenStatuses: filters.hiddenStatuses ^ (1 << status) })),
    onToggleType: (key) => update((filters) => ({ ...filters, hiddenTypes: toggledSet(filters.hiddenTypes, key) })),
    onToggleUnchanged: () => update((filters) => ({ ...filters, showUnchanged: !filters.showUnchanged })),
    onToggleGenerated: () => update((filters) => ({ ...filters, showGenerated: !filters.showGenerated })),
    onInclude: (text) => update((filters) => ({ ...filters, include: parsePathPattern(text) })),
    onExclude: (text) => update((filters) => ({ ...filters, exclude: parsePathPattern(text) })),
    onReset: () => update((filters) => ({ ...DEFAULT_FILTERS, sizeMode: filters.sizeMode })),
  };
}

function toggledSet(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

function createState(data: PullRequestData, search: string): ViewState {
  const { tree } = data;
  const index = buildTreeIndex(tree);
  const palette = readChartPalette(readCssToken);
  const query = parseViewQuery(search, new Set(index.typeBuckets.map((bucket) => bucket.key)));
  const zoomNode = Math.max(0, findDirectoryByPath(tree, index, query.zoomPath));
  return {
    data,
    tree,
    index,
    diffUrls: [],
    filters: query.filters,
    zoomNode,
    weights: new Float64Array(tree.nodeCount),
    insideZoom: new Uint8Array(tree.nodeCount),
    layout: createLayout(tree.nodeCount),
    palette,
    styles: computeTileStyles(tree, index, palette),
    width: 0,
    height: 0,
    pixelRatio: window.devicePixelRatio || 1,
    pointerX: 0,
    pointerY: 0,
    pointerClientX: 0,
    pointerClientY: 0,
    pointerInside: false,
    hoveredNode: NO_NODE,
    hoverSource: HoverSource.none,
    weightsDirty: true,
    layoutDirty: true,
    baseDirty: true,
    pointerDirty: false,
    overlayDirty: true,
    controlsDirty: true,
    // Rewrite the URL once so ignored or invalid parameters disappear from it.
    urlDirty: true,
    listDirty: true,
    highlightDirty: true,
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
  const empty = element("div", "map-empty", "No files match these filters.");
  empty.hidden = true;
  container.append(base, overlay, empty);
  const baseContext = base.getContext("2d", { alpha: false });
  const overlayContext = overlay.getContext("2d", { alpha: true });
  assert(baseContext !== null, "canvas 2d context is available");
  assert(overlayContext !== null, "canvas 2d context is available");
  return { container, base, overlay, baseContext, overlayContext, empty };
}

function requestFrame(view: View): void {
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
    state.listDirty = true;
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
    const outlined = nearestLaidOutAncestor(state, state.hoveredNode);
    drawHighlight(view.map.overlayContext, state.layout, state.palette, outlined, state.pixelRatio);
    state.overlayDirty = false;
  }
  runDomUpdates(view);
}

function runDomUpdates(view: View): void {
  const { state } = view;
  if (state.controlsDirty) {
    syncToolbar(view.toolbar, state.filters);
    renderBreadcrumbs(view.crumbList, state.tree, state.zoomNode, state.data.pullRequest.repo, (node) => zoomTo(view, node));
    state.controlsDirty = false;
  }
  if (state.listDirty) {
    renderFileList(view.sidebar, fileListInput(state));
    state.listDirty = false;
    state.highlightDirty = true;
  }
  if (state.highlightDirty) {
    highlightRow(view.sidebar, state.hoveredNode, state.hoverSource === HoverSource.canvas);
    state.highlightDirty = false;
  }
  if (state.urlDirty) {
    const zoomPath = state.index.paths[state.zoomNode] ?? "";
    const query = serializeViewQuery({ filters: state.filters, zoomPath });
    history.replaceState(history.state, "", `${window.location.pathname}${query}`);
    state.urlDirty = false;
  }
}

function fileListInput(state: ViewState) {
  return {
    tree: state.tree,
    index: state.index,
    weights: state.weights,
    insideZoom: state.insideZoom,
    diffUrls: state.diffUrls,
    fallbackUrl: filesTabUrl(state.data.pullRequest),
    zoomPath: state.index.paths[state.zoomNode] ?? "",
  };
}

/** A hovered list row may point at a file too small to draw; outline the closest drawn folder instead. */
function nearestLaidOutAncestor(state: ViewState, node: number): number {
  let current = node;
  for (let depth = 0; current > 0 && depth < state.tree.nodeCount; depth++) {
    if (((state.layout.flags[current] ?? 0) & LayoutFlag.laidOut) !== 0) return current;
    current = state.tree.parents[current] ?? 0;
  }
  return NO_NODE;
}

function sceneOf(state: ViewState) {
  return {
    tree: state.tree,
    index: state.index,
    layout: state.layout,
    styles: state.styles,
    palette: state.palette,
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
  state.overlayDirty = true;
}

function updateCanvasHover(view: View): void {
  const { state, map } = view;
  if (state.hoverSource === HoverSource.list) return;
  const node = state.pointerInside
    ? hitTest(state.tree, state.index, state.layout, state.pointerX, state.pointerY)
    : NO_NODE;
  // Inside a folder chain, the chain's top owns the frame (and the outline); its end owns the details.
  const hovered = node === state.layout.rootNode || node === NO_NODE ? NO_NODE : chainTop(state.tree, state.layout, node);
  map.overlay.classList.toggle("is-clickable", isClickable(state, hovered));
  if (hovered === NO_NODE) {
    hideTooltip(view.tooltip);
  } else {
    const described = chainEnd(state.layout, hovered);
    if (view.tooltip.node !== described) fillTooltip(view.tooltip, described, describeNode(state.tree, state.index, described));
    moveTooltip(view.tooltip, state.pointerClientX, state.pointerClientY);
  }
  if (hovered === state.hoveredNode) return;
  state.hoveredNode = hovered;
  state.hoverSource = hovered === NO_NODE ? HoverSource.none : HoverSource.canvas;
  state.overlayDirty = true;
  state.highlightDirty = true;
}

function hoverFromList(view: View, node: number): void {
  const { state } = view;
  if (state.hoveredNode === node && state.hoverSource === HoverSource.list) return;
  state.hoveredNode = node;
  state.hoverSource = HoverSource.list;
  hideTooltip(view.tooltip);
  state.overlayDirty = true;
  state.highlightDirty = true;
  requestFrame(view);
}

function leaveList(view: View): void {
  const { state } = view;
  if (state.hoverSource !== HoverSource.list) return;
  state.hoveredNode = NO_NODE;
  state.hoverSource = HoverSource.none;
  state.overlayDirty = true;
  state.highlightDirty = true;
  requestFrame(view);
}

function isClickable(state: ViewState, node: number): boolean {
  if (node === NO_NODE) return false;
  if (isChangedFile(state.tree, node)) return true;
  return isDirectoryFrameHit(state.tree, state.layout, node);
}

/** Single entry point for filter changes: every filter feeds the weights, so any change reruns them. */
function applyFilters(view: View, next: Filters): void {
  const { state } = view;
  if (filtersEqual(state.filters, next)) return;
  state.filters = next;
  state.weightsDirty = true;
  state.controlsDirty = true;
  state.urlDirty = true;
  requestFrame(view);
}

function attachMapEvents(view: View): void {
  const { state, map } = view;
  map.overlay.addEventListener("pointermove", (event) => {
    state.pointerX = event.offsetX;
    state.pointerY = event.offsetY;
    state.pointerClientX = event.clientX;
    state.pointerClientY = event.clientY;
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
function activateNode(view: View, node: number): void {
  const { state } = view;
  if (node === NO_NODE) return;
  if (isChangedFile(state.tree, node)) {
    // Until the anchors are hashed (or if hashing failed), the files tab is the closest page.
    const anchored = state.diffUrls[node] ?? "";
    window.open(anchored === "" ? filesTabUrl(state.data.pullRequest) : anchored, "_blank", "noopener,noreferrer");
    return;
  }
  if (isDirectoryFrameHit(state.tree, state.layout, node)) zoomTo(view, chainEnd(state.layout, chainTop(state.tree, state.layout, node)));
}

function zoomTo(view: View, node: number): void {
  const { state } = view;
  assert(state.tree.kinds[node] === NodeKind.directory, "only directories can be zoomed into");
  if (node === state.zoomNode) return;
  state.zoomNode = node;
  state.hoveredNode = NO_NODE;
  state.hoverSource = HoverSource.none;
  state.weightsDirty = true;
  state.controlsDirty = true;
  state.urlDirty = true;
  state.highlightDirty = true;
  hideTooltip(view.tooltip);
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
    if (isTypingTarget(event.target)) return;
    if (event.key === "Escape") {
      zoomOut(view);
    } else if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      view.toolbar.include.input.focus();
      view.toolbar.include.input.select();
    }
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

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}
