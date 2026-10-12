// Tiny DOM helpers. Text always goes through textContent: paths, titles
// and names come from GitHub and are untrusted.

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

/** With `href` "" the anchor goes nowhere but stays a Tab stop, like the links it stands in for. */
export function link(className: string, href: string, text: string, opensNewTab: boolean): HTMLAnchorElement {
  const anchor = element("a", className, text);
  if (href === "") {
    anchor.tabIndex = 0;
    return anchor;
  }
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

/**
 * A path whose folders give way first when space runs out (see .file-path in
 * style.css), so the name stays readable. A folder keeps its trailing "/".
 */
export function pathText(className: string, path: string): HTMLElement {
  const slash = path.lastIndexOf("/", path.length - 2);
  const text = element("span", className === "" ? "file-path" : `file-path ${className}`);
  if (slash >= 0) text.append(element("span", "file-directory", path.slice(0, slash + 1)));
  text.append(element("span", "file-name", path.slice(slash + 1)));
  return text;
}
