// Hover details for a tile. Content is described by a pure function, so
// it can be tested and reused; the DOM part only fills and positions.

import { FileStatus, NodeKind, type Tree } from "./decode.ts";
import { append, element } from "./dom.ts";
import { formatBytes, formatChurn, formatCount, plural } from "./format.ts";
import { isChangedFile, type TreeIndex } from "./model.ts";
import { statusClassName, statusLabel, statusOf } from "./status.ts";

export interface TooltipContent {
  readonly title: string;
  /** Status swatch class and label, for changed files only. */
  readonly status: { readonly className: string; readonly label: string } | null;
  readonly facts: readonly string[];
  /** What a click, an Alt-click and a right-click do; "" for nodes that do nothing. */
  readonly action: string;
}

/** `altKey` names the modifier as the keyboard prints it: "⌥" on Apple platforms, "Alt" elsewhere. */
export function describeNode(tree: Tree, index: TreeIndex, node: number, altKey: string): TooltipContent {
  const kind = tree.kinds[node];
  const path = index.paths[node] ?? "";
  const bytes = index.subtreeBytes[node] ?? 0;
  const files = index.subtreeFiles[node] ?? 0;
  if (kind === NodeKind.rest) {
    const parentPath = index.paths[tree.parents[node] ?? 0] ?? "";
    const where = parentPath === "" ? "the repository root" : `${parentPath}/`;
    return { title: `Other files in ${where}`, status: null, facts: [plural(files, "unchanged file", "unchanged files"), formatBytes(bytes)], action: "" };
  }
  if (kind === NodeKind.collapsedDirectory) {
    const facts = ["unchanged folder", plural(files, "file", "files"), formatBytes(bytes)];
    return { title: `${path}/`, status: null, facts, action: actionHint("", altKey) };
  }
  if (kind === NodeKind.directory) {
    const changed = index.subtreeChangedFiles[node] ?? 0;
    const facts = [
      `${formatCount(changed)} of ${plural(files, "file", "files")} changed`,
      formatChurn(index.subtreeAdditions[node] ?? 0, index.subtreeDeletions[node] ?? 0),
      formatBytes(bytes),
    ];
    return { title: `${path}/`, status: null, facts, action: actionHint("Click to zoom in", altKey) };
  }
  if (!isChangedFile(tree, node)) {
    return { title: path, status: null, facts: ["unchanged", formatBytes(bytes)], action: actionHint("", altKey) };
  }
  const status = statusOf(tree.statuses[node] ?? 0);
  const facts = [formatChurn(tree.additions[node] ?? 0, tree.deletions[node] ?? 0)];
  if (status === FileStatus.deleted) {
    facts.push("not in the head commit");
  } else if (bytes > 0) {
    facts.push(formatBytes(bytes));
  }
  return {
    title: path,
    status: { className: statusClassName(status), label: statusLabel(status) },
    facts,
    action: actionHint("Click to open the diff", altKey),
  };
}

/** What a plain click does, if anything, then the secondary actions every node with a path has. */
function actionHint(click: string, altKey: string): string {
  const secondary = `${altKey}-click to hide · Right-click for more`;
  return click === "" ? secondary : `${click} · ${secondary}`;
}

export interface Tooltip {
  readonly root: HTMLElement;
  node: number;
  width: number;
  height: number;
}

export function createTooltip(): Tooltip {
  const root = element("div", "tooltip");
  root.setAttribute("role", "tooltip");
  root.hidden = true;
  return { root, node: -1, width: 0, height: 0 };
}

export function fillTooltip(tooltip: Tooltip, node: number, content: TooltipContent): void {
  const facts = element("div", "tooltip-facts");
  if (content.status !== null) {
    facts.append(
      append(
        element("span", "tooltip-status"),
        element("span", `tooltip-swatch ${content.status.className}`),
        content.status.label,
      ),
    );
  }
  for (const fact of content.facts) facts.append(element("span", "tooltip-fact", fact));
  const children: HTMLElement[] = [element("div", "tooltip-title", content.title), facts];
  if (content.action !== "") children.push(element("div", "tooltip-action", content.action));
  tooltip.root.replaceChildren(...children);
  tooltip.root.hidden = false;
  tooltip.node = node;
  // Measured once per content change; moves reuse the size.
  tooltip.width = tooltip.root.offsetWidth;
  tooltip.height = tooltip.root.offsetHeight;
}

const POINTER_OFFSET_PX = 14;
const VIEWPORT_MARGIN_PX = 8;

/** Places the tooltip beside the pointer, flipping to stay inside the viewport. */
export function moveTooltip(tooltip: Tooltip, clientX: number, clientY: number): void {
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  let x = clientX + POINTER_OFFSET_PX;
  let y = clientY + POINTER_OFFSET_PX;
  if (x + tooltip.width > viewportWidth - VIEWPORT_MARGIN_PX) x = clientX - POINTER_OFFSET_PX - tooltip.width;
  if (y + tooltip.height > viewportHeight - VIEWPORT_MARGIN_PX) y = clientY - POINTER_OFFSET_PX - tooltip.height;
  x = Math.max(VIEWPORT_MARGIN_PX, x);
  y = Math.max(VIEWPORT_MARGIN_PX, y);
  tooltip.root.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

export function hideTooltip(tooltip: Tooltip): void {
  if (tooltip.node === -1) return;
  tooltip.root.hidden = true;
  tooltip.node = -1;
}
