// The pull request view controller. One state object; events only mutate
// it and set dirty flags, and a single requestAnimationFrame callback does
// the work in a fixed order. That batches pointer moves to one hit test
// per frame and keeps relayout to resize, filter, zoom and mode changes.
//
// Every file and folder also has secondary actions: right-click (or a long
// press, or the context menu key on a row) opens a menu, Alt-click and H
// hide. They all end in runNodeAction, so each action has one
// implementation whichever way it was asked for.

import { assert } from "./assert.ts";
import { NodeKind, type PullRequestData, type Tree } from "./decode.ts";
import { computeDiffUrls, filesTabUrl } from "./diff.ts";
import { type ContextMenu, createContextMenu, type MenuOpening, openContextMenu } from "./context-menu.ts";
import { type ControlTooltip, hideControlTooltip, installControlTooltip } from "./control-tooltip.ts";
import { createControls, type Controls, type ControlsCallbacks, syncControls } from "./controls.ts";
import { append, element } from "./dom.ts";
import { type FileView, withFolderExpanded } from "./file-tree.ts";
import { createFilterSection, type FilterSectionCallbacks, syncFilterSection } from "./filter-section.ts";
import {
  buildHideableNodeByPath,
  HIDDEN_NODES_MAX,
  isHideableNode,
  isInsideHiddenSubtree,
  nearestShownAncestor,
  NO_HIDDEN_NODES,
  withNodeHidden,
  withNodeShown,
} from "./hidden.ts";
import { hitTest, isDirectoryFrameHit, NO_NODE } from "./hit.ts";
import { chainEnd, chainTop, computeLayout, createLayout, type Layout, LayoutFlag } from "./layout.ts";
import { attachLongPress, isLongPressClick, longPressOpenedMenu } from "./long-press.ts";
import {
  buildTreeIndex,
  computeSubtreeMembership,
  computeWeights,
  type Filters,
  filtersEqual,
  findDirectoryByPath,
  isChangedFile,
  presentStatusMask,
  type TreeIndex,
  withDefaultCategoryFilters,
} from "./model.ts";
import { displayPath, NodeAction, nodeMenuItems } from "./node-actions.ts";
import { parsePathPattern } from "./pattern.ts";
import { altKeyLabel, currentPlatform } from "./platform.ts";
import { parseViewQuery, serializeViewQuery } from "./query.ts";
import { type ChartPalette, computeTileStyles, drawBase, drawHighlight, readChartPalette, type TileStyles } from "./render.ts";
import {
  type ChangedFilesInput,
  createSidebar,
  highlightRow,
  renderChangedFiles,
  rowNodeOf,
  type Sidebar,
  type SidebarCallbacks,
  syncFileViewChoice,
} from "./sidebar.ts";
import { createToast, runToastAction, showToast, type Toast, ToastTone } from "./toast.ts";
import { createTooltip, describeNode, fillTooltip, hideTooltip, moveTooltip, type Tooltip } from "./tooltip.ts";
import { describeHeaderTotals, sumShownChanges } from "./totals.ts";
import { createHeader, createTruncationBanner, type Header, syncHeaderTotals } from "./ui.ts";

/** Mirrors the narrow-screen breakpoint in style.css, where the sidebar stacks under the map. */
const NARROW_LAYOUT_QUERY = "(max-width: 860px)";

const HoverSource = { none: 0, canvas: 1, list: 2 } as const;
type HoverSource = (typeof HoverSource)[keyof typeof HoverSource];

