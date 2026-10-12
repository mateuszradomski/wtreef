// Tiny DOM helpers. Text always goes through textContent: paths, titles
// and names come from GitHub and are untrusted.

import { assert } from "./assert.ts";

export function element<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className: string,
  text: string = "",
): HTMLElementTagNameMap[Tag] {
  const created = document.createElement(tag);
  if (className !== "") created.className = className;
  if (text !== "") created.textContent = text;
  return created;
}

export function link(className: string, href: string, text: string, opensNewTab: boolean): HTMLAnchorElement {
  const anchor = element("a", className, text);
  anchor.href = href;
  if (opensNewTab) {
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  }
  return anchor;
}

export function button(className: string, text: string, label: string = ""): HTMLButtonElement {
  const created = element("button", className, text);
  created.type = "button";
  if (label !== "") created.setAttribute("aria-label", label);
  return created;
}

export function append(parent: HTMLElement, ...children: ReadonlyArray<HTMLElement | string>): HTMLElement {
  for (const child of children) {
    parent.append(child);
  }
  return parent;
}

export function requireElement<Type extends Element>(found: Type | null, description: string): Type {
  assert(found !== null, `missing element: ${description}`);
  return found;
}

export function setVisible(target: HTMLElement, visible: boolean): void {
  target.hidden = !visible;
}
