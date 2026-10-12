// Methodology: draw the real fixture into a recording stand-in for the
// canvas 2D context, then check what was painted where. Folder headers must
// be 10px type inside their 12px band in the quiet ink, with no strip
// painted behind them. Highlighting a folder must outline the whole frame of
// its chain and repaint the header in the bright ink; highlighting a file
// outlines only the tile.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePullRequestData, NodeKind } from "./decode.ts";
import { chainTop, computeLayout, createLayout, LAYOUT, type Layout, LayoutFlag } from "./layout.ts";
import { buildTreeIndex, computeWeights, DEFAULT_FILTERS, isChangedFile, SizeMode } from "./model.ts";
import { computeTileStyles, drawBase, drawHighlight, readChartPalette, type Scene } from "./render.ts";
import { loadFixtureJson, REAL_FIXTURE } from "./test-support.ts";

interface Painted {
  readonly operation: "fillRect" | "strokeRect" | "fillText";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly style: string;
  readonly font: string;
  readonly text: string;
}

/** Records rectangles and text; everything else a draw call needs is a no-op. Text is 6px per character. */
class RecordingContext {
  fillStyle = "";
  strokeStyle = "";
  font = "";
  lineWidth = 1;
  textBaseline = "alphabetic";
  readonly canvas = { width: 1280, height: 800 };
  readonly painted: Painted[] = [];
  fillRect(x: number, y: number, width: number, height: number): void {
    this.painted.push({ operation: "fillRect", x, y, width, height, style: this.fillStyle, font: "", text: "" });
  }
  strokeRect(x: number, y: number, width: number, height: number): void {
    this.painted.push({ operation: "strokeRect", x, y, width, height, style: this.strokeStyle, font: "", text: "" });
  }
  fillText(text: string, x: number, y: number): void {
    this.painted.push({ operation: "fillText", x, y, width: 0, height: 0, style: this.fillStyle, font: this.font, text });
  }
  measureText(text: string): { width: number } {
    return { width: text.length * 6 };
  }
  setTransform(): void {}
  clearRect(): void {
    this.painted.length = 0;
  }
  save(): void {}
  restore(): void {}
  beginPath(): void {}
  rect(): void {}
  clip(): void {}
  moveTo(): void {}
  lineTo(): void {}
  stroke(): void {}
}

const TOKENS: Readonly<Record<string, string>> = {
  "--fg": "#eeeeee",
  "--fg-3": "#808080",
  "--frame": "#111111",
  "--hover-outline": "#ffffff",
  "--font-sans": "sans",
  "--font-mono": "mono",
};

function setup(): { scene: Scene; context: RecordingContext; drawing: CanvasRenderingContext2D } {
  const tree = decodePullRequestData(loadFixtureJson(REAL_FIXTURE)).tree;
  const index = buildTreeIndex(tree);
  const weights = new Float64Array(tree.nodeCount);
  computeWeights(tree, index, { ...DEFAULT_FILTERS, sizeMode: SizeMode.churn }, weights);
  const layout = createLayout(tree.nodeCount);
  computeLayout(tree, index, weights, 0, 1280, 800, layout);
  const palette = readChartPalette((name) => TOKENS[name] ?? "#202020");
  const scene: Scene = { tree, index, layout, styles: computeTileStyles(tree, index, palette), palette };
  const context = new RecordingContext();
  return { scene, context, drawing: context as unknown as CanvasRenderingContext2D };
}

function rectOf(layout: Layout, node: number): { x: number; y: number; width: number; height: number } {
  const offset = node * 4;
  return { x: layout.rects[offset]!, y: layout.rects[offset + 1]!, width: layout.rects[offset + 2]!, height: layout.rects[offset + 3]! };
}

function headedFrames(scene: Scene): number[] {
  const frames: number[] = [];
  for (let node = 0; node < scene.tree.nodeCount; node++) {
    if (((scene.layout.flags[node] ?? 0) & LayoutFlag.header) !== 0) frames.push(node);
  }
  return frames;
}

test("folder headers are 10px quiet text inside a 12px band, with no strip behind them", () => {
  const { scene, context, drawing } = setup();
  drawBase(drawing, scene, 1);
  const frames = headedFrames(scene);
  assert.ok(frames.length > 0);
  const headerTexts = context.painted.filter((paint) => paint.operation === "fillText" && paint.font === "10px sans");
  assert.equal(headerTexts.length, frames.length, "one label per headed frame");
  for (const node of frames) {
    const frame = rectOf(scene.layout, node);
    const bandTop = frame.y + LAYOUT.padding;
    const label = headerTexts.find((paint) => paint.x > frame.x && paint.x < frame.x + 8 && paint.y > bandTop && paint.y <= bandTop + LAYOUT.headerHeight);
    assert.ok(label !== undefined, `frame ${node} has a label in its band`);
    assert.equal(label.style, scene.palette.frameText);
  }
  const strips = context.painted.filter((paint) => paint.operation === "fillRect" && paint.height === LAYOUT.headerHeight);
  assert.deepEqual(strips, [], "header text sits on the frame background");
});

test("highlighting a folder outlines its chain's whole frame and brightens its header", () => {
  const { scene, context, drawing } = setup();
  const { tree, layout } = scene;
  const isChainedUnderHeader = (node: number): boolean =>
    ((layout.flags[node] ?? 0) & LayoutFlag.chained) !== 0 &&
    ((layout.flags[chainTop(tree, layout, node)] ?? 0) & LayoutFlag.header) !== 0;
  const chained = [...layout.drawOrder.subarray(0, layout.drawCount)].find(isChainedUnderHeader);
  assert.ok(chained !== undefined, "the l2beat PR has a headed folder chain at this size");
  const top = chainTop(tree, layout, chained);
  drawHighlight(drawing, scene, chained, 1);
  const frame = rectOf(layout, top);
  const outlines = context.painted.filter((paint) => paint.operation === "strokeRect");
  assert.deepEqual(
    outlines.map(({ x, y, width, height, style }) => ({ x, y, width, height, style })),
    [{ x: frame.x + 0.5, y: frame.y + 0.5, width: frame.width - 1, height: frame.height - 1, style: scene.palette.hoverOutline }],
  );
  const texts = context.painted.filter((paint) => paint.operation === "fillText");
  assert.equal(texts.length, 1);
  assert.equal(texts[0]?.style, scene.palette.frameTextHover);
  assert.ok(texts[0]?.text.includes("/"), "a chain's header names every folder in it");
});

test("highlighting a file outlines only its tile, and the root is never highlighted", () => {
  const { scene, context, drawing } = setup();
  const { tree, layout } = scene;
  const file = [...layout.drawOrder.subarray(0, layout.drawCount)].find((node) => isChangedFile(tree, node));
  assert.ok(file !== undefined && tree.kinds[file] === NodeKind.file);
  drawHighlight(drawing, scene, file, 1);
  const tile = rectOf(layout, file);
  assert.deepEqual(
    context.painted.map(({ operation, x, y }) => ({ operation, x, y })),
    [{ operation: "strokeRect", x: tile.x + 1, y: tile.y + 1 }],
  );
  drawHighlight(drawing, scene, layout.rootNode, 1);
  assert.deepEqual(context.painted, []);
});
