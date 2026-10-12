// The header's totals. With no filter taking changed files off the map they
// are the pull request's own, as GitHub reports them (or the branch's, as git does); otherwise they sum the
// changed files still shown, and say so. Zoom is navigation, not filtering,
// so it never changes them, and neither does how tiles are sized.

import { assert } from "./assert.ts";
import type { ChangeSummary, Tree } from "./decode.ts";
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

/** What the totals are the totals of, as the tooltips name it. */
export type TotalsScope = "pullRequest" | "branch";

const SCOPE_NAMES: Readonly<Record<TotalsScope, { readonly whole: string; readonly short: string }>> = {
  pullRequest: { whole: "the whole pull request", short: "Whole PR" },
  branch: { whole: "the whole branch, uncommitted work included", short: "Whole branch" },
};

export function describeHeaderTotals(
  summary: ChangeSummary,
  index: TreeIndex,
  filters: Filters,
  shown: ChangeTotals,
  scope: TotalsScope = "pullRequest",
): HeaderTotals {
  const whole = plural(summary.changedFiles, "file", "files");
  const names = SCOPE_NAMES[scope];
  if (!filtersHideChangedFiles(filters, index)) {
    return {
      additions: summary.additions,
      deletions: summary.deletions,
      files: summary.changedFiles,
      filesText: whole,
      filtered: false,
      description: `Lines added and removed, and files changed, in ${names.whole}.`,
    };
  }
  return {
    ...shown,
    filesText: `${formatCount(shown.files)} of ${whole}`,
    filtered: true,
    description: `Filtered. ${names.short}: ${formatChurn(summary.additions, summary.deletions)} across ${whole}.`,
  };
}
