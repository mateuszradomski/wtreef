// One tooltip for the page's controls, so every explanation looks and
// behaves the same and none doubles up with a native title. A control opts
// in through setTooltip, which keeps the text in data attributes; one set
// of delegated listeners on the document does the rest:
//
// - Hover shows it after TOOLTIP_DELAY_MS, or at once while another is up,
//   so moving along a row of controls reads them all. Touch never shows it.
// - Keyboard focus shows it at once; focus from a click does not.
// - Leaving, blurring, pressing, typing, scrolling, resizing or Esc hide
//   it, and a pressed control stays quiet until the pointer leaves it.
//
// While up, it is role="tooltip" and describes the control (or the focused
// element inside it) through aria-describedby. Placement is CSSOM only:
// the CSP forbids style attributes.

import { assert } from "./assert.ts";
import { append, element } from "./dom.ts";
import { placeBelow } from "./placement.ts";

const TOOLTIP_DELAY_MS = 350;
const TOOLTIP_ID = "control-tooltip";
const TRIGGER_SELECTOR = "[data-tooltip]";
const ANCHOR_GAP_PX = 6;
const NO_TIMER = 0;

/** `note` is a quieter last line, for a shortcut or what to do next. */
export function setTooltip(target: HTMLElement, text: string, note: string = ""): void {
  assert(text !== "", "a tooltip says something");
  target.dataset["tooltip"] = text;
  if (note === "") {
    delete target.dataset["tooltipNote"];
  } else {
    target.dataset["tooltipNote"] = note;
  }
}

export interface ControlTooltip {
  readonly root: HTMLElement;
  readonly text: HTMLElement;
  readonly note: HTMLElement;
  /** The control it is up for, or null while hidden. */
  shownFor: HTMLElement | null;
  /** The element it describes for assistive technology: the control, or the focused element inside it. */
  describes: HTMLElement | null;
  /** The control whose hover delay is running. */
  pendingFor: HTMLElement | null;
  /** A control just pressed: it stays quiet until the pointer leaves it. */
  quietFor: HTMLElement | null;
  timer: number;
}

export function installControlTooltip(): ControlTooltip {
  const root = element("div", "tooltip control-tooltip");
  root.id = TOOLTIP_ID;
  root.setAttribute("role", "tooltip");
  root.hidden = true;
  const text = element("div", "control-tooltip-text");
  const note = element("div", "tooltip-action");
  append(root, text, note);
  const tooltip: ControlTooltip = { root, text, note, shownFor: null, describes: null, pendingFor: null, quietFor: null, timer: NO_TIMER };
  attachPointerEvents(tooltip);
  attachFocusAndKeyEvents(tooltip);
  return tooltip;
}

function attachPointerEvents(tooltip: ControlTooltip): void {
  document.addEventListener("pointerover", (event) => {
    if (event.pointerType === "touch") return;
    const trigger = triggerOf(event.target);
    if (trigger !== null && trigger === tooltip.quietFor) return;
    tooltip.quietFor = null;
    if (trigger === null) {
      hideControlTooltip(tooltip);
    } else if (trigger !== tooltip.shownFor && trigger !== tooltip.pendingFor) {
      if (tooltip.shownFor !== null) {
        showControlTooltip(tooltip, trigger, trigger);
      } else {
        schedule(tooltip, trigger);
      }
    }
  });
  document.addEventListener("pointerout", (event) => {
    // Leaving the window has no element to go to.
    if (event.relatedTarget === null) hideControlTooltip(tooltip);
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      hideControlTooltip(tooltip);
      tooltip.quietFor = triggerOf(event.target);
    },
    { capture: true },
  );
  const hide = (): void => hideControlTooltip(tooltip);
  window.addEventListener("scroll", hide, { capture: true, passive: true });
  window.addEventListener("resize", hide);
  document.addEventListener("input", hide, { capture: true });
}

function attachFocusAndKeyEvents(tooltip: ControlTooltip): void {
  document.addEventListener("focusin", (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const trigger = triggerOf(event.target);
    if (trigger === null) return;
    // Focus that follows a click is not a request for an explanation.
    if (!event.target.matches(":focus-visible")) return;
    showControlTooltip(tooltip, trigger, event.target);
  });
  document.addEventListener("focusout", (event) => {
    if (tooltip.describes !== null && tooltip.describes === event.target) hideControlTooltip(tooltip);
  });
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || tooltip.shownFor === null) return;
      // The first Esc only dismisses the tooltip; it does not also zoom out or leave a field.
      event.preventDefault();
      event.stopPropagation();
      hideControlTooltip(tooltip);
    },
    { capture: true },
  );
}

function triggerOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(TRIGGER_SELECTOR);
}

function schedule(tooltip: ControlTooltip, trigger: HTMLElement): void {
  cancelPending(tooltip);
  tooltip.pendingFor = trigger;
  tooltip.timer = window.setTimeout(() => {
    tooltip.timer = NO_TIMER;
    tooltip.pendingFor = null;
    showControlTooltip(tooltip, trigger, trigger);
  }, TOOLTIP_DELAY_MS);
  assert(tooltip.timer !== NO_TIMER, "browsers never hand out timer id 0");
}

function cancelPending(tooltip: ControlTooltip): void {
  if (tooltip.timer !== NO_TIMER) window.clearTimeout(tooltip.timer);
  tooltip.timer = NO_TIMER;
  tooltip.pendingFor = null;
}

function showControlTooltip(tooltip: ControlTooltip, trigger: HTMLElement, describes: HTMLElement): void {
  cancelPending(tooltip);
  const text = trigger.dataset["tooltip"] ?? "";
  // A re-render can detach the control during the delay.
  if (!trigger.isConnected || text === "") {
    hideControlTooltip(tooltip);
    return;
  }
  if (tooltip.describes !== null) unlinkDescription(tooltip.describes);
  const note = trigger.dataset["tooltipNote"] ?? "";
  tooltip.text.textContent = text;
  tooltip.note.textContent = note;
  tooltip.note.hidden = note === "";
  tooltip.root.hidden = false;
  tooltip.shownFor = trigger;
  tooltip.describes = describes;
  linkDescription(describes);
  const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
  const size = { width: tooltip.root.offsetWidth, height: tooltip.root.offsetHeight };
  const corner = placeBelow(trigger.getBoundingClientRect(), size, viewport, ANCHOR_GAP_PX);
  tooltip.root.style.transform = `translate(${corner.x}px, ${corner.y}px)`;
}

export function hideControlTooltip(tooltip: ControlTooltip): void {
  cancelPending(tooltip);
  if (tooltip.shownFor === null) return;
  if (tooltip.describes !== null) unlinkDescription(tooltip.describes);
  tooltip.root.hidden = true;
  tooltip.shownFor = null;
  tooltip.describes = null;
}

/** Adds the tooltip to the element's description, keeping what else describes it (a pattern's error). */
function linkDescription(target: HTMLElement): void {
  const ids = descriptionIds(target);
  if (!ids.includes(TOOLTIP_ID)) ids.push(TOOLTIP_ID);
  target.setAttribute("aria-describedby", ids.join(" "));
}

function unlinkDescription(target: HTMLElement): void {
  const ids = descriptionIds(target).filter((id) => id !== TOOLTIP_ID);
  if (ids.length === 0) {
    target.removeAttribute("aria-describedby");
  } else {
    target.setAttribute("aria-describedby", ids.join(" "));
  }
}

function descriptionIds(target: HTMLElement): string[] {
  return (target.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((id) => id !== "");
}
