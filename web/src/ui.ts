// Chrome around the map: header, truncation banner and legend. Only the
// header's totals change after mount. Untrusted text (titles, names) only
// ever goes through textContent.

import { setTooltip } from "./control-tooltip.ts";
import type { Branch, PullRequest, TreemapData } from "./decode.ts";
import { append, element, link } from "./dom.ts";
import { formatAdditions, formatCount, formatDeletions } from "./format.ts";
import type { HeaderTotals } from "./totals.ts";

export interface Header {
  readonly root: HTMLElement;
  /** The dot, the line counts and the file count: what the totals tooltip describes. */
  readonly totals: HTMLElement;
  readonly filteredMark: HTMLElement;
  readonly additions: HTMLElement;
  readonly deletions: HTMLElement;
  readonly files: HTMLElement;
}

/** The totals start empty; syncHeaderTotals fills them. */
export function createHeader(data: TreemapData): Header {
  const root = element("header", "pr-header");
  const brand = link("brand", "/", "wtreef", false);
  const identity = data.kind === "pullRequest" ? createPullRequestIdentity(data.pullRequest) : createBranchIdentity(data.branch);

  const stats = element("div", "pr-stats mono");
  const filteredMark = element("span", "pr-filtered-mark");
  filteredMark.setAttribute("role", "img");
  filteredMark.setAttribute("aria-label", "Filtered:");
  filteredMark.hidden = true;
  const additions = element("span", "pr-additions");
  const deletions = element("span", "pr-deletions");
  const files = element("span", "pr-files");
  const totals = append(element("span", "pr-totals"), filteredMark, append(element("span", "pr-churn"), additions, " ", deletions), files);
  totals.tabIndex = 0;
  stats.append(totals);
  if (data.kind === "pullRequest") {
    const github = link("pr-github", data.pullRequest.url, "GitHub ↗", true);
    github.setAttribute("aria-label", "Open the pull request on GitHub");
    setTooltip(github, "Open this pull request on GitHub, in a new tab.");
    stats.append(github);
  }

  append(root, brand, identity, stats);
  return { root, totals, filteredMark, additions, deletions, files };
}

function createPullRequestIdentity(pullRequest: PullRequest): HTMLElement {
  const identity = element("div", "pr-identity");
  const repository = element("span", "pr-repo", `${pullRequest.owner}/${pullRequest.repo}`);
  const number = element("span", "pr-number", `#${pullRequest.number}`);
  const title = element("span", "pr-title", pullRequest.title);
  // The title is cut to fit the bar; the tooltip has all of it.
  setTooltip(title, pullRequest.title);
  const state = element("span", `pr-state pr-state-${pullRequest.state}`, pullRequest.state);
  setTooltip(state, describeState(pullRequest));
  // Focusable so keyboard users can read what it means, as hover readers can.
  state.tabIndex = 0;
  return append(identity, repository, number, title, state);
}

const SHORT_SHA_LENGTH = 7;

/** "repo  branch  vs origin/main  [uncommitted]". */
function createBranchIdentity(branch: Branch): HTMLElement {
  const identity = element("div", "pr-identity");
  const repository = element("span", "pr-repo", branch.repo);
  const headLabel = branch.headRef === "" ? `HEAD ${branch.headSha.slice(0, SHORT_SHA_LENGTH)}` : branch.headRef;
  const head = element("span", "pr-title mono", headLabel);
  setTooltip(head, branch.headRef === "" ? "HEAD is detached: no branch is checked out." : headLabel);
  const base = element("span", "pr-number", `vs ${branch.baseRef}`);
  setTooltip(
    base,
    `Compared with commit ${branch.baseSha.slice(0, SHORT_SHA_LENGTH)}, where this branch left ${branch.baseRef}. Start wtreef with -base to compare with something else.`,
  );
  base.tabIndex = 0;
  append(identity, repository, head, base);
  if (branch.uncommitted) {
    const state = element("span", "pr-state pr-state-uncommitted", "uncommitted");
    setTooltip(state, "Includes work not committed yet: staged, unstaged and new files. Reload the page to see the latest.");
    state.tabIndex = 0;
    identity.append(state);
  }
  return identity;
}

export function syncHeaderTotals(header: Header, totals: HeaderTotals): void {
  header.filteredMark.hidden = !totals.filtered;
  header.additions.textContent = formatAdditions(totals.additions);
  header.deletions.textContent = formatDeletions(totals.deletions);
  header.files.textContent = totals.filesText;
  setTooltip(header.totals, totals.description);
}

function describeState(pullRequest: PullRequest): string {
  if (pullRequest.state === "merged") return `Merged into ${pullRequest.baseRef}.`;
  if (pullRequest.state === "open") return `Open: not merged into ${pullRequest.baseRef} yet.`;
  return "Closed without being merged.";
}

/** Null when GitHub gave us everything; otherwise says what is missing and why. */
export function createTruncationBanner(data: TreemapData, shownChangedFiles: number): HTMLElement | null {
  if (data.kind === "branch") return null;
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
  legend.setAttribute("role", "group");
  legend.setAttribute("aria-label", "Legend");
  const ramp = append(
    element("span", "legend-ramp-group"),
    element("span", "legend-end", "deleted"),
    element("span", "legend-ramp"),
    element("span", "legend-end", "added"),
  );
  describeLegendItem(ramp, "Color: share of added vs removed lines. Brightness: how many lines changed.", "");
  append(
    legend,
    ramp,
    swatch("legend-swatch-renamed", "renamed", "A file moved or renamed with no lines changed.", ""),
    swatch("legend-swatch-file", "unchanged", "A file this PR does not touch.", CONTEXT_ONLY),
    swatch("legend-swatch-folder", "folder", "An unchanged folder, drawn as one tile.", CONTEXT_ONLY),
    swatch("legend-swatch-rest", "more files", "The rest of a folder's unchanged files, too small to draw one by one.", CONTEXT_ONLY),
  );
  return legend;
}

const CONTEXT_ONLY = "Only Context draws these.";

function swatch(className: string, label: string, description: string, note: string): HTMLElement {
  const item = append(element("span", "legend-item"), element("span", `legend-swatch ${className}`), label);
  describeLegendItem(item, description, note);
  return item;
}

/** Legend entries are text, so each is a Tab stop of its own: the tooltip is how keyboard users read it too. */
function describeLegendItem(item: HTMLElement, description: string, note: string): void {
  setTooltip(item, description, note);
  item.tabIndex = 0;
}
