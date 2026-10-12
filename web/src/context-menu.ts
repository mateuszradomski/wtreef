// A small menu at the pointer for actions on one file or folder, after the
// WAI-ARIA menu pattern: role menu with menuitems, and focus moves into it
// on open. Arrows, Home and End move; Enter or Space activate; a letter
// jumps to the item starting with it. Esc, Tab, a click outside, scrolling,
// resizing or leaving the window close it, and focus returns to where it
// was. It never owns state: an item runs its callback after the menu closes.

import { assert } from "./assert.ts";
import { append, button, element, pathText } from "./dom.ts";
import { placeAtPoint } from "./placement.ts";
import { arrowStep } from "./segmented.ts";

/** Keeps the pointer off the menu; see placeAtPoint. */
const POINTER_GAP_PX = 2;

export interface ContextMenuItem {
  readonly label: string;
  /** A key that does the same outside the menu, shown at the item's end; "" for none. */
  readonly shortcut: string;
  readonly run: () => void;
}

export interface ContextMenu {
  readonly root: HTMLElement;
  readonly title: HTMLElement;
  buttons: HTMLButtonElement[];
  items: readonly ContextMenuItem[];
  /** Where focus was when the menu opened. */
  returnFocus: HTMLElement | null;
  isOpen: boolean;
  /** Bound once, so they can be added on open and removed on close. */
  readonly closeOnOutsidePointer: (event: PointerEvent) => void;
  readonly closeOnViewportChange: () => void;
}

export function createContextMenu(): ContextMenu {
  const root = element("div", "context-menu");
  root.setAttribute("role", "menu");
  root.hidden = true;
  const title = element("div", "context-menu-title");
  // The menu's accessible name already says this; the title is for sighted users on a busy map.
  title.setAttribute("aria-hidden", "true");
  root.append(title);
  let menu: ContextMenu | null = null;
  const getMenu = (): ContextMenu => {
    assert(menu !== null, "listeners run after the menu is built");
    return menu;
  };
  menu = {
    root,
    title,
    buttons: [],
    items: [],
    returnFocus: null,
    isOpen: false,
    closeOnOutsidePointer: (event) => {
      if (event.target instanceof Node && root.contains(event.target)) return;
      closeContextMenu(getMenu());
    },
    closeOnViewportChange: () => closeContextMenu(getMenu()),
  };
  attachMenuEvents(menu);
  return menu;
}

/** Where a menu opens, and whether a finger opened it: no item is marked until one is touched. */
export interface MenuOpening {
  readonly clientX: number;
  readonly clientY: number;
  readonly byTouch: boolean;
}

/** `name` labels the menu: the path of the file or folder it acts on. */
export function openContextMenu(menu: ContextMenu, name: string, items: readonly ContextMenuItem[], opening: MenuOpening): void {
  assert(items.length > 0, "a menu has items");
  const returnFocus = menu.isOpen ? menu.returnFocus : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (menu.isOpen) closeContextMenu(menu);
  menu.items = items;
  menu.buttons = items.map((item) => createItemButton(item));
  menu.title.replaceChildren(pathText("", name));
  menu.root.setAttribute("aria-label", name);
  menu.root.replaceChildren(menu.title, ...menu.buttons);
  menu.root.classList.toggle("is-touch", opening.byTouch);
  menu.root.hidden = false;
  menu.isOpen = true;
  menu.returnFocus = returnFocus;
  const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
  const size = { width: menu.root.offsetWidth, height: menu.root.offsetHeight };
  const corner = placeAtPoint({ x: opening.clientX, y: opening.clientY }, size, viewport, POINTER_GAP_PX);
  // CSSOM, not a style attribute: the CSP forbids inline styles but allows this.
  menu.root.style.transform = `translate(${corner.x}px, ${corner.y}px)`;
  document.addEventListener("pointerdown", menu.closeOnOutsidePointer, { capture: true });
  window.addEventListener("scroll", menu.closeOnViewportChange, { capture: true, passive: true });
  window.addEventListener("resize", menu.closeOnViewportChange);
  window.addEventListener("blur", menu.closeOnViewportChange);
  menu.buttons[0]?.focus({ preventScroll: true });
}

