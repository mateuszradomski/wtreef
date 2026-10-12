// A segmented control: a bordered track holding one button per option, with
// ARIA radio group semantics. Arrows move the choice, and Tab enters and
// leaves the group as one stop (roving tabindex). It never owns the value:
// a choice goes through the callback, and syncSegmented mirrors it back.

import { assert } from "./assert.ts";
import { button, element } from "./dom.ts";

export interface SegmentedOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly description: string;
}

export interface Segmented<Value extends string> {
  readonly root: HTMLElement;
  readonly buttons: ReadonlyMap<Value, HTMLButtonElement>;
}

/** `className` adds to "segmented", for size variants. */
export function createSegmented<Value extends string>(
  className: string,
  options: readonly SegmentedOption<Value>[],
  onChoose: (value: Value) => void,
): Segmented<Value> {
  assert(options.length >= 2, "a choice needs at least two options");
  const buttons = new Map<Value, HTMLButtonElement>();
  const root = element("div", className === "" ? "segmented" : `segmented ${className}`);
  root.setAttribute("role", "radiogroup");
  for (const option of options) {
    const segment = button("segment", option.label);
    segment.setAttribute("role", "radio");
    segment.title = option.description;
    segment.addEventListener("click", () => onChoose(option.value));
    buttons.set(option.value, segment);
    root.append(segment);
  }
  root.addEventListener("keydown", (event) => {
    const step = arrowStep(event.key);
    if (step === 0) return;
    const focused = options.findIndex((option) => buttons.get(option.value) === document.activeElement);
    if (focused < 0) return;
    event.preventDefault();
    const next = options[(focused + step + options.length) % options.length];
    assert(next !== undefined, "the index wraps within the options");
    buttons.get(next.value)?.focus();
    onChoose(next.value);
  });
  return { root, buttons };
}

/** +1 for the next option, -1 for the previous one, 0 for any other key. */
export function arrowStep(key: string): number {
  if (key === "ArrowRight" || key === "ArrowDown") return 1;
  if (key === "ArrowLeft" || key === "ArrowUp") return -1;
  return 0;
}

export function syncSegmented<Value extends string>(segmented: Segmented<Value>, value: Value): void {
  assert(segmented.buttons.has(value), "the value is one of the options");
  for (const [option, segment] of segmented.buttons) {
    const active = option === value;
    segment.setAttribute("aria-checked", active ? "true" : "false");
    segment.classList.toggle("is-active", active);
    segment.tabIndex = active ? 0 : -1;
  }
}
