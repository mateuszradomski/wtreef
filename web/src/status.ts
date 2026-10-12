// Display vocabulary for file statuses, shared by chips, list rows and tooltips.

import { FileStatus } from "./decode.ts";

/** Order of status chips: the order a reviewer thinks in. */
export const CHANGED_STATUSES: readonly FileStatus[] = [
  FileStatus.added,
  FileStatus.modified,
  FileStatus.deleted,
  FileStatus.renamed,
];

const LABELS: Readonly<Record<FileStatus, string>> = {
  [FileStatus.unchanged]: "Unchanged",
  [FileStatus.added]: "Added",
  [FileStatus.modified]: "Modified",
  [FileStatus.deleted]: "Deleted",
  [FileStatus.renamed]: "Renamed",
};

/** What each status means, in the words of someone reading the PR. */
const DESCRIPTIONS: Readonly<Record<FileStatus, string>> = {
  [FileStatus.unchanged]: "Files this PR does not touch.",
  [FileStatus.added]: "Files this PR creates.",
  [FileStatus.modified]: "Files this PR edits.",
  [FileStatus.deleted]: "Files this PR removes. With no size left, Context sizes them by lines removed.",
  [FileStatus.renamed]: "Files this PR moves or renames, with or without edits.",
};

const LETTERS: Readonly<Record<FileStatus, string>> = {
  [FileStatus.unchanged]: "",
  [FileStatus.added]: "A",
  [FileStatus.modified]: "M",
  [FileStatus.deleted]: "D",
  [FileStatus.renamed]: "R",
};

/** CSS class carrying the status color tokens (see style.css). */
const CLASS_NAMES: Readonly<Record<FileStatus, string>> = {
  [FileStatus.unchanged]: "status-unchanged",
  [FileStatus.added]: "status-added",
  [FileStatus.modified]: "status-modified",
  [FileStatus.deleted]: "status-deleted",
  [FileStatus.renamed]: "status-renamed",
};

export function statusOf(value: number): FileStatus {
  if (value === FileStatus.added) return FileStatus.added;
  if (value === FileStatus.modified) return FileStatus.modified;
  if (value === FileStatus.deleted) return FileStatus.deleted;
  if (value === FileStatus.renamed) return FileStatus.renamed;
  return FileStatus.unchanged;
}

export function statusLabel(status: FileStatus): string {
  return LABELS[status];
}

export function statusDescription(status: FileStatus): string {
  return DESCRIPTIONS[status];
}

export function statusLetter(status: FileStatus): string {
  return LETTERS[status];
}

export function statusClassName(status: FileStatus): string {
  return CLASS_NAMES[status];
}
