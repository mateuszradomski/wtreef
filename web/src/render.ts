// Canvas drawing. The base canvas holds frames, tiles and labels and is
// redrawn only when the layout, filters or palette change; the overlay
// canvas holds the hover outline, so hovering never touches the base.

import { assert } from "./assert.ts";
import { type DiffScale, diffColor, pickInk, parseHexColor, type Rgb, rgbToHex, rgbToOklab } from "./color.ts";
import { FileStatus, NodeKind, type Tree } from "./decode.ts";
import { formatChurnNonZero, formatCount } from "./format.ts";
import { chainEnd, chainTop, LAYOUT, type Layout, LayoutFlag } from "./layout.ts";
import { churnOf, isChangedFile, type TreeIndex } from "./model.ts";

export interface ChartPalette {
  readonly canvas: string;
  readonly frame: string;
  readonly frameText: string;
  readonly frameEmphasis: string;
  readonly frameTextHover: string;
  readonly contextText: string;
  readonly tileFile: Rgb;
  readonly tileCollapsed: Rgb;
  readonly tileRest: Rgb;
  readonly tileRestHatch: string;
  readonly tileRenamed: Rgb;
  readonly labelInkLight: Rgb;
  readonly labelInkDark: Rgb;
  readonly hoverOutline: string;
  readonly diffScale: DiffScale;
  readonly fontSans: string;
  readonly fontMono: string;
}

/** Reads chart colors from CSS custom properties, the single source of truth for both themes. */
export function readChartPalette(readToken: (name: string) => string): ChartPalette {
  const color = (name: string) => parseHexColor(readToken(name));
  const css = (name: string) => rgbToHex(color(name));
  const tileFile = color("--tile-file");
  return {
    canvas: css("--bg"),
    frame: css("--frame"),
    frameText: css("--fg-3"),
    frameEmphasis: css("--fg-2"),
    frameTextHover: css("--fg"),
    contextText: css("--fg-3"),
    tileFile,
    tileCollapsed: color("--tile-collapsed"),
    tileRest: color("--tile-rest"),
    tileRestHatch: css("--tile-rest-hatch"),
    tileRenamed: color("--tile-renamed"),
    labelInkLight: color("--label-ink-light"),
    labelInkDark: color("--label-ink-dark"),
    hoverOutline: css("--hover-outline"),
    diffScale: {
      base: rgbToOklab(tileFile),
      deletions: rgbToOklab(color("--diff-delete")),
      mixed: rgbToOklab(color("--diff-mixed")),
      additions: rgbToOklab(color("--diff-add")),
    },
    fontSans: readToken("--font-sans").trim(),
    fontMono: readToken("--font-mono").trim(),
  };
}

/** Per-node fill and label ink, computed once per palette rather than per draw. */
export interface TileStyles {
  readonly fills: string[];
  readonly inks: string[];
}

export function computeTileStyles(tree: Tree, index: TreeIndex, palette: ChartPalette): TileStyles {
  const fills: string[] = new Array<string>(tree.nodeCount);
  const inks: string[] = new Array<string>(tree.nodeCount);
  // Most tiles share a palette color: the same object, converted once.
  const hexByColor = new Map<Rgb, string>();
  const hexOf = (color: Rgb): string => {
    let hex = hexByColor.get(color);
    if (hex === undefined) {
      hex = rgbToHex(color);
      hexByColor.set(color, hex);
    }
    return hex;
  };
  for (let node = 0; node < tree.nodeCount; node++) {
    const fill = tileFill(tree, index, palette, node);
    fills[node] = hexOf(fill);
    const isChanged = isChangedFile(tree, node) || (index.subtreeChangedFiles[node] ?? 0) > 0;
    inks[node] = isChanged ? hexOf(pickInk(fill, palette.labelInkLight, palette.labelInkDark)) : palette.contextText;
  }
  return { fills, inks };
}

function tileFill(tree: Tree, index: TreeIndex, palette: ChartPalette, node: number): Rgb {
  const kind = tree.kinds[node];
  if (kind === NodeKind.collapsedDirectory) return palette.tileCollapsed;
  if (kind === NodeKind.rest) return palette.tileRest;
  if (kind === NodeKind.directory) {
    // Only visible when the frame is too small to open: summarize its changes.
    if ((index.subtreeChangedFiles[node] ?? 0) === 0) return palette.tileCollapsed;
    const additions = index.subtreeAdditions[node] ?? 0;
    const deletions = index.subtreeDeletions[node] ?? 0;
    return diffColor(palette.diffScale, additions, deletions, Math.max(index.churnMax, additions + deletions));
  }
  if (!isChangedFile(tree, node)) return palette.tileFile;
  if (tree.statuses[node] === FileStatus.renamed && churnOf(tree, node) === 0) return palette.tileRenamed;
  return diffColor(palette.diffScale, tree.additions[node] ?? 0, tree.deletions[node] ?? 0, index.churnMax);
}

