// Methodology: boundary values for each unit and rounding rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes, formatChurn, formatCount, formatWait, plural } from "./format.ts";

test("formats counts with grouping", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(10859), "10,859");
});

test("formats bytes at unit boundaries", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1820), "1.8 KB");
  assert.equal(formatBytes(10 * 1024), "10 KB");
  assert.equal(formatBytes(454023), "443 KB");
  assert.equal(formatBytes(2190495), "2.1 MB");
});

test("formats churn with a real minus sign", () => {
  assert.equal(formatChurn(10859, 109), "+10,859 −109");
});

test("pluralizes", () => {
  assert.equal(plural(1, "file", "files"), "1 file");
  assert.equal(plural(2, "file", "files"), "2 files");
});

test("formats retry waits", () => {
  assert.equal(formatWait(0), "0 s");
  assert.equal(formatWait(58.2), "59 s");
  assert.equal(formatWait(59.2), "1 min");
  assert.equal(formatWait(61), "2 min");
  assert.equal(formatWait(3600), "1 h");
  assert.equal(formatWait(3900), "1 h 5 min");
});
