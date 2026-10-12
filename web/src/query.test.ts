// Methodology: round-trip every non-default value through the URL, check
// that defaults serialize to nothing, and feed malformed input to confirm
// it degrades to defaults instead of throwing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FileStatus } from "./decode.ts";
import { FileView } from "./file-tree.ts";
import { DEFAULT_FILTERS, filtersEqual, SizeMode } from "./model.ts";
import { PATH_PATTERN_LENGTH_MAX, parsePathPattern } from "./pattern.ts";
import { DEFAULT_FILE_VIEW, type FilterVocabulary, parseViewQuery, serializeViewQuery } from "./query.ts";

// Every status present, so the round trip can hide any of them.
const ALL_STATUSES = (1 << FileStatus.added) | (1 << FileStatus.modified) | (1 << FileStatus.deleted) | (1 << FileStatus.renamed);
const KNOWN: FilterVocabulary = { typeKeys: new Set(["ts", "md", "(other)"]), statusMask: ALL_STATUSES };

test("the default view serializes to an empty query", () => {
  assert.equal(serializeViewQuery({ filters: DEFAULT_FILTERS, zoomPath: "", fileView: DEFAULT_FILE_VIEW }), "");
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
    },
    zoomPath: "packages/frontend",
    fileView: FileView.list,
  };
  const text = serializeViewQuery(query);
  assert.match(text, /^\?size=context&hide=deleted,renamed&hideType=%28other%29,md&unchanged=0&generated=0&include=src\//);
  assert.match(text, /zoom=packages\/frontend&files=list$/);
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
  assert.equal(serializeViewQuery({ filters: invalid.filters, zoomPath: "", fileView: DEFAULT_FILE_VIEW }), "?include=%28&exclude=b");
  const overLong = parseViewQuery(`?include=${"a".repeat(PATH_PATTERN_LENGTH_MAX + 1)}`, KNOWN);
  assert.equal(overLong.filters.include.kind, "empty");
});

test("the file view is written only when it is the list", () => {
  assert.equal(parseViewQuery("?files=tree", KNOWN).fileView, FileView.tree);
  assert.equal(parseViewQuery("?files=list", KNOWN).fileView, FileView.list);
  assert.equal(serializeViewQuery({ filters: DEFAULT_FILTERS, zoomPath: "", fileView: FileView.tree }), "");
  assert.equal(serializeViewQuery({ filters: DEFAULT_FILTERS, zoomPath: "", fileView: FileView.list }), "?files=list");
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
