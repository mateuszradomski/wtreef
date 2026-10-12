// The controls bar under the header: where you are on the left
// (breadcrumbs), how the map is drawn on the right (size mode, Include and
// Exclude patterns). Built once per PR; syncControls mirrors the view state
// into it. It never owns state: every interaction goes through a callback.

import type { Tree } from "./decode.ts";
import { append, button, element } from "./dom.ts";
import { type Filters, SizeMode } from "./model.ts";
import { createPatternField, type PatternField, syncPatternField } from "./pattern-field.ts";
import { createSegmented, type Segmented, type SegmentedOption, syncSegmented } from "./segmented.ts";

export interface ControlsCallbacks {
  readonly onSizeMode: (mode: SizeMode) => void;
  readonly onInclude: (text: string) => void;
  readonly onExclude: (text: string) => void;
  readonly onZoom: (node: number) => void;
}

export interface Controls {
  readonly root: HTMLElement;
  readonly crumbList: HTMLElement;
  readonly escapeHint: HTMLElement;
  readonly sizeMode: Segmented<SizeMode>;
  readonly include: PatternField;
  readonly exclude: PatternField;
  readonly onZoom: (node: number) => void;
  /** The zoom the crumbs were built for; rebuilding only on change keeps keyboard focus on a crumb. */
  crumbsZoomNode: number;
}

/** What the controls show besides the filters: the zoomed folder. */
export interface ControlsInput {
  readonly filters: Filters;
  readonly tree: Tree;
  readonly zoomNode: number;
  readonly repositoryName: string;
}

const NO_CRUMBS = -1;

const SIZE_MODE_OPTIONS: readonly SegmentedOption<SizeMode>[] = [
  { value: SizeMode.churn, label: "Churn", description: "Size tiles by lines added plus lines removed" },
  { value: SizeMode.context, label: "Context", description: "Size tiles by file size, with unchanged files around the changes" },
];

export function createControls(callbacks: ControlsCallbacks): Controls {
  const root = element("div", "controls-bar");
  const crumbs = element("nav", "crumbs");
  crumbs.setAttribute("aria-label", "Folder");
  const crumbList = element("ol", "crumb-list");
  const escapeHint = element("kbd", "crumb-escape", "Esc");
  escapeHint.title = "Press Esc to zoom out one folder";
  escapeHint.hidden = true;
  append(crumbs, crumbList, escapeHint);

  const sizeMode = createSegmented("", SIZE_MODE_OPTIONS, callbacks.onSizeMode);
  const sizeGroup = element("div", "control-group");
  const sizeLabel = element("span", "control-label", "Size");
  sizeLabel.id = "size-mode-label";
  sizeMode.root.setAttribute("aria-labelledby", sizeLabel.id);
  append(sizeGroup, sizeLabel, sizeMode.root);
  const include = createPatternField({
    name: "include",
    label: "Include",
    // "e.g." keeps the example from reading as an active filter.
    placeholder: "e.g. src/.*\\.tsx?$",
    onCommit: callbacks.onInclude,
  });
  const exclude = createPatternField({
    name: "exclude",
    label: "Exclude",
    placeholder: "e.g. test|\\.snap$",
    onCommit: callbacks.onExclude,
  });
  const patterns = append(element("div", "pattern-fields"), include.root, exclude.root);
  const end = append(element("div", "controls-end"), sizeGroup, patterns);
  append(root, crumbs, end);
  return {
    root,
    crumbList,
    escapeHint,
    sizeMode,
    include,
    exclude,
    onZoom: callbacks.onZoom,
    crumbsZoomNode: NO_CRUMBS,
  };
}

export function syncControls(controls: Controls, input: ControlsInput): void {
  syncSegmented(controls.sizeMode, input.filters.sizeMode);
  syncPatternField(controls.include, input.filters.include);
  syncPatternField(controls.exclude, input.filters.exclude);
  if (controls.crumbsZoomNode !== input.zoomNode) {
    renderBreadcrumbs(controls, input.tree, input.zoomNode, input.repositoryName);
    controls.crumbsZoomNode = input.zoomNode;
  }
  controls.escapeHint.hidden = input.zoomNode === 0;
}

/** Rebuilds the crumbs for the zoomed directory: `repo / packages / frontend`. */
function renderBreadcrumbs(controls: Controls, tree: Tree, zoomNode: number, repositoryName: string): void {
  const chain: number[] = [];
  for (let node = zoomNode; node > 0 && chain.length < tree.nodeCount; node = tree.parents[node] ?? 0) {
    chain.push(node);
  }
  chain.push(0);
  chain.reverse();
  const items: HTMLElement[] = [];
  for (let position = 0; position < chain.length; position++) {
    const node = chain[position] ?? 0;
    const name = node === 0 ? repositoryName : (tree.names[node] ?? "");
    if (position > 0) {
      const separator = element("li", "crumb-separator", "/");
      separator.setAttribute("aria-hidden", "true");
      items.push(separator);
    }
    if (position === chain.length - 1) {
      const current = element("span", "crumb is-current", name);
      current.setAttribute("aria-current", "location");
      items.push(append(element("li", ""), current));
    } else {
      const crumb = button("crumb", name);
      crumb.title = node === 0 ? "Back to the repository root" : `Zoom out to ${name}`;
      crumb.addEventListener("click", () => controls.onZoom(node));
      items.push(append(element("li", ""), crumb));
    }
  }
  controls.crumbList.replaceChildren(...items);
}
