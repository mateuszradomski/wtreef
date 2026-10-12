// Methodology: conversions are checked by round trip and against known
// reference values (white, black, WCAG's 21:1); the diff scale is checked at
// its poles, midpoint and intensity extremes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  churnIntensity,
  contrastRatio,
  diffColor,
  type DiffScale,
  parseHexColor,
  pickInk,
  rgbToHex,
  rgbToOklab,
  oklabToRgb,
} from "./color.ts";

const WHITE = parseHexColor("#ffffff");
const BLACK = parseHexColor("#000000");

test("parses and formats hex colors", () => {
  assert.deepEqual(parseHexColor(" #1FaB80 "), { red: 31, green: 171, blue: 128 });
  assert.equal(rgbToHex(parseHexColor("#0b0b0c")), "#0b0b0c");
  assert.throws(() => parseHexColor("red"), /#rrggbb/);
  assert.throws(() => parseHexColor("#fff"), /#rrggbb/);
});

test("OKLab round-trips sRGB", () => {
  for (const hex of ["#000000", "#ffffff", "#1fab80", "#c8363f", "#7c7c84", "#c5ac98"]) {
    assert.equal(rgbToHex(oklabToRgb(rgbToOklab(parseHexColor(hex)))), hex);
  }
  const white = rgbToOklab(WHITE);
  assert.ok(Math.abs(white.lightness - 1) < 1e-6);
  assert.ok(Math.abs(white.a) < 1e-6 && Math.abs(white.b) < 1e-6);
});

test("computes WCAG contrast and picks the better ink", () => {
  assert.ok(Math.abs(contrastRatio(WHITE, BLACK) - 21) < 1e-9);
  assert.equal(contrastRatio(WHITE, WHITE), 1);
  assert.equal(pickInk(parseHexColor("#1fab80"), WHITE, BLACK), BLACK);
  assert.equal(pickInk(parseHexColor("#3b3f66"), WHITE, BLACK), WHITE);
});

const SCALE: DiffScale = {
  base: rgbToOklab(parseHexColor("#1c1c20")),
  deletions: rgbToOklab(parseHexColor("#c8363f")),
  mixed: rgbToOklab(parseHexColor("#7c7c84")),
  additions: rgbToOklab(parseHexColor("#1fab80")),
};

test("diff colors hit the poles at full churn and sit near the base at low churn", () => {
  assert.equal(rgbToHex(diffColor(SCALE, 100, 0, 100)), "#1fab80");
  assert.equal(rgbToHex(diffColor(SCALE, 0, 100, 100)), "#c8363f");
  assert.equal(rgbToHex(diffColor(SCALE, 50, 50, 100)), "#7c7c84");
  const faint = rgbToOklab(diffColor(SCALE, 1, 0, 10000));
  const strong = rgbToOklab(diffColor(SCALE, 5000, 0, 10000));
  assert.ok(faint.lightness < strong.lightness, "more churn reads brighter on the dark base");
  assert.ok(faint.lightness > SCALE.base.lightness, "even one line stands apart from unchanged tiles");
});

test("churn intensity is logarithmic and bounded", () => {
  assert.equal(churnIntensity(0, 100), 0);
  assert.equal(churnIntensity(100, 100), 1);
  assert.equal(churnIntensity(500, 100), 1);
  assert.equal(churnIntensity(5, 0), 1);
  assert.ok(churnIntensity(10, 10000) > 0.25, "small changes are not crushed to nothing");
});
