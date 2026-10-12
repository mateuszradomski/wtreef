"use strict";
// Methodology: archives are assembled block by block in the ustar layout npm
// writes, so each case controls exactly which header fields are set.

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { tarEntry, tarballURL } = require("./wtreef.cjs");

const BLOCK = 512;

test("tarEntry steps over pax headers and directories to the wanted file", () => {
  const archive = Buffer.concat([
    entry({ name: "package", type: "5", content: "" }),
    entry({ name: "PaxHeader/wtreef", type: "x", content: "30 path=package/bin/wtreef\n".repeat(30) }),
    entry({ name: "package/bin/other", type: "0", content: "not this" }),
    entry({ name: "package/bin/wtreef", type: "0", content: "binary" }),
    Buffer.alloc(2 * BLOCK),
  ]);
  assert.equal(tarEntry(archive, "package/bin/wtreef").toString(), "binary");
});

test("tarEntry joins the ustar prefix to the name", () => {
  const archive = Buffer.concat([entry({ prefix: "package/bin", name: "wtreef", type: "0", content: "x" }), Buffer.alloc(BLOCK)]);
  assert.equal(tarEntry(archive, "package/bin/wtreef").toString(), "x");
});

test("tarEntry rejects a missing entry and a truncated archive", () => {
  const archive = Buffer.concat([entry({ name: "package/README.md", type: "0", content: "hi" }), Buffer.alloc(BLOCK)]);
  assert.throws(() => tarEntry(archive, "package/bin/wtreef"), /has no package\/bin\/wtreef/);
  const whole = entry({ name: "package/bin/wtreef", type: "0", content: "y".repeat(BLOCK + 1) });
  assert.throws(() => tarEntry(whole.subarray(0, 2 * BLOCK), "package/bin/wtreef"), /truncated/);
});

test("tarballURL follows the registry's scoped tarball path", () => {
  const want = "https://registry.npmjs.org/@wtreef/darwin-arm64/-/darwin-arm64-0.1.2.tgz";
  assert.equal(tarballURL("https://registry.npmjs.org/", "darwin-arm64", "0.1.2"), want);
  assert.equal(tarballURL("https://registry.npmjs.org", "darwin-arm64", "0.1.2"), want);
});

function entry({ prefix = "", name, type, content }) {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, "utf8");
  header.write(Buffer.byteLength(content).toString(8).padStart(11, "0"), 124, 12, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write("ustar\u000000", 257, 8, "ascii");
  header.write(prefix, 345, 155, "utf8");
  const body = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / BLOCK) * BLOCK);
  body.write(content, 0, "utf8");
  return Buffer.concat([header, body]);
}
