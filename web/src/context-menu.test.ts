// Methodology: the menu follows the WAI-ARIA menu pattern; check every key
// it must answer, from the first, a middle and the last item and from no
// item, and the keys it must leave to the focused button.

import { test } from "node:test";
import assert from "node:assert/strict";
import { menuKeyTarget } from "./context-menu.ts";

const LABELS = ["Open diff on GitHub", "Hide file", "Copy path"];

test("arrows move between items and wrap at the ends", () => {
  assert.equal(menuKeyTarget(LABELS, 0, "ArrowDown"), 1);
  assert.equal(menuKeyTarget(LABELS, 2, "ArrowDown"), 0);
  assert.equal(menuKeyTarget(LABELS, 0, "ArrowUp"), 2);
  assert.equal(menuKeyTarget(LABELS, -1, "ArrowDown"), 0);
  assert.equal(menuKeyTarget(LABELS, -1, "ArrowUp"), 2);
  assert.equal(menuKeyTarget(LABELS, 1, "ArrowRight"), -1, "no submenus, so no sideways moves");
});

test("Home and End jump to the ends", () => {
  assert.equal(menuKeyTarget(LABELS, 1, "Home"), 0);
  assert.equal(menuKeyTarget(LABELS, 1, "End"), 2);
});

test("a letter moves to the next item starting with it, ignoring case", () => {
  assert.equal(menuKeyTarget(LABELS, 0, "h"), 1);
  assert.equal(menuKeyTarget(LABELS, 0, "C"), 2);
  assert.equal(menuKeyTarget(["Hide", "Hide again", "Copy"], 1, "h"), 0, "the search wraps past the end");
  assert.equal(menuKeyTarget(LABELS, 0, "x"), -1);
});

test("Enter and Space are left to the focused button", () => {
  assert.equal(menuKeyTarget(LABELS, 1, "Enter"), -1);
  assert.equal(menuKeyTarget(LABELS, 1, " "), -1);
});