export function closeContextMenu(menu: ContextMenu): void {
  if (!menu.isOpen) return;
  menu.isOpen = false;
  menu.root.hidden = true;
  document.removeEventListener("pointerdown", menu.closeOnOutsidePointer, { capture: true });
  window.removeEventListener("scroll", menu.closeOnViewportChange, { capture: true });
  window.removeEventListener("resize", menu.closeOnViewportChange);
  window.removeEventListener("blur", menu.closeOnViewportChange);
  const returnFocus = menu.returnFocus;
  menu.returnFocus = null;
  // A pointerdown outside focuses what it lands on right after this, if that can take focus.
  if (returnFocus !== null && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
}

function createItemButton(item: ContextMenuItem): HTMLButtonElement {
  const itemButton = button("context-menu-item", "");
  itemButton.setAttribute("role", "menuitem");
  itemButton.tabIndex = -1;
  itemButton.append(element("span", "context-menu-label", item.label));
  if (item.shortcut !== "") {
    const shortcut = element("kbd", "context-menu-shortcut", item.shortcut);
    shortcut.setAttribute("aria-hidden", "true");
    itemButton.setAttribute("aria-keyshortcuts", item.shortcut);
    append(itemButton, shortcut);
  }
  return itemButton;
}

function attachMenuEvents(menu: ContextMenu): void {
  menu.root.addEventListener("click", (event) => {
    const index = itemIndexOf(menu, event.target);
    if (index < 0) return;
    const item = menu.items[index];
    assert(item !== undefined, "every button has its item");
    closeContextMenu(menu);
    item.run();
  });
  // Hovering moves focus, so the keys continue from the item under the pointer.
  menu.root.addEventListener("pointermove", (event) => {
    const index = itemIndexOf(menu, event.target);
    if (index >= 0 && document.activeElement !== menu.buttons[index]) menu.buttons[index]?.focus({ preventScroll: true });
  });
  menu.root.addEventListener("contextmenu", (event) => event.preventDefault());
  menu.root.addEventListener("keydown", (event) => {
    // Keys pressed in the menu are the menu's: none reach the page's shortcuts.
    event.stopPropagation();
    handleMenuKey(menu, event);
  });
}

function handleMenuKey(menu: ContextMenu, event: KeyboardEvent): void {
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    closeContextMenu(menu);
    return;
  }
  const focused = itemIndexOf(menu, document.activeElement);
  const target = menuKeyTarget(menu.items.map((item) => item.label), focused, event.key);
  if (target < 0) return;
  event.preventDefault();
  menu.buttons[target]?.focus({ preventScroll: true });
}

/**
 * The item `key` moves to from item `focused` (-1 for none) among items
 * with these labels, or -1 for keys the menu leaves alone: Enter and Space
 * activate the focused button natively. Arrows wrap; a letter goes to the
 * next item starting with it.
 */
export function menuKeyTarget(labels: readonly string[], focused: number, key: string): number {
  const count = labels.length;
  assert(count > 0, "a menu has items");
  assert(focused >= -1 && focused < count, "focus is on an item or on none");
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  // Left and Right have no meaning in a menu without submenus.
  if (key === "ArrowDown" || key === "ArrowUp") {
    if (focused < 0) return key === "ArrowDown" ? 0 : count - 1;
    return (focused + arrowStep(key) + count) % count;
  }
  if (key.length !== 1 || key === " ") return -1;
  const letter = key.toLowerCase();
  for (let step = 1; step <= count; step++) {
    const candidate = (focused + step + count) % count;
    if ((labels[candidate] ?? "").toLowerCase().startsWith(letter)) return candidate;
  }
  return -1;
}

function itemIndexOf(menu: ContextMenu, target: EventTarget | null): number {
  if (!(target instanceof Element)) return -1;
  const itemButton = target.closest(".context-menu-item");
  if (itemButton === null) return -1;
  return menu.buttons.findIndex((candidate) => candidate === itemButton);
}
