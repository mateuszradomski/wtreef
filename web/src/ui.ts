// Static chrome around the map: header, truncation banner, breadcrumbs and
// legend. Untrusted text (titles, names) only ever goes through textContent.

import type { PullRequestData, Tree } from "./decode.ts";
import { append, button, element, link } from "./dom.ts";
import { formatAdditions, formatCount, formatDeletions, plural } from "./format.ts";

export function createHeader(data: PullRequestData): HTMLElement {
  const { pullRequest } = data;
  const header = element("header", "pr-header");
  const brand = link("brand", "/", "wtreef", false);

  const identity = element("div", "pr-identity");
  const repository = element("span", "pr-repo", `${pullRequest.owner}/${pullRequest.repo}`);
  const number = element("span", "pr-number", `#${pullRequest.number}`);
  const title = element("span", "pr-title", pullRequest.title);
  title.title = pullRequest.title;
  const state = element("span", `pr-state pr-state-${pullRequest.state}`, pullRequest.state);
  append(identity, repository, number, title, state);

  const stats = element("div", "pr-stats mono");
  const additions = element("span", "pr-additions", formatAdditions(pullRequest.additions));
  const deletions = element("span", "pr-deletions", formatDeletions(pullRequest.deletions));
  const files = element("span", "pr-files", plural(pullRequest.changedFiles, "file", "files"));
  const github = link("pr-github", pullRequest.url, "GitHub ↗", true);
  github.setAttribute("aria-label", "Open the pull request on GitHub");
  append(stats, append(element("span", "pr-churn"), additions, " ", deletions), files, github);

  return append(header, brand, identity, stats);
}

/** Null when GitHub gave us everything; otherwise says what is missing and why. */
export function createTruncationBanner(data: PullRequestData, shownChangedFiles: number): HTMLElement | null {
  const notes: string[] = [];
  if (data.truncatedFiles) {
    notes.push(
      `GitHub listed ${formatCount(shownChangedFiles)} of ${formatCount(data.pullRequest.changedFiles)} changed files; the rest are not shown.`,
    );
  }
  if (data.truncatedTree) {
    notes.push("This repository is too large for GitHub to list in full, so the unchanged context is partial.");
  }
  if (notes.length === 0) return null;
  const banner = element("div", "banner", notes.join(" "));
  banner.setAttribute("role", "note");
  return banner;
}

/** Rebuilds the crumbs for the zoomed directory: `repo / packages / frontend`. */
export function renderBreadcrumbs(
  list: HTMLElement,
  tree: Tree,
  zoomNode: number,
  repositoryName: string,
  onZoom: (node: number) => void,
): void {
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
    const isCurrent = position === chain.length - 1;
    if (isCurrent) {
      const current = element("span", "crumb is-current", name);
      current.setAttribute("aria-current", "location");
      items.push(append(element("li", ""), current));
    } else {
      const crumb = button("crumb", name);
      crumb.title = node === 0 ? "Back to the repository root" : `Zoom out to ${name}`;
      crumb.addEventListener("click", () => onZoom(node));
      items.push(append(element("li", ""), crumb));
    }
  }
  list.replaceChildren(...items);
}

export function createBreadcrumbs(): { nav: HTMLElement; list: HTMLElement } {
  const nav = element("nav", "crumbs");
  nav.setAttribute("aria-label", "Folder");
  const list = element("ol", "crumb-list");
  nav.append(list, element("span", "crumb-hint", "Click a folder to zoom · Esc to go up"));
  return { nav, list };
}

/** The diverging ramp is a CSS gradient in OKLab, the same space and endpoints the canvas mixes in. */
export function createLegend(): HTMLElement {
  const legend = element("div", "legend");
  legend.setAttribute("aria-label", "Legend");
  const ramp = append(
    element("span", "legend-ramp-group"),
    element("span", "legend-end", "deleted"),
    element("span", "legend-ramp"),
    element("span", "legend-end", "added"),
  );
  ramp.title = "Hue: share of added vs deleted lines. Brightness: lines changed, on a log scale.";
  append(
    legend,
    ramp,
    swatch("legend-swatch-renamed", "renamed"),
    swatch("legend-swatch-file", "unchanged"),
    swatch("legend-swatch-folder", "folder"),
    swatch("legend-swatch-rest", "more files"),
  );
  return legend;
}

function swatch(className: string, label: string): HTMLElement {
  return append(element("span", "legend-item"), element("span", `legend-swatch ${className}`), label);
}
