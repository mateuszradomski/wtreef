// Methodology: round-trip every non-default value through the URL, check
// that defaults serialize to nothing, and feed malformed input to confirm
// it degrades to defaults instead of throwing. Hidden nodes use a made-up
// path table, with paths chosen to stress the encoding (commas, spaces,
// ampersands, non-ASCII).

import { test } from "node:test";
import assert from "node:assert/strict";
import { FileStatus } from "./decode.ts";
import { FileView } from "./file-tree.ts";
import { HIDDEN_NODES_MAX, HIDDEN_PATH_LENGTH_MAX } from "./hidden.ts";
import { DEFAULT_FILTERS, type Filters, filtersEqual, SizeMode } from "./model.ts";
import { PATH_PATTERN_LENGTH_MAX, parsePathPattern } from "./pattern.ts";
import { DEFAULT_FILE_VIEW, type FilterVocabulary, parseViewQuery, serializeViewQuery, type ViewQuery } from "./query.ts";

// Every status present, so the round trip can hide any of them.
const ALL_STATUSES = (1 << FileStatus.added) | (1 << FileStatus.modified) | (1 << FileStatus.deleted) | (1 << FileStatus.renamed);
/** Node index to path; the root (0) has none. */
const PATHS: readonly string[] = ["", "docs", "packages/frontend/e2e", "README.md", "a,b/c d&e=f.ts", "src/ünïcode+plus.ts"];
const NODE_BY_PATH: ReadonlyMap<string, number> = new Map(PATHS.flatMap((path, node) => (node === 0 ? [] : [[path, node] as const])));
const KNOWN: FilterVocabulary = { typeKeys: new Set(["ts", "md", "(other)"]), statusMask: ALL_STATUSES, nodeByPath: NODE_BY_PATH };

function serialize(query: ViewQuery): string {
  return serializeViewQuery(query, PATHS);
}

function withHidden(nodes: readonly number[]): Filters {
  return { ...DEFAULT_FILTERS, hiddenNodes: new Set(nodes) };
}

test("the default view serializes to an empty query", () => {
  assert.equal(serialize({ filters: DEFAULT_FILTERS, zoomPath: "", fileView: DEFAULT_FILE_VIEW }), "");
  const parsed = parseViewQuery("", KNOWN);
  assert.ok(filtersEqual(parsed.filters, DEFAULT_FILTERS));
  assert.equal(parsed.zoomPath, "");
  assert.equal(parsed.fileView, FileView.tree);
});

