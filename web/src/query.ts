// View state <-> URL query string, so a shared link reproduces the view.
// Parsing is forgiving by design: unknown keys and invalid values are
// ignored, because links outlive data (a type chip may not exist in a
// different PR) and people edit URLs by hand.

import { assert } from "./assert.ts";
import { FileStatus } from "./decode.ts";
import { DEFAULT_FILTERS, type Filters, SizeMode } from "./model.ts";

export interface ViewQuery {
  readonly filters: Filters;
  /** Path of the zoomed directory; "" is the repository root. */
  readonly zoomPath: string;
}

const PARAMETER = {
  size: "size",
  hiddenStatuses: "hide",
  hiddenTypes: "hideType",
  unchanged: "unchanged",
  generated: "generated",
  search: "q",
  zoom: "zoom",
} as const;

const LIST_SEPARATOR = ",";
const SEARCH_LENGTH_MAX = 200;
const ZOOM_PATH_LENGTH_MAX = 4096;
const LIST_ITEMS_MAX = 64;

const STATUS_NAMES: ReadonlyArray<readonly [FileStatus, string]> = [
  [FileStatus.added, "added"],
  [FileStatus.modified, "modified"],
  [FileStatus.deleted, "deleted"],
  [FileStatus.renamed, "renamed"],
];

export function parseViewQuery(search: string, knownTypeKeys: ReadonlySet<string>): ViewQuery {
  const parameters = new URLSearchParams(search);
  const filters: Filters = {
    sizeMode: parseSizeMode(parameters.get(PARAMETER.size)),
    hiddenStatuses: parseHiddenStatuses(parameters.get(PARAMETER.hiddenStatuses)),
    hiddenTypes: parseHiddenTypes(parameters.get(PARAMETER.hiddenTypes), knownTypeKeys),
    showUnchanged: parameters.get(PARAMETER.unchanged) !== "0",
    showGenerated: parameters.get(PARAMETER.generated) !== "0",
    search: (parameters.get(PARAMETER.search) ?? "").slice(0, SEARCH_LENGTH_MAX),
  };
  return { filters, zoomPath: parseZoomPath(parameters.get(PARAMETER.zoom)) };
}

function parseSizeMode(value: string | null): SizeMode {
  if (value === SizeMode.churn) return SizeMode.churn;
  if (value === SizeMode.context) return SizeMode.context;
  return DEFAULT_FILTERS.sizeMode;
}

function splitList(value: string | null): string[] {
  if (value === null || value === "") return [];
  return value.split(LIST_SEPARATOR).slice(0, LIST_ITEMS_MAX);
}

function parseHiddenStatuses(value: string | null): number {
  let mask = 0;
  for (const item of splitList(value)) {
    const entry = STATUS_NAMES.find(([, name]) => name === item);
    if (entry !== undefined) mask |= 1 << entry[0];
  }
  return mask;
}

function parseHiddenTypes(value: string | null, knownTypeKeys: ReadonlySet<string>): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const item of splitList(value)) {
    if (knownTypeKeys.has(item)) hidden.add(item);
  }
  return hidden;
}

function parseZoomPath(value: string | null): string {
  if (value === null) return "";
  if (value.length > ZOOM_PATH_LENGTH_MAX) return "";
  return value.replace(/^\/+|\/+$/g, "");
}

/** Returns "" for the default view, otherwise "?..." with only non-default values. */
export function serializeViewQuery(query: ViewQuery): string {
  const { filters } = query;
  const parameters = new URLSearchParams();
  if (filters.sizeMode !== DEFAULT_FILTERS.sizeMode) parameters.set(PARAMETER.size, filters.sizeMode);
  const hiddenStatusNames = STATUS_NAMES.filter(([status]) => (filters.hiddenStatuses & (1 << status)) !== 0);
  if (hiddenStatusNames.length > 0) {
    parameters.set(PARAMETER.hiddenStatuses, hiddenStatusNames.map(([, name]) => name).join(LIST_SEPARATOR));
  }
  if (filters.hiddenTypes.size > 0) {
    parameters.set(PARAMETER.hiddenTypes, [...filters.hiddenTypes].sort().join(LIST_SEPARATOR));
  }
  if (!filters.showUnchanged) parameters.set(PARAMETER.unchanged, "0");
  if (!filters.showGenerated) parameters.set(PARAMETER.generated, "0");
  if (filters.search !== "") parameters.set(PARAMETER.search, filters.search);
  if (query.zoomPath !== "") parameters.set(PARAMETER.zoom, query.zoomPath);
  // "/" and "," are legal in a query string; leaving them unescaped keeps shared links readable.
  const text = parameters.toString().replace(/%2F/g, "/").replace(/%2C/g, ",");
  assert(!text.startsWith("?"), "URLSearchParams serializes without a leading ?");
  return text === "" ? "" : `?${text}`;
}