export interface ViewState {
  readonly data: PullRequestData;
  readonly tree: Tree;
  readonly index: TreeIndex;
  /** "⌥" or "Alt", as hints name the hide modifier on this platform. */
  readonly altKey: string;
  /** Filled asynchronously after load; "" until then and for unchanged nodes. */
  diffUrls: readonly string[];
  filters: Filters;
  zoomNode: number;
  fileView: FileView;
  /** Folders closed in the Tree view, by node. In memory only: it outlives filter and zoom changes, not the page. */
  collapsedFolders: ReadonlySet<number>;
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
  /** Only filters change the header's totals: zoom and hover never do. */
  totalsDirty: boolean;
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
  readonly header: Header;
  readonly map: MapElements;
  readonly controls: Controls;
  readonly sidebar: Sidebar;
  readonly tooltip: Tooltip;
  readonly menu: ContextMenu;
  readonly toast: Toast;
  readonly controlTooltip: ControlTooltip;
}

export function mountPullRequestView(root: HTMLElement, data: PullRequestData, search: string): View {
  const state = createState(data, search);
  const map = createMapElements();
  // Control and sidebar callbacks need the view, which holds them; they
  // only run after mount, by which time `view` is assigned.
  let view: View | null = null;
  const getView = (): View => {
    assert(view !== null, "events fire only after mount");
    return view;
  };
  const controls = createControls(controlsCallbacks(getView));
  const filterSection = createFilterSection(state.tree, state.index, filterCallbacks(getView), !window.matchMedia(NARROW_LAYOUT_QUERY).matches);
  const sidebar = createSidebar(filterSection, state.tree, state.index, sidebarCallbacks(getView));
  const toast = createToast();
  const menu = createContextMenu();
  view = { state, header: createHeader(data), map, controls, sidebar, tooltip: createTooltip(), menu, toast, controlTooltip: installControlTooltip() };

  const shell = element("div", "pr-view");
  shell.append(view.header.root);
  const banner = createTruncationBanner(data, state.index.changedFiles.length);
  if (banner !== null) shell.append(banner);
  shell.append(controls.root);
  map.container.append(toast.root);
  shell.append(append(element("div", "pr-main"), map.container, sidebar.root), view.tooltip.root, view.controlTooltip.root, menu.root);
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

function updateFilters(getView: () => View, change: (filters: Filters) => Filters): void {
  const view = getView();
  applyFilters(view, change(view.state.filters));
}

function controlsCallbacks(getView: () => View): ControlsCallbacks {
  const update = (change: (filters: Filters) => Filters) => updateFilters(getView, change);
  return {
    onSizeMode: (mode) => update((filters) => ({ ...filters, sizeMode: mode })),
    onInclude: (text) => update((filters) => ({ ...filters, include: parsePathPattern(text) })),
    onExclude: (text) => update((filters) => ({ ...filters, exclude: parsePathPattern(text) })),
    onZoom: (node) => zoomTo(getView(), node),
  };
}

function filterCallbacks(getView: () => View): FilterSectionCallbacks {
  const update = (change: (filters: Filters) => Filters) => updateFilters(getView, change);
  return {
    onToggleStatus: (status) => update((filters) => ({ ...filters, hiddenStatuses: filters.hiddenStatuses ^ (1 << status) })),
    onToggleType: (key) => update((filters) => ({ ...filters, hiddenTypes: toggledSet(filters.hiddenTypes, key) })),
    onToggleUnchanged: () => update((filters) => ({ ...filters, showUnchanged: !filters.showUnchanged })),
    onToggleGenerated: () => update((filters) => ({ ...filters, showGenerated: !filters.showGenerated })),
    onShowHidden: (node) => showNode(getView(), node),
    onShowAllHidden: () => update((filters) => ({ ...filters, hiddenNodes: NO_HIDDEN_NODES })),
    onReset: () => update(withDefaultCategoryFilters),
  };
}

function sidebarCallbacks(getView: () => View): SidebarCallbacks {
  return {
    onHoverRow: (node) => hoverFromList(getView(), node),
    onLeaveRows: () => leaveList(getView()),
    onFileView: (fileView) => setFileView(getView(), fileView),
    onFolderExpanded: (top, end, expanded) => setFolderExpanded(getView(), top, end, expanded),
    onRowMenu: (node, opening) => openNodeMenu(getView(), node, opening),
    onHideRow: (node) => hideNode(getView(), node),
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
  const query = parseViewQuery(search, {
    typeKeys: new Set(index.typeBuckets.map((bucket) => bucket.key)),
    statusMask: presentStatusMask(index),
    nodeByPath: buildHideableNodeByPath(tree, index.paths),
  });
  // A link can zoom into a folder it also hides; the view opens on the deepest folder still shown.
  const zoomNode = nearestShownAncestor(tree, query.filters.hiddenNodes, Math.max(0, findDirectoryByPath(tree, index, query.zoomPath)));
  return {
    data,
    tree,
    index,
    altKey: altKeyLabel(currentPlatform()),
    diffUrls: [],
    filters: query.filters,
    zoomNode,
    fileView: query.fileView,
    collapsedFolders: new Set(),
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
    totalsDirty: true,
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
    drawHighlight(view.map.overlayContext, sceneOf(state), outlined, state.pixelRatio);
    state.overlayDirty = false;
  }
  runDomUpdates(view);
}

function runDomUpdates(view: View): void {
  const { state } = view;
  if (state.controlsDirty) {
    syncControls(view.controls, {
      filters: state.filters,
      tree: state.tree,
      zoomNode: state.zoomNode,
      repositoryName: state.data.pullRequest.repo,
    });
    syncFilterSection(view.sidebar.filter, state.filters);
    syncFileViewChoice(view.sidebar, state.fileView);
    state.controlsDirty = false;
  }
  if (state.totalsDirty) {
    assert(!state.weightsDirty, "totals are summed over the weights for the current filters");
    const shown = sumShownChanges(state.tree, state.index, state.weights);
    syncHeaderTotals(view.header, describeHeaderTotals(state.data.pullRequest, state.filters, shown));
    state.totalsDirty = false;
  }
  if (state.listDirty) {
    renderChangedFiles(view.sidebar, changedFilesInput(state));
    state.listDirty = false;
    state.highlightDirty = true;
  }
  if (state.highlightDirty) {
    highlightRow(view.sidebar, state.hoveredNode, state.hoverSource === HoverSource.canvas);
    state.highlightDirty = false;
  }
  if (state.urlDirty) {
    const zoomPath = state.index.paths[state.zoomNode] ?? "";
    const query = serializeViewQuery({ filters: state.filters, zoomPath, fileView: state.fileView }, state.index.paths);
    history.replaceState(history.state, "", `${window.location.pathname}${query}`);
    state.urlDirty = false;
  }
}

function changedFilesInput(state: ViewState): ChangedFilesInput {
  return {
    fileView: state.fileView,
    tree: state.tree,
    index: state.index,
    weights: state.weights,
    insideZoom: state.insideZoom,
    zoomNode: state.zoomNode,
    zoomPath: state.index.paths[state.zoomNode] ?? "",
    collapsedFolders: state.collapsedFolders,
    diffUrls: state.diffUrls,
    fallbackUrl: filesTabUrl(state.data.pullRequest),
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
  // CSSOM, not a style attribute: the CSP forbids inline styles but allows this.
  const cursor = isClickable(state, hovered) ? "pointer" : "default";
  if (map.overlay.style.cursor !== cursor) map.overlay.style.cursor = cursor;
  // The menu covers part of the map; a tooltip on top of it would hide what it says it acts on.
  if (hovered === NO_NODE || view.menu.isOpen) {
    hideTooltip(view.tooltip);
  } else {
    const described = chainEnd(state.layout, hovered);
    if (view.tooltip.node !== described) fillTooltip(view.tooltip, described, describeNode(state.tree, state.index, described, state.altKey));
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
  state.totalsDirty = true;
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
  attachMapActionEvents(view);
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

/**
 * Click opens a changed file's diff or zooms into a folder; Alt-click
 * hides; right-click or a long press opens the menu. A long press ends in
 * a click, which is swallowed.
 */
function attachMapActionEvents(view: View): void {
  const { state, map } = view;
  const press = attachLongPress(map.overlay, (point) => {
    const node = mapTargetAt(state, point.offsetX, point.offsetY);
    if (node !== NO_NODE) openNodeMenu(view, node, { clientX: point.clientX, clientY: point.clientY, byTouch: true });
  });
  map.overlay.addEventListener("click", (event) => {
    if (isLongPressClick(press)) return;
    const node = mapTargetAt(state, event.offsetX, event.offsetY);
    if (node === NO_NODE) return;
    if (event.altKey) {
      if (isHideableNode(state.tree, node)) hideNode(view, node);
    } else if (isChangedFile(state.tree, node)) {
      runNodeAction(view, node, NodeAction.openDiff);
    } else if (state.tree.kinds[node] === NodeKind.directory) {
      runNodeAction(view, node, NodeAction.zoom);
    }
  });
  map.overlay.addEventListener("contextmenu", (event) => {
    const node = mapTargetAt(state, event.offsetX, event.offsetY);
    // Rest tiles and the space around the map keep the browser's own menu.
    if (node === NO_NODE || nodeMenuItems(state.tree, node).length === 0) return;
    event.preventDefault();
    if (longPressOpenedMenu(press)) return;
    openNodeMenu(view, node, { clientX: event.clientX, clientY: event.clientY, byTouch: false });
  });
}

/**
 * The node a click at a canvas point acts on: the tile under it, or for a
 * folder frame the folder its header names (the end of its chain). The
 * zoomed folder's own padding acts on nothing.
 */
function mapTargetAt(state: ViewState, x: number, y: number): number {
  const node = hitTest(state.tree, state.index, state.layout, x, y);
  if (node === NO_NODE || node === state.layout.rootNode) return NO_NODE;
  if (!isDirectoryFrameHit(state.tree, state.layout, node)) return node;
  return chainEnd(state.layout, chainTop(state.tree, state.layout, node));
}

function openNodeMenu(view: View, node: number, opening: MenuOpening): void {
  const { state } = view;
  const items = nodeMenuItems(state.tree, node).map((item) => ({
    label: item.label,
    shortcut: item.shortcut,
    run: () => runNodeAction(view, node, item.action),
  }));
  if (items.length === 0) return;
  hideTooltip(view.tooltip);
  hideControlTooltip(view.controlTooltip);
  openContextMenu(view.menu, displayPath(state.tree, state.index.paths, node), items, opening);
}

function runNodeAction(view: View, node: number, action: NodeAction): void {
  const { state } = view;
  if (action === NodeAction.openDiff) {
    assert(isChangedFile(state.tree, node), "only changed files have a diff");
    // Until the anchors are hashed (or if hashing failed), the files tab is the closest page.
    const anchored = state.diffUrls[node] ?? "";
    window.open(anchored === "" ? filesTabUrl(state.data.pullRequest) : anchored, "_blank", "noopener,noreferrer");
  } else if (action === NodeAction.zoom) {
    zoomTo(view, node);
  } else if (action === NodeAction.hide) {
    hideNode(view, node);
  } else {
    copyPath(view, node);
  }
}

/** Hides `node` with everything below it, and offers to undo exactly that. */
function hideNode(view: View, node: number): void {
  const { state } = view;
  const { hiddenNodes } = state.filters;
  assert(isHideableNode(state.tree, node), "only nodes with a path can be hidden");
  // Input can arrive between a hide and the frame that redraws without it.
  if (isInsideHiddenSubtree(state.tree, hiddenNodes, node)) return;
  if (hiddenNodes.size >= HIDDEN_NODES_MAX) {
    const text = `Up to ${HIDDEN_NODES_MAX} files and folders can be hidden. Show some again first.`;
    showToast(view.toast, { text, path: "", tone: ToastTone.error, action: null });
    return;
  }
  applyFilters(view, { ...state.filters, hiddenNodes: withNodeHidden(hiddenNodes, state.tree, node) });
  const shownZoom = nearestShownAncestor(state.tree, state.filters.hiddenNodes, state.zoomNode);
  if (shownZoom !== state.zoomNode) zoomTo(view, shownZoom);
  clearHover(view);
  const path = displayPath(state.tree, state.index.paths, node);
  showToast(view.toast, { text: "Hidden", path, tone: ToastTone.info, action: { label: "Undo", run: () => showNode(view, node) } });
}

function showNode(view: View, node: number): void {
  const { state } = view;
  // Undo can come after Reset or the Hidden list already showed it again.
  if (!state.filters.hiddenNodes.has(node)) return;
  applyFilters(view, { ...state.filters, hiddenNodes: withNodeShown(state.filters.hiddenNodes, node) });
}

function copyPath(view: View, node: number): void {
  const path = view.state.index.paths[node] ?? "";
  assert(path !== "", "only nodes with a path have a menu");
  // The Clipboard API exists only on secure pages; the type says it is always there.
  const clipboard: Clipboard | undefined = navigator.clipboard;
  if (clipboard === undefined) {
    showToast(view.toast, { text: "Copying needs a secure (HTTPS) page.", path: "", tone: ToastTone.error, action: null });
    return;
  }
  clipboard.writeText(path).then(
    () => showToast(view.toast, { text: "Copied", path, tone: ToastTone.info, action: null }),
    (error: unknown) => {
      const reason = error instanceof Error && error.message !== "" ? error.message : "the browser refused";
      showToast(view.toast, { text: `Could not copy the path: ${reason}`, path: "", tone: ToastTone.error, action: null });
    },
  );
}

/** What was hovered may be gone: the canvas finds its new hover after the relayout, rows on the next pointer move. */
function clearHover(view: View): void {
  const { state } = view;
  state.hoveredNode = NO_NODE;
  state.hoverSource = HoverSource.none;
  state.pointerDirty = true;
  state.overlayDirty = true;
  state.highlightDirty = true;
  hideTooltip(view.tooltip);
  requestFrame(view);
}

function setFileView(view: View, fileView: FileView): void {
  const { state } = view;
  if (state.fileView === fileView) return;
  state.fileView = fileView;
  state.listDirty = true;
  state.controlsDirty = true;
  state.urlDirty = true;
  requestFrame(view);
}

/** `top` and `end` are the first and last folder of a Tree view row; see withFolderExpanded. */
function setFolderExpanded(view: View, top: number, end: number, expanded: boolean): void {
  const { state } = view;
  state.collapsedFolders = withFolderExpanded(state.collapsedFolders, state.tree, top, end, expanded);
  state.listDirty = true;
  requestFrame(view);
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
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    if (event.key === "Escape") {
      zoomOut(view);
    } else if (event.key === "/" && plain) {
      event.preventDefault();
      view.controls.include.input.focus();
      view.controls.include.input.select();
    } else if (event.key.toLowerCase() === "h" && plain) {
      const node = hideKeyTarget(view, event.target);
      if (node === NO_NODE) return;
      event.preventDefault();
      hideNode(view, node);
    } else if (event.key.toLowerCase() === "z" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
      // Undo is offered only while its toast is up; past that, the Hidden list shows things again.
      if (runToastAction(view.toast)) event.preventDefault();
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

/**
 * H acts on what is marked: the hovered tile (the folder its header names),
 * or the hovered or focused row, which marks itself through the same hover
 * state; failing that, the row that has focus.
 */
function hideKeyTarget(view: View, target: EventTarget | null): number {
  const { state } = view;
  let node = rowNodeOf(target);
  if (state.hoverSource === HoverSource.canvas && state.hoveredNode !== NO_NODE) node = chainEnd(state.layout, state.hoveredNode);
  if (state.hoverSource === HoverSource.list && state.hoveredNode !== NO_NODE) node = state.hoveredNode;
  if (node === NO_NODE || !isHideableNode(state.tree, node)) return NO_NODE;
  return node;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}
