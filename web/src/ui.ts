// Static chrome around the map: header, truncation banner and legend.
// Untrusted text (titles, names) only ever goes through textContent.

import type { PullRequestData } from "./decode.ts";
import { append, element, link } from "./dom.ts";
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
    const total = data.pullRequest.changedFiles;
    notes.push(
      shownChangedFiles < total
        ? `GitHub listed ${formatCount(shownChangedFiles)} of ${formatCount(total)} changed files; the rest are not shown.`
        : "GitHub's list of changed files for this pull request is incomplete; some files may be missing.",
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
