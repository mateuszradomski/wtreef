// The header's totals. With no filter taking changed files off the map they
// are the pull request's own, as GitHub reports them; otherwise they sum the
// changed files still shown, and say so. Zoom is navigation, not filtering,
// so it never changes them, and neither does how tiles are sized.

import { assert } from "./assert.ts";
import type { PullRequest, Tree } from "./decode.ts";
import { formatChurn, formatCount, plural } from "./format.ts";
import type { Filters, TreeIndex } from "./model.ts";
import { activeRegex } from "./pattern.ts";

export interface ChangeTotals {
  readonly additions: number;
  readonly deletions: number;
  readonly files: number;
}

export interface HeaderTotals extends ChangeTotals {
  /** "93 files", or "14 of 93 files" when filtered. */
  readonly filesText: string;
  readonly filtered: boolean;
  /** What the numbers are, for the tooltip. */
  readonly description: string;
}

/**
 * True when some filter can take a changed file off the map. Size mode and
 * Unchanged only decide how unchanged files are drawn, and an invalid
 * pattern is ignored, so none of them count. Neither does hiding unchanged
 * context, for the same reason as Unchanged: only hidden nodes with a
 * changed file below them count.
 */
export function filtersHideChangedFiles(filters: Filters, index: TreeIndex): boolean {
  if (filters.hiddenStatuses !== 0) return true;
  if (filters.hiddenTypes.size > 0) return true;
  if (!filters.showGenerated) return true;
  if (activeRegex(filters.include) !== null) return true;
  if (activeRegex(filters.exclude) !== null) return true;
  for (const node of filters.hiddenNodes) {
    if ((index.subtreeChangedFiles[node] ?? 0) > 0) return true;
  }
  return false;
}

/** Sums the changed files that pass the filters: those that weigh something. Weights never depend on the zoom. */
export function sumShownChanges(tree: Tree, index: TreeIndex, weights: Float64Array): ChangeTotals {
  assert(weights.length === tree.nodeCount, "weights must be sized for this tree");
  let additions = 0;
  let deletions = 0;
  let files = 0;
  for (const node of index.changedFiles) {
    if ((weights[node] ?? 0) <= 0) continue;
    additions += tree.additions[node] ?? 0;
    deletions += tree.deletions[node] ?? 0;
    files++;
  }
  assert(files <= index.changedFiles.length, "shown files are a subset of the changed files");
  return { additions, deletions, files };
}

export function describeHeaderTotals(pullRequest: PullRequest, index: TreeIndex, filters: Filters, shown: ChangeTotals): HeaderTotals {
  const whole = plural(pullRequest.changedFiles, "file", "files");
  if (!filtersHideChangedFiles(filters, index)) {
    return {
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
      files: pullRequest.changedFiles,
      filesText: whole,
      filtered: false,
      description: "Lines added and removed, and files changed, in the whole pull request.",
    };
  }
  return {
    ...shown,
    filesText: `${formatCount(shown.files)} of ${whole}`,
    filtered: true,
    description: `Filtered. Whole PR: ${formatChurn(pullRequest.additions, pullRequest.deletions)} across ${whole}.`,
  };
}
