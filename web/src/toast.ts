// One message at the bottom of the map, for what just happened ("Hidden
// docs/ · Undo") and for errors. role="status" announces it politely; the
// region stays in the page so screen readers notice new text in it. A new
// message replaces the old one, and it leaves after TOAST_MS unless the
// pointer or focus is on it.

import { assert } from "./assert.ts";
import { button, element, pathText } from "./dom.ts";

export const TOAST_MS = 6000;
const NO_TIMER = 0;

export const ToastTone = { info: "info", error: "error" } as const;
export type ToastTone = (typeof ToastTone)[keyof typeof ToastTone];

export interface ToastAction {
  readonly label: string;
  readonly run: () => void;
}

export interface ToastMessage {
  readonly text: string;
  /** Shown in monospace after the text, its folders giving way first; "" for none. */
  readonly path: string;
  readonly tone: ToastTone;
  readonly action: ToastAction | null;
}

export interface Toast {
  readonly root: HTMLElement;
  readonly box: HTMLElement;
  action: ToastAction | null;
  timer: number;
  pointerInside: boolean;
  focusInside: boolean;
  /** Where focus came from when it entered the toast; it goes back there when the toast leaves. */
  returnFocus: HTMLElement | null;
}

export function createToast(): Toast {
  const root = element("div", "toast-region");
  root.setAttribute("role", "status");
  const box = element("div", "toast");
  box.hidden = true;
  root.append(box);
  const toast: Toast = { root, box, action: null, timer: NO_TIMER, pointerInside: false, focusInside: false, returnFocus: null };
  attachToastEvents(toast);
  return toast;
}

export function showToast(toast: Toast, message: ToastMessage): void {
  assert(message.text !== "", "a toast says something");
  const children: Array<HTMLElement | string> = [element("span", "toast-text", message.text)];
  if (message.path !== "") children.push(pathText("toast-path", message.path));
  if (message.action !== null) {
    const separator = element("span", "toast-separator", "·");
    separator.setAttribute("aria-hidden", "true");
    children.push(separator, button("toast-action", message.action.label));
  }
  toast.box.replaceChildren(...children);
  toast.box.classList.toggle("is-error", message.tone === ToastTone.error);
  toast.box.hidden = false;
  toast.action = message.action;
  restartTimer(toast);
}

export function hideToast(toast: Toast): void {
  stopTimer(toast);
  if (toast.box.hidden) return;
  // Read before hiding: losing focus to the hidden box fires focusout, which forgets where focus came from.
  const hadFocus = toast.box.contains(document.activeElement);
  const returnFocus = toast.returnFocus;
  toast.box.hidden = true;
  toast.box.replaceChildren();
  toast.action = null;
  toast.pointerInside = false;
  toast.focusInside = false;
  toast.returnFocus = null;
  if (hadFocus && returnFocus !== null && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
}

/** Runs the toast's action, as its button or a shortcut does, and dismisses it. False when there is none. */
export function runToastAction(toast: Toast): boolean {
  const action = toast.action;
  if (action === null) return false;
  hideToast(toast);
  action.run();
  return true;
}

function attachToastEvents(toast: Toast): void {
  toast.box.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest(".toast-action") !== null) runToastAction(toast);
  });
  toast.box.addEventListener("pointerenter", () => {
    toast.pointerInside = true;
    stopTimer(toast);
  });
  toast.box.addEventListener("pointerleave", () => {
    toast.pointerInside = false;
    restartTimer(toast);
  });
  toast.box.addEventListener("focusin", (event) => {
    if (!toast.focusInside && event.relatedTarget instanceof HTMLElement) toast.returnFocus = event.relatedTarget;
    toast.focusInside = true;
    stopTimer(toast);
  });
  toast.box.addEventListener("focusout", (event) => {
    if (event.relatedTarget instanceof Node && toast.box.contains(event.relatedTarget)) return;
    toast.focusInside = false;
    toast.returnFocus = null;
    restartTimer(toast);
  });
}

function restartTimer(toast: Toast): void {
  stopTimer(toast);
  if (toast.box.hidden || toast.pointerInside || toast.focusInside) return;
  toast.timer = window.setTimeout(() => hideToast(toast), TOAST_MS);
  assert(toast.timer !== NO_TIMER, "browsers never hand out timer id 0");
}

function stopTimer(toast: Toast): void {
  if (toast.timer === NO_TIMER) return;
  window.clearTimeout(toast.timer);
  toast.timer = NO_TIMER;
}
