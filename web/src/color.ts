// Color math for the canvas. Tile colors are mixed in OKLab so that equal
// steps look equal, then converted back to sRGB once per tile per draw.

import { assert } from "./assert.ts";

export interface Rgb {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

export interface Oklab {
  readonly lightness: number;
  readonly a: number;
  readonly b: number;
}

/** Every changed file sits at least this far from the unchanged tile color, so a one-line change is still visible. */
export const DIFF_INTENSITY_FLOOR = 0.35;

const HEX_COLOR_PATTERN = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

export function parseHexColor(text: string): Rgb {
  const match = HEX_COLOR_PATTERN.exec(text.trim());
  assert(match !== null, `expected a #rrggbb color, got "${text}"`);
  return {
    red: Number.parseInt(match[1] ?? "", 16),
    green: Number.parseInt(match[2] ?? "", 16),
    blue: Number.parseInt(match[3] ?? "", 16),
  };
}

export function rgbToHex(color: Rgb): string {
  const hex = (channel: number) => Math.round(channel).toString(16).padStart(2, "0");
  return `#${hex(color.red)}${hex(color.green)}${hex(color.blue)}`;
}

function decodeSrgb(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function encodeSrgb(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear));
  const value = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(value * 255);
}

/** Björn Ottosson's OKLab, from linear sRGB. */
export function rgbToOklab(color: Rgb): Oklab {
  const red = decodeSrgb(color.red);
  const green = decodeSrgb(color.green);
  const blue = decodeSrgb(color.blue);
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return {
    lightness: 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    a: 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    b: 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  };
}

export function oklabToRgb(color: Oklab): Rgb {
  const long = (color.lightness + 0.3963377774 * color.a + 0.2158037573 * color.b) ** 3;
  const medium = (color.lightness - 0.1055613458 * color.a - 0.0638541728 * color.b) ** 3;
  const short = (color.lightness - 0.0894841775 * color.a - 1.291485548 * color.b) ** 3;
  return {
    red: encodeSrgb(4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short),
    green: encodeSrgb(-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short),
    blue: encodeSrgb(-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short),
  };
}

export function mixOklab(from: Oklab, to: Oklab, amount: number): Oklab {
  assert(amount >= 0 && amount <= 1, "mix amount must be within [0, 1]");
  return {
    lightness: from.lightness + (to.lightness - from.lightness) * amount,
    a: from.a + (to.a - from.a) * amount,
    b: from.b + (to.b - from.b) * amount,
  };
}

function relativeLuminance(color: Rgb): number {
  return 0.2126 * decodeSrgb(color.red) + 0.7152 * decodeSrgb(color.green) + 0.0722 * decodeSrgb(color.blue);
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrastRatio(first: Rgb, second: Rgb): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

/** The ink with the higher contrast against `background`. */
export function pickInk(background: Rgb, light: Rgb, dark: Rgb): Rgb {
  return contrastRatio(background, light) >= contrastRatio(background, dark) ? light : dark;
}

export interface DiffScale {
  readonly base: Oklab;
  readonly deletions: Oklab;
  readonly mixed: Oklab;
  readonly additions: Oklab;
}

/** Log scale, so a 10-line change and a 10,000-line change are both readable. */
export function churnIntensity(churn: number, churnMax: number): number {
  assert(churn >= 0, "churn is a count");
  if (churnMax <= 0) return 1;
  return Math.min(1, Math.log1p(churn) / Math.log1p(churnMax));
}

/**
 * Diverging by polarity, intensity by churn. Hue goes from deletions
 * through a neutral midpoint to additions by additions / (additions +
 * deletions); the result is then pulled from the unchanged tile color
 * toward that hue by churn intensity, never less than the floor.
 */
export function diffColor(scale: DiffScale, additions: number, deletions: number, churnMax: number): Rgb {
  const churn = additions + deletions;
  const additionShare = churn === 0 ? 0.5 : additions / churn;
  const full =
    additionShare >= 0.5
      ? mixOklab(scale.mixed, scale.additions, (additionShare - 0.5) * 2)
      : mixOklab(scale.mixed, scale.deletions, (0.5 - additionShare) * 2);
  const strength = DIFF_INTENSITY_FLOOR + (1 - DIFF_INTENSITY_FLOOR) * churnIntensity(churn, churnMax);
  return oklabToRgb(mixOklab(scale.base, full, strength));
}
