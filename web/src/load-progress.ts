// What the loading page says about the server's progress: how full the bar
// is and the line under it. Pure, so the shape of the bar is tested apart
// from the DOM.

import { unreachable } from "./assert.ts";
import type { LoadProgress } from "./decode.ts";
import { formatCount, plural } from "./format.ts";

/** The bar's share for changed files; the repository tree fills the rest. */
const FILES_SHARE = 0.5;
/**
 * The tree's size is unknown until it has all been read, so its share fills
 * ever slower: half full at this many files, never complete.
 */
const TREE_ENTRIES_HALF = 20_000;

/** How full the bar is, in 0..1, or null while there is nothing to measure yet. */
export function progressFraction(progress: LoadProgress): number | null {
  switch (progress.stage) {
    case "idle":
    case "pullRequest":
      return null;
    case "files":
      return progress.filesTotal === 0 ? FILES_SHARE : (FILES_SHARE * progress.filesFetched) / progress.filesTotal;
    case "tree":
      return FILES_SHARE + ((1 - FILES_SHARE) * progress.treeEntries) / (progress.treeEntries + TREE_ENTRIES_HALF);
    default:
      return unreachable(progress.stage, "unknown load stage");
  }
}

/** The line under the bar, or null when it should stay as it is. */
export function progressText(progress: LoadProgress): string | null {
  switch (progress.stage) {
    case "idle":
      return null;
    case "pullRequest":
      return "Asking GitHub for the pull request…";
    case "files":
      return `Listing changed files: ${formatCount(progress.filesFetched)} of ${formatCount(progress.filesTotal)}`;
    case "tree":
      return progress.treeEntries === 0
        ? "Reading the repository…"
        : `Reading the repository: ${plural(progress.treeEntries, "file", "files")}`;
    default:
      return unreachable(progress.stage, "unknown load stage");
  }
}
