// Methodology: table-driven checks of the path grammar from the contract and
// of the inputs the landing page accepts, including near-misses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePullRequestInput, parseRoute, pullRequestPath } from "./route.ts";

test("routes the landing page and pull request pages", () => {
  assert.deepEqual(parseRoute("/"), { kind: "landing" });
  assert.deepEqual(parseRoute("/l2beat/l2beat/pull/13157"), {
    kind: "pullRequest",
    reference: { owner: "l2beat", repo: "l2beat", number: 13157 },
  });
  assert.equal(parseRoute("/l2beat/l2beat/pull/13157/files").kind, "pullRequest");
  assert.equal(parseRoute("/l2beat/l2beat/pull/13157/").kind, "pullRequest");
});

test("rejects paths outside the grammar", () => {
  const rejected = [
    "/l2beat",
    "/l2beat/l2beat/pulls/1",
    "/l2beat/l2beat/pull/0",
    "/l2beat/l2beat/pull/01",
    "/l2beat/l2beat/pull/+1",
    "/l2beat/l2beat/pull/2147483648",
    "/-l2beat/l2beat/pull/1",
    "/l2beat-/l2beat/pull/1",
    "/l2beat/../pull/1",
    "/l2beat/./pull/1",
    "/l2b_eat/l2beat/pull/1",
    `/${"a".repeat(40)}/r/pull/1`,
    `/o/${"r".repeat(101)}/pull/1`,
  ];
  for (const pathname of rejected) {
    assert.equal(parseRoute(pathname).kind, "notFound", pathname);
  }
  assert.equal(parseRoute(`/${"a".repeat(39)}/${"r".repeat(100)}/pull/2147483647`).kind, "pullRequest");
});

test("accepts pasted pull request references", () => {
  const expected = { owner: "l2beat", repo: "l2beat", number: 13157 };
  const accepted = [
    "https://github.com/l2beat/l2beat/pull/13157",
    "https://github.com/l2beat/l2beat/pull/13157/files",
    "https://github.com/l2beat/l2beat/pull/13157/files?w=1#diff-abc",
    "https://github.com/l2beat/l2beat/pull/13157#issuecomment-1",
    "http://www.github.com/l2beat/l2beat/pull/13157",
    "github.com/l2beat/l2beat/pull/13157",
    "https://wtreef.com/l2beat/l2beat/pull/13157",
    "l2beat/l2beat/pull/13157",
    "  l2beat/l2beat#13157  ",
  ];
  for (const input of accepted) {
    assert.deepEqual(parsePullRequestInput(input), expected, input);
  }
});

test("accepts pasted URLs from the host serving the page", () => {
  const expected = { owner: "l2beat", repo: "l2beat", number: 13157 };
  const input = "https://wtreef.example.com/l2beat/l2beat/pull/13157";
  assert.deepEqual(parsePullRequestInput(input, "wtreef.example.com"), expected);
  assert.equal(parsePullRequestInput(input), null);
});

test("rejects pasted text that is not a pull request", () => {
  const rejected = [
    "",
    "l2beat",
    "l2beat/l2beat",
    "https://github.com/l2beat/l2beat",
    "https://github.com/l2beat/l2beat/issues/1",
    "https://gitlab.com/l2beat/l2beat/pull/1",
    "l2beat/l2beat#0",
    "l2beat/l2beat#abc",
  ];
  for (const input of rejected) {
    assert.equal(parsePullRequestInput(input), null, input);
  }
});

test("builds the canonical page path", () => {
  assert.equal(pullRequestPath({ owner: "o", repo: "r", number: 7 }), "/o/r/pull/7");
});
