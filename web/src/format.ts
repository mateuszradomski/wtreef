// Human-readable numbers. Pure; shared by the canvas labels and the DOM.

import { assert } from "./assert.ts";

const INTEGER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0, useGrouping: true });
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const BYTES_PER_KILOBYTE = 1024;
export const MINUS_SIGN = "−";
const NO_BREAK_SPACE = " ";

export function formatCount(count: number): string {
  assert(Number.isFinite(count), "count must be finite");
  // Every tile label is formatted on every redraw, and most counts need no separator; Intl is slow for those.
  if (Number.isInteger(count) && count >= 0 && count < 1000) return String(count);
  return INTEGER_FORMAT.format(count);
}

/** 1024-based, one decimal below 10 units: "0 B", "812 B", "1.8 KB", "12 KB", "3.4 MB". */
export function formatBytes(bytes: number): string {
  assert(bytes >= 0, "byte counts are non-negative");
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_KILOBYTE && unit < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_KILOBYTE;
    unit++;
  }
  const digits = unit > 0 && value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit] ?? "B"}`;
}

export function formatAdditions(additions: number): string {
  return `+${formatCount(additions)}`;
}

export function formatDeletions(deletions: number): string {
  return `${MINUS_SIGN}${formatCount(deletions)}`;
}

export function formatChurn(additions: number, deletions: number): string {
  return `${formatAdditions(additions)} ${formatDeletions(deletions)}`;
}

/** Drops a zero side, so a new file reads "+120" rather than "+120 −0"; a pure rename reads "±0". */
export function formatChurnNonZero(additions: number, deletions: number): string {
  if (additions === 0 && deletions === 0) return "\u00b10";
  if (deletions === 0) return formatAdditions(additions);
  if (additions === 0) return formatDeletions(deletions);
  return formatChurn(additions, deletions);
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}

/** "45 s", "3 min", "2 h 5 min": precise enough for a retry hint. No-break spaces keep a number with its unit. */
export function formatWait(seconds: number): string {
  assert(seconds >= 0, "waits are non-negative");
  const wholeSeconds = Math.ceil(seconds);
  if (wholeSeconds < 60) return `${wholeSeconds}${NO_BREAK_SPACE}s`;
  const minutes = Math.ceil(wholeSeconds / 60);
  if (minutes < 60) return `${minutes}${NO_BREAK_SPACE}min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const hoursText = `${hours}${NO_BREAK_SPACE}h`;
  return remainder === 0 ? hoursText : `${hoursText} ${remainder}${NO_BREAK_SPACE}min`;
}
