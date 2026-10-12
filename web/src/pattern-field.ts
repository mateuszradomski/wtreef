// One regex input, Include or Exclude. It debounces typing and shows
// whether the committed pattern parses. It never owns filter state: it hands
// raw text to the controller and mirrors back whatever pattern the filters
// hold.

import { assert } from "./assert.ts";
import { append, element } from "./dom.ts";
import { type PathPattern, patternSource } from "./pattern.ts";

/** Long enough to skip intermediate keystrokes, short enough to feel live. */
const INPUT_DEBOUNCE_MS = 120;
const NO_TIMER = 0;
export const PATTERN_TITLE = "Regular expression, case-insensitive, matched against the full path";

export interface PatternFieldOptions {
  /** Distinguishes the two fields in element ids. */
  readonly name: "include" | "exclude";
  readonly label: string;
  readonly placeholder: string;
  readonly onCommit: (text: string) => void;
}

export interface PatternField {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  readonly error: HTMLElement;
  /** Pending debounce timer, or NO_TIMER. While pending, the input holds text the filters have not seen yet. */
  timer: number;
}

export function createPatternField(options: PatternFieldOptions): PatternField {
  const root = element("label", "pattern-field");
  const input = element("input", "pattern-input");
  input.type = "text";
  input.placeholder = options.placeholder;
  input.title = PATTERN_TITLE;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocorrect", "off");
  const errorId = `pattern-error-${options.name}`;
  input.setAttribute("aria-describedby", errorId);
  const badge = element("span", "pattern-badge", ".*");
  badge.setAttribute("aria-hidden", "true");
  const error = element("span", "pattern-error");
  error.id = errorId;
  error.hidden = true;
  append(root, element("span", "pattern-label", options.label), input, badge, error);

  const field: PatternField = { root, input, error, timer: NO_TIMER };
  attachPatternFieldEvents(field, options.onCommit);
  return field;
}

function attachPatternFieldEvents(field: PatternField, onCommit: (text: string) => void): void {
  const commit = (): void => {
    if (field.timer !== NO_TIMER) window.clearTimeout(field.timer);
    field.timer = NO_TIMER;
    onCommit(field.input.value);
  };
  field.input.addEventListener("input", () => {
    if (field.timer !== NO_TIMER) window.clearTimeout(field.timer);
    field.timer = window.setTimeout(commit, INPUT_DEBOUNCE_MS);
    assert(field.timer !== NO_TIMER, "browsers never hand out timer id 0");
  });
  // Leaving the field commits at once, so a click elsewhere never races the debounce.
  field.input.addEventListener("blur", () => {
    if (field.timer !== NO_TIMER) commit();
  });
  field.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") commit();
    if (event.key === "Escape") field.input.blur();
  });
}

/** Mirrors `pattern` into the field: its text (unless typing is pending) and whether it is ignored. */
export function syncPatternField(field: PatternField, pattern: PathPattern): void {
  const source = patternSource(pattern);
  if (field.timer === NO_TIMER && field.input.value !== source) field.input.value = source;
  const invalid = pattern.kind === "invalid";
  field.root.classList.toggle("is-invalid", invalid);
  field.input.setAttribute("aria-invalid", invalid ? "true" : "false");
  field.input.title = invalid ? `${pattern.message}. This filter is ignored until it is fixed.` : PATTERN_TITLE;
  field.error.hidden = !invalid;
  field.error.textContent = invalid ? `${pattern.message} · ignored` : "";
}
