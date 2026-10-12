// Canvas drawing. The base canvas holds frames, tiles and labels and is
// redrawn only when the layout, filters or palette change; the overlay
// canvas holds the hover outline, so hovering never touches the base.

import { assert } from "./assert.ts";
import { type DiffScale, diffColor, pickInk, parseHexColor, type Rgb, rgbToHex, rgbToOklab } from "./color.ts";
import { FileStatus, NodeKind, type Tree } from "./decode.ts";
import { formatChurnNonZero, formatCount } from "./format.ts";
import { LAYOUT, type Layout, LayoutFlag, NO_CHAIN } from "./layout.ts";
import { churnOf, isChangedFile, type TreeIndex } from "./model.ts";

export interface ChartPalette {
  readonly canvas: string;
  readonly frame: string;
  readonly frameLine: string;
  readonly frameText: string;
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
    frameLine: css("--frame-line"),
    frameText: css("--fg-3"),
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
  for (let node = 0; node < tree.nodeCount; node++) {
    const fill = tileFill(tree, index, palette, node);
    fills[node] = rgbToHex(fill);
    const isChanged = isChangedFile(tree, node) || (index.subtreeChangedFiles[node] ?? 0) > 0;
    inks[node] = isChanged ? rgbToHex(pickInk(fill, palette.labelInkLight, palette.labelInkDark)) : palette.contextText;
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
  readonly searchMatches: Uint8Array;
  readonly searchActive: boolean;
}

const LABEL = {
  paddingX: 4,
  nameSizePx: 11,
  numbersSizePx: 10,
  firstBaselineY: 12,
  secondBaselineY: 25,
  widthMin: 28,
  heightMin: 16,
  secondLineHeightMin: 30,
} as const;
const HEADER_BASELINE_Y = 12;
const HATCH_SPACING_PX = 6;
/**
 * Non-matching tiles keep their shape but fade toward the frame and lose
 * their labels (faded text stays half-legible depending on its ink, which
 * reads as noise). Folder names stay readable so the structure remains.
 */
const SEARCH_DIM_ALPHA = 0.2;
const SEARCH_DIM_HEADER_ALPHA = 0.5;

export function drawBase(context: CanvasRenderingContext2D, scene: Scene, pixelRatio: number): void {
  const { layout, tree } = scene;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.globalAlpha = 1;
  context.fillStyle = scene.palette.canvas;
  context.fillRect(0, 0, layout.width, layout.height);
  context.textBaseline = "alphabetic";
  for (let order = 0; order < layout.drawCount; order++) {
    const node = layout.drawOrder[order] ?? 0;
    if (node === layout.rootNode) continue;
    const dimmed = scene.searchActive && scene.searchMatches[node] === 0;
    const flags = layout.flags[node] ?? 0;
    context.globalAlpha = dimmed ? SEARCH_DIM_ALPHA : 1;
    if (tree.kinds[node] === NodeKind.directory && (flags & LayoutFlag.open) !== 0) {
      // A chained folder has no frame of its own: its chain top drew it.
      if ((flags & LayoutFlag.chained) !== 0) continue;
      drawFrame(context, scene, node);
      if ((flags & LayoutFlag.header) === 0) continue;
      context.globalAlpha = dimmed ? SEARCH_DIM_HEADER_ALPHA : 1;
      drawFrameHeader(context, scene, node);
    } else {
      drawTile(context, scene, node);
      if (!dimmed) drawTileLabel(context, scene, node);
    }
  }
  context.globalAlpha = 1;
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
  context.strokeStyle = palette.frameLine;
  context.lineWidth = 1;
  context.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
}

function drawFrameHeader(context: CanvasRenderingContext2D, scene: Scene, node: number): void {
  const { layout, palette } = scene;
  const x = layout.rects[node * 4] ?? 0;
  const y = layout.rects[node * 4 + 1] ?? 0;
  const width = layout.rects[node * 4 + 2] ?? 0;
  context.font = `${LABEL.nameSizePx}px ${palette.fontSans}`;
  context.fillStyle = palette.frameText;
  const label = fitText(context, chainLabel(scene, node), width - 2 * LABEL.paddingX);
  context.fillText(label, x + LABEL.paddingX, y + LAYOUT.padding + HEADER_BASELINE_Y);
}

/** "pages/blobs/components" for a chain of single-child folders; just the name otherwise. */
function chainLabel(scene: Scene, node: number): string {
  const { layout, tree } = scene;
  let label = tree.names[node] ?? "";
  let current = layout.chainChild[node] ?? NO_CHAIN;
  for (let depth = 0; current !== NO_CHAIN && depth < tree.nodeCount; depth++) {
    label += `/${tree.names[current] ?? ""}`;
    current = layout.chainChild[current] ?? NO_CHAIN;
  }
  return label;
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
  context.font = `${LABEL.nameSizePx}px ${scene.palette.fontSans}`;
  const textWidth = width - 2 * LABEL.paddingX;
  context.fillText(fitText(context, name, textWidth), x + LABEL.paddingX, y + LABEL.firstBaselineY);
  if (detail === "" || height < LABEL.secondLineHeightMin) return;
  context.font = `${LABEL.numbersSizePx}px ${scene.palette.fontMono}`;
  context.fillText(fitText(context, detail, textWidth), x + LABEL.paddingX, y + LABEL.secondBaselineY);
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

/** Longest prefix that fits, with an ellipsis; binary search keeps measureText calls logarithmic. */
function fitText(context: CanvasRenderingContext2D, text: string, widthMax: number): string {
  if (widthMax <= 0) return "";
  if (context.measureText(text).width <= widthMax) return text;
  if (context.measureText(ELLIPSIS).width > widthMax) return "";
  let fits = 0;
  let tooLong = text.length;
  while (tooLong - fits > 1) {
    const middle = (fits + tooLong) >>> 1;
    if (context.measureText(text.slice(0, middle) + ELLIPSIS).width <= widthMax) {
      fits = middle;
    } else {
      tooLong = middle;
    }
  }
  return fits === 0 ? "" : text.slice(0, fits).trimEnd() + ELLIPSIS;
}

/** Clears the overlay and outlines `node` when it is laid out. */
export function drawHighlight(
  context: CanvasRenderingContext2D,
  layout: Layout,
  palette: ChartPalette,
  node: number,
  pixelRatio: number,
): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  if (node < 0) return;
  assert(node < layout.flags.length, "highlighted node must exist");
  if (((layout.flags[node] ?? 0) & LayoutFlag.laidOut) === 0) return;
  if (node === layout.rootNode) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
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