export interface Scene {
  readonly tree: Tree;
  readonly index: TreeIndex;
  readonly layout: Layout;
  readonly styles: TileStyles;
  readonly palette: ChartPalette;
}

const LABEL = {
  paddingX: 4,
  headerSizePx: 10,
  nameSizePx: 11,
  numbersSizePx: 10,
  firstBaselineY: 14,
  secondBaselineY: 27,
  widthMin: 28,
  heightMin: 18,
  secondLineHeightMin: 32,
} as const;
/** Compact folder labels fit inside the 12px band. */
const HEADER_BASELINE_Y = 9;
const HATCH_SPACING_PX = 10;

export function drawBase(context: CanvasRenderingContext2D, scene: Scene, pixelRatio: number): void {
  const { layout, tree } = scene;
  forgetFont(context);
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.fillStyle = scene.palette.canvas;
  context.fillRect(0, 0, layout.width, layout.height);
  context.textBaseline = "alphabetic";
  for (let order = 0; order < layout.drawCount; order++) {
    const node = layout.drawOrder[order] ?? 0;
    if (node === layout.rootNode) continue;
    const flags = layout.flags[node] ?? 0;
    if (tree.kinds[node] === NodeKind.directory && (flags & LayoutFlag.open) !== 0) {
      // A chained folder has no frame of its own: its chain top drew it.
      if ((flags & LayoutFlag.chained) !== 0) continue;
      drawFrame(context, scene, node);
      if ((flags & LayoutFlag.header) !== 0) drawFrameHeader(context, scene, node, scene.palette.frameText);
    } else {
      drawTile(context, scene, node);
      drawTileLabel(context, scene, node);
    }
  }
}

function drawFrame(context: CanvasRenderingContext2D, scene: Scene, node: number): void {
  const { layout, palette } = scene;
  const offset = node * 4;
  const x = layout.rects[offset] ?? 0;
  const y = layout.rects[offset + 1] ?? 0;
  const width = layout.rects[offset + 2] ?? 0;
  const height = layout.rects[offset + 3] ?? 0;
  context.fillStyle = palette.frame;
  context.fillRect(x, y, width, height);
}

/** Header text sits on the frame's own background: no strip, so nesting reads as indentation, not as stacked bars. */
function drawFrameHeader(context: CanvasRenderingContext2D, scene: Scene, node: number, color: string): void {
  const { layout, palette } = scene;
  const x = layout.rects[node * 4] ?? 0;
  const y = layout.rects[node * 4 + 1] ?? 0;
  const width = layout.rects[node * 4 + 2] ?? 0;
  const font = `${LABEL.headerSizePx}px ${palette.fontSans}`;
  context.fillStyle = color;
  const available = width - 2 * LABEL.paddingX;
  const path = folderPath(scene, node);
  const baseline = y + LAYOUT.padding + HEADER_BASELINE_Y;
  const hovered = color === palette.frameTextHover;
  const label = fitFolderPath(context, font, path, available);
  const split = label.lastIndexOf("/") + 1;
  const prefix = label.slice(0, split);
  useFont(context, font);
  if (prefix !== "") context.fillText(prefix, x + LABEL.paddingX, baseline);
  const prefixWidth = textWidth(context, font, prefix);
  context.fillStyle = hovered ? color : palette.frameEmphasis;
  context.fillText(label.slice(split), x + LABEL.paddingX + prefixWidth, baseline);
}

/** Paths replace the ancestor labels omitted from the map; zoom breadcrumbs supply the prefix. */
function folderPath(scene: Scene, node: number): string {
  const path = scene.index.paths[chainEnd(scene.layout, node)] ?? "";
  const root = scene.index.paths[scene.layout.rootNode] ?? "";
  return root === "" ? path : path.slice(root.length + 1);
}

