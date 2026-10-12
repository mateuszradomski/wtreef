// Methodology: round-trip every non-default value through the URL, check
// that defaults serialize to nothing, and feed malformed input to confirm
// it degrades to defaults instead of throwing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FileStatus } from "./decode.ts";
import { DEFAULT_FILTERS, filtersEqual, SizeMode } from "./model.ts";
import { PATH_PATTERN_LENGTH_MAX, parsePathPattern } from "./pattern.ts";
import { parseViewQuery, serializeViewQuery } from "./query.ts";

const KNOWN_TYPES: ReadonlySet<string> = new Set(["ts", "md", "(other)"]);

test("the default view serializes to an empty query", () => {
  assert.equal(serializeViewQuery({ filters: DEFAULT_FILTERS, zoomPath: "" }), "");
  const parsed = parseViewQuery("", KNOWN_TYPES);
  assert.ok(filtersEqual(parsed.filters, DEFAULT_FILTERS));
  assert.equal(parsed.zoomPath, "");
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
  };
  const text = serializeViewQuery(query);
  assert.match(text, /^\?size=context&hide=deleted,renamed&hideType=%28other%29,md&unchanged=0&generated=0&include=src\//);
  assert.match(text, /zoom=packages\/frontend$/);
  const parsed = parseViewQuery(text, KNOWN_TYPES);
  assert.ok(filtersEqual(parsed.filters, query.filters));
  assert.equal(parsed.zoomPath, query.zoomPath);
});

test("ignores unknown and invalid values", () => {
  const parsed = parseViewQuery("?size=huge&hide=added,bogus&hideType=rs,ts&unchanged=maybe&zoom=/a/b/&extra=1", KNOWN_TYPES);
  assert.equal(parsed.filters.sizeMode, DEFAULT_FILTERS.sizeMode);
  assert.equal(parsed.filters.hiddenStatuses, 1 << FileStatus.added);
  assert.deepEqual([...parsed.filters.hiddenTypes], ["ts"]);
  assert.equal(parsed.filters.showUnchanged, true);
  assert.equal(parsed.zoomPath, "a/b");
});

test("path patterns survive the URL: invalid ones with their text, over-long ones not at all", () => {
  const invalid = parseViewQuery("?include=(&exclude=b", KNOWN_TYPES);
  assert.equal(invalid.filters.include.kind, "invalid");
  assert.equal(invalid.filters.exclude.kind, "valid");
  assert.equal(serializeViewQuery({ filters: invalid.filters, zoomPath: "" }), "?include=%28&exclude=b");
  const overLong = parseViewQuery(`?include=${"a".repeat(PATH_PATTERN_LENGTH_MAX + 1)}`, KNOWN_TYPES);
  assert.equal(overLong.filters.include.kind, "empty");
});

test("the old substring search parameter is ignored", () => {
  const parsed = parseViewQuery("?q=frontend", KNOWN_TYPES);
  assert.ok(filtersEqual(parsed.filters, DEFAULT_FILTERS));
});
