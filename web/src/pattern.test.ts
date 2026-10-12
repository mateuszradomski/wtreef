// Methodology: feed the parser each class of input a person can type or a
// link can carry (nothing, a valid regex, broken syntax, over-long text) and
// check the parsed shape. Then check the properties the filters rely on:
// matching ignores case, and repeated tests of one path never disagree.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeRegex,
  describeSyntaxError,
  EMPTY_PATH_PATTERN,
  PATH_PATTERN_LENGTH_MAX,
  parsePathPattern,
  patternSource,
} from "./pattern.ts";

test("empty text is the empty pattern and filters nothing", () => {
  const pattern = parsePathPattern("");
  assert.equal(pattern, EMPTY_PATH_PATTERN);
  assert.equal(patternSource(pattern), "");
  assert.equal(activeRegex(pattern), null);
});

test("valid text compiles to a case-insensitive, stateless regex", () => {
  const pattern = parsePathPattern("src/.*\\.tsx?$");
  assert.equal(pattern.kind, "valid");
  assert.equal(patternSource(pattern), "src/.*\\.tsx?$");
  const regex = activeRegex(pattern);
  assert.ok(regex !== null);
  assert.equal(regex.flags, "i");
  assert.ok(regex.test("packages/frontend/SRC/App.TSX"));
  // Without "g" or "y", lastIndex never moves, so the same path always gives the same answer.
  for (let attempt = 0; attempt < 3; attempt++) assert.ok(regex.test("src/a.ts"));
  assert.equal(regex.lastIndex, 0);
  assert.ok(!regex.test("src/a.js"));
});

test("broken syntax is invalid, keeps its text, says why, and filters nothing", () => {
  const pattern = parsePathPattern("(");
  assert.equal(pattern.kind, "invalid");
  assert.equal(patternSource(pattern), "(");
  assert.equal(activeRegex(pattern), null);
  if (pattern.kind !== "invalid") return;
  assert.notEqual(pattern.message, "");
  assert.ok(!pattern.message.includes("/("), "the message leaves out the pattern, which is already on screen");
});

test("text over the length cap is invalid without being compiled", () => {
  const atCap = "a".repeat(PATH_PATTERN_LENGTH_MAX);
  assert.equal(parsePathPattern(atCap).kind, "valid");
  const overCap = parsePathPattern(`${atCap}a`);
  assert.equal(overCap.kind, "invalid");
  if (overCap.kind === "invalid") assert.equal(overCap.message, `Longer than ${PATH_PATTERN_LENGTH_MAX} characters`);
});

test("syntax errors keep only the engine's reason", () => {
  assert.equal(describeSyntaxError("Invalid regular expression: /(/i: Unterminated group"), "Unterminated group");
  assert.equal(describeSyntaxError("Invalid regular expression: /a: (/i: Unterminated group"), "Unterminated group");
  assert.equal(describeSyntaxError("unterminated parenthetical"), "Unterminated parenthetical");
  assert.equal(describeSyntaxError("Invalid regular expression: missing )"), "Missing )");
  assert.equal(describeSyntaxError(""), "Not a valid regular expression");
});