/** Keep the nearest folders visible when a full path does not fit. */
function fitFolderPath(context: CanvasRenderingContext2D, font: string, path: string, width: number): string {
  if (textWidth(context, font, path) <= width) return path;
  const parts = path.split("/");
  while (parts.length > 1) {
    parts.shift();
    const shortened = `…/${parts.join("/")}`;
    if (textWidth(context, font, shortened) <= width) return shortened;
  }
  return fitText(context, font, `…/${parts[0] ?? ""}`, width);
}

function drawTile(context: CanvasRenderingContext2D, scene: Scene, node: number): void {
  const { layout, tree } = scene;
  const offset = node * 4;
  const x = layout.rects[offset] ?? 0;
  const y = layout.rects[offset + 1] ?? 0;
  const width = layout.rects[offset + 2] ?? 0;
  const height = layout.rects[offset + 3] ?? 0;
  context.fillStyle = scene.styles.fills[node] ?? scene.palette.canvas;
  context.fillRect(x, y, width, height);
  if (tree.kinds[node] === NodeKind.rest) drawHatch(context, scene.palette.tileRestHatch, x, y, width, height);
}

function drawTileLabel(context: CanvasRenderingContext2D, scene: Scene, node: number): void {
  const { layout } = scene;
  const offset = node * 4;
  const x = layout.rects[offset] ?? 0;
  const y = layout.rects[offset + 1] ?? 0;
  const width = layout.rects[offset + 2] ?? 0;
  const height = layout.rects[offset + 3] ?? 0;
  if (width < LABEL.widthMin || height < LABEL.heightMin) return;
  const [name, detail] = tileLabelLines(scene, node);
  context.fillStyle = scene.styles.inks[node] ?? scene.palette.contextText;
  const available = width - 2 * LABEL.paddingX;
  const nameFont = `${LABEL.nameSizePx}px ${scene.palette.fontSans}`;
  const fittedName = fitText(context, nameFont, name, available);
  useFont(context, nameFont);
  context.fillText(fittedName, x + LABEL.paddingX, y + LABEL.firstBaselineY);
  if (detail === "" || height < LABEL.secondLineHeightMin) return;
  const detailFont = `${LABEL.numbersSizePx}px ${scene.palette.fontMono}`;
  const fittedDetail = fitText(context, detailFont, detail, available);
  useFont(context, detailFont);
  context.fillText(fittedDetail, x + LABEL.paddingX, y + LABEL.secondBaselineY);
}

/** First line names the tile; the second carries its numbers. */
function tileLabelLines(scene: Scene, node: number): readonly [string, string] {
  const { tree, index } = scene;
  const kind = tree.kinds[node];
  const fileCount = index.subtreeFiles[node] ?? 0;
  if (kind === NodeKind.rest) return [`${formatCount(fileCount)} more files`, ""];
  const name = tree.names[node] ?? "";
  if (kind === NodeKind.collapsedDirectory) return [`${name}/`, `${formatCount(fileCount)} files`];
  if (kind === NodeKind.directory) {
    return [`${name}/`, formatChurnNonZero(index.subtreeAdditions[node] ?? 0, index.subtreeDeletions[node] ?? 0)];
  }
  if (!isChangedFile(tree, node)) return [name, ""];
  return [name, formatChurnNonZero(tree.additions[node] ?? 0, tree.deletions[node] ?? 0)];
}

/** 45° hatch marks rest nodes as "everything else here", distinct from any single file. */
function drawHatch(context: CanvasRenderingContext2D, color: string, x: number, y: number, width: number, height: number): void {
  context.save();
  context.beginPath();
  context.rect(x, y, width, height);
  context.clip();
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.beginPath();
  const lineCount = Math.ceil((width + height) / HATCH_SPACING_PX);
  for (let line = 0; line <= lineCount; line++) {
    const start = x + line * HATCH_SPACING_PX;
    context.moveTo(start, y);
    context.lineTo(start - height, y + height);
  }
  context.stroke();
  context.restore();
}

const ELLIPSIS = "…";

/**
 * Per context: the font last set, and text widths by font. Setting a font
 * parses it, and a tile keeps its label from one redraw to the next, so
 * both are done once rather than per label per frame. The fonts are system
 * fonts, so no font arriving later changes a width.
 */
interface TextState {
  font: string;
  readonly widthsByFont: Map<string, Map<string, number>>;
}

const TEXT_STATES = new WeakMap<CanvasRenderingContext2D, TextState>();
/** Labels times the prefixes fitText tries for them; a font's widths start over past this. */
const TEXT_WIDTHS_MAX = 50_000;