test("round-trips every non-default value", () => {
  const query = {
    filters: {
      sizeMode: SizeMode.context,
      hiddenStatuses: (1 << FileStatus.deleted) | (1 << FileStatus.renamed),
      hiddenTypes: new Set(["md", "(other)"]),
      showUnchanged: false,
      showGenerated: false,
      include: parsePathPattern("src/.*\\.tsx?$"),
      exclude: parsePathPattern("test|a+b c/ä,"),
      hiddenNodes: new Set([2, 3]),
    },
    zoomPath: "packages/frontend",
    fileView: FileView.list,
  };
  const text = serialize(query);
  assert.match(text, /^\?size=context&hide=deleted,renamed&hideType=%28other%29,md&unchanged=0&generated=0&include=src\//);
  assert.match(text, /&hidden=packages\/frontend\/e2e&hidden=README\.md&zoom=packages\/frontend&files=list$/);
  const parsed = parseViewQuery(text, KNOWN);
  assert.ok(filtersEqual(parsed.filters, query.filters));
  assert.equal(parsed.zoomPath, query.zoomPath);
  assert.equal(parsed.fileView, FileView.list);
});

test("ignores unknown and invalid values", () => {
  const parsed = parseViewQuery("?size=huge&hide=added,bogus&hideType=rs,ts&unchanged=maybe&zoom=/a/b/&files=grid&extra=1", KNOWN);
  assert.equal(parsed.filters.sizeMode, DEFAULT_FILTERS.sizeMode);
  assert.equal(parsed.filters.hiddenStatuses, 1 << FileStatus.added);
  assert.deepEqual([...parsed.filters.hiddenTypes], ["ts"]);
  assert.equal(parsed.filters.showUnchanged, true);
  assert.equal(parsed.zoomPath, "a/b");
  assert.equal(parsed.fileView, DEFAULT_FILE_VIEW);
});

test("path patterns survive the URL: invalid ones with their text, over-long ones not at all", () => {
  const invalid = parseViewQuery("?include=(&exclude=b", KNOWN);
  assert.equal(invalid.filters.include.kind, "invalid");
  assert.equal(invalid.filters.exclude.kind, "valid");
  assert.equal(serialize({ filters: invalid.filters, zoomPath: "", fileView: DEFAULT_FILE_VIEW }), "?include=%28&exclude=b");
  const overLong = parseViewQuery(`?include=${"a".repeat(PATH_PATTERN_LENGTH_MAX + 1)}`, KNOWN);
  assert.equal(overLong.filters.include.kind, "empty");
});

test("the file view is written only when it is the list", () => {
  assert.equal(parseViewQuery("?files=tree", KNOWN).fileView, FileView.tree);
  assert.equal(parseViewQuery("?files=list", KNOWN).fileView, FileView.list);
  assert.equal(serialize({ filters: DEFAULT_FILTERS, zoomPath: "", fileView: FileView.tree }), "");
  assert.equal(serialize({ filters: DEFAULT_FILTERS, zoomPath: "", fileView: FileView.list }), "?files=list");
});

test("the old substring search parameter is ignored", () => {
  const parsed = parseViewQuery("?q=frontend", KNOWN);
  assert.ok(filtersEqual(parsed.filters, DEFAULT_FILTERS));
});

test("hidden statuses this PR has no files for are dropped", () => {
  const onlyAdditions: FilterVocabulary = { ...KNOWN, statusMask: 1 << FileStatus.added };
  const parsed = parseViewQuery("?hide=added,deleted", onlyAdditions);
  assert.equal(parsed.filters.hiddenStatuses, 1 << FileStatus.added);
});

test("hidden paths round-trip as repeated parameters, in the order they were hidden", () => {
  const query = { filters: withHidden([5, 4, 1]), zoomPath: "", fileView: DEFAULT_FILE_VIEW };
  const text = serialize(query);
  // Commas stay readable, and a comma inside a path does not split it.
  assert.equal(text, "?hidden=src/%C3%BCn%C3%AFcode%2Bplus.ts&hidden=a,b/c+d%26e%3Df.ts&hidden=docs");
  const parsed = parseViewQuery(text, KNOWN);
  assert.deepEqual([...parsed.filters.hiddenNodes], [5, 4, 1]);
  assert.ok(filtersEqual(parsed.filters, query.filters));
  assert.equal(serialize({ ...query, filters: parsed.filters }), text);
});

test("unknown, over-long and repeated hidden paths are dropped; slashes at the ends are ignored", () => {
  const overLong = `docs/${"x".repeat(HIDDEN_PATH_LENGTH_MAX)}`;
  const text = `?hidden=nope&hidden=/docs/&hidden=${overLong}&hidden=docs&hidden=&hidden=README.md&hidden=readme.md`;
  assert.deepEqual([...parseViewQuery(text, KNOWN).filters.hiddenNodes], [1, 3]);
  assert.equal(parseViewQuery("?hidden=nope", KNOWN).filters.hiddenNodes.size, 0);
});

test("a link names at most HIDDEN_NODES_MAX hidden paths; the rest are not read", () => {
  const paths = ["", ...Array.from({ length: HIDDEN_NODES_MAX + 5 }, (_, item) => `file-${item}.ts`)];
  const vocabulary: FilterVocabulary = { ...KNOWN, nodeByPath: new Map(paths.map((path, node) => [path, node] as const).slice(1)) };
  const text = `?${paths.slice(1).map((path) => `hidden=${path}`).join("&")}`;
  const hidden = parseViewQuery(text, vocabulary).filters.hiddenNodes;
  assert.equal(hidden.size, HIDDEN_NODES_MAX);
  assert.ok(hidden.has(HIDDEN_NODES_MAX));
  assert.ok(!hidden.has(HIDDEN_NODES_MAX + 1));
});
