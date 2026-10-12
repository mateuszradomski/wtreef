// Methodology: the size control follows the ARIA radio group pattern, where
// arrow keys move the choice; check every key it must answer and one it
// must leave alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { arrowStep } from "./controls.ts";

test("arrows step through the size options and other keys do nothing", () => {
  assert.equal(arrowStep("ArrowRight"), 1);
  assert.equal(arrowStep("ArrowDown"), 1);
  assert.equal(arrowStep("ArrowLeft"), -1);
  assert.equal(arrowStep("ArrowUp"), -1);
  assert.equal(arrowStep("Enter"), 0);
});