function textState(context: CanvasRenderingContext2D): TextState {
  let state = TEXT_STATES.get(context);
  if (state === undefined) {
    state = { font: "", widthsByFont: new Map() };
    TEXT_STATES.set(context, state);
  }
  return state;
}

/** Resizing a canvas resets its font, so each draw starts from not knowing it. */
function forgetFont(context: CanvasRenderingContext2D): void {
  textState(context).font = "";
}

function useFont(context: CanvasRenderingContext2D, font: string): void {
  const state = textState(context);
  if (state.font === font) return;
  context.font = font;
  state.font = font;
}

function textWidth(context: CanvasRenderingContext2D, font: string, text: string): number {
  const { widthsByFont } = textState(context);
  let widths = widthsByFont.get(font);
  if (widths === undefined) {
    widths = new Map();
    widthsByFont.set(font, widths);
  }
  let width = widths.get(text);
  if (width === undefined) {
    useFont(context, font);
    width = context.measureText(text).width;
    if (widths.size >= TEXT_WIDTHS_MAX) widths.clear();
    widths.set(text, width);
  }
  return width;
}

/** Longest prefix that fits, with an ellipsis; binary search keeps measurements logarithmic. */
function fitText(context: CanvasRenderingContext2D, font: string, text: string, widthMax: number): string {
  if (widthMax <= 0) return "";
  if (textWidth(context, font, text) <= widthMax) return text;
  if (textWidth(context, font, ELLIPSIS) > widthMax) return "";
  let fits = 0;
  let tooLong = text.length;
  while (tooLong - fits > 1) {
    const middle = (fits + tooLong) >>> 1;
    if (textWidth(context, font, text.slice(0, middle) + ELLIPSIS) <= widthMax) {
      fits = middle;
    } else {
      tooLong = middle;
    }
  }
  return fits === 0 ? "" : text.slice(0, fits).trimEnd() + ELLIPSIS;
}

/**
 * Clears the overlay and marks `node` when it is laid out. An open folder
 * is marked as a whole: its chain's frame is outlined and its header
 * brightened, because the frame (header and padding) is what a click zooms.
 */
export function drawHighlight(context: CanvasRenderingContext2D, scene: Scene, node: number, pixelRatio: number): void {
  const { layout, tree } = scene;
  forgetFont(context);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  if (node < 0) return;
  assert(node < layout.flags.length, "highlighted node must exist");
  if (((layout.flags[node] ?? 0) & LayoutFlag.laidOut) === 0) return;
  if (node === layout.rootNode) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  const isOpenFolder = tree.kinds[node] === NodeKind.directory && ((layout.flags[node] ?? 0) & LayoutFlag.open) !== 0;
  if (isOpenFolder) {
    drawFolderHighlight(context, scene, chainTop(tree, layout, node));
  } else {
    drawTileHighlight(context, scene, node);
  }
}

function drawTileHighlight(context: CanvasRenderingContext2D, scene: Scene, node: number): void {
  const { layout, palette } = scene;
  const offset = node * 4;
  context.strokeStyle = palette.hoverOutline;
  context.lineWidth = 2;
  context.strokeRect(
    (layout.rects[offset] ?? 0) + 1,
    (layout.rects[offset + 1] ?? 0) + 1,
    Math.max(0, (layout.rects[offset + 2] ?? 0) - 2),
    Math.max(0, (layout.rects[offset + 3] ?? 0) - 2),
  );
}

/** A fine outline makes the whole folder target clear without covering its tiles. */
function drawFolderHighlight(context: CanvasRenderingContext2D, scene: Scene, top: number): void {
  const { layout, palette } = scene;
  assert(((layout.flags[top] ?? 0) & LayoutFlag.chained) === 0, "a chain is drawn by its top");
  const offset = top * 4;
  const x = layout.rects[offset] ?? 0;
  const y = layout.rects[offset + 1] ?? 0;
  const width = layout.rects[offset + 2] ?? 0;
  const height = layout.rects[offset + 3] ?? 0;
  if (((layout.flags[top] ?? 0) & LayoutFlag.header) !== 0) {
    // Covers the quiet label underneath, so the bright one is not blended with it.
    context.fillStyle = palette.frame;
    context.fillRect(x + 1, y + LAYOUT.padding, Math.max(0, width - 2), LAYOUT.headerHeight);
    drawFrameHeader(context, scene, top, palette.frameTextHover);
  }
  context.strokeStyle = palette.hoverOutline;
  context.lineWidth = 1;
  context.strokeRect(x + 0.5, y + 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
}
