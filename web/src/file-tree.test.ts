// Methodology: a hand-written tree small enough to state every expected row
// as indented text (folders end in "/", closed ones are marked), checked
// under filters, zoom and collapsed sets, and against the keys of the
// WAI-ARIA tree view pattern. Trees are built from paths and go
// through the real decoder, so they honor the wire contract. Then property
// checks on the real fixture: every visible changed file appears exactly
// once, levels and parents agree, siblings are ordered, and no row is a
// folder whose only visible child is a folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePullRequestData, FileStatus, NodeKind, type Tree } from "./decode.ts";
import {
  computeFileTree,
  createFileTree,
  type FileTree,
  isFolderRow,
  NO_ROW,
  rowForHoveredNode,
  rowLabel,
  treeKeyAction,
  TreeKeyKind,
  withFolderExpanded,
} from "./file-tree.ts";
import { buildTreeIndex, computeWeights, DEFAULT_FILTERS, type Filters, type TreeIndex } from "./model.ts";
import { parsePathPattern } from "./pattern.ts";
import { loadFixtureJson, REAL_FIXTURE, TINY_FIXTURE } from "./test-support.ts";

interface Leaf {
  readonly path: string;
  readonly kind: NodeKind;
  readonly status: FileStatus;
  readonly additions: number;
  readonly deletions: number;
}

function changed(path: string, status: FileStatus, additions: number, deletions: number): Leaf {
  return { path, kind: NodeKind.file, status, additions, deletions };
}

function context(path: string, kind: NodeKind): Leaf {
  return { path, kind, status: FileStatus.unchanged, additions: 0, deletions: 0 };
}

const LEAVES: readonly Leaf[] = [
  changed("packages/frontend/src/App.tsx", FileStatus.modified, 10, 2),
  changed("packages/frontend/src/components/Button.tsx", FileStatus.added, 40, 0),
  changed("packages/frontend/src/components/card.tsx", FileStatus.added, 20, 0),
  changed("packages/frontend/src/components/Dialog.tsx", FileStatus.modified, 3, 4),
  changed("packages/frontend/src/zeta.ts", FileStatus.deleted, 0, 30),
  changed("packages/frontend/src/Alpha.ts", FileStatus.modified, 1, 1),
  context("packages/frontend/README.md", NodeKind.file),
  changed("packages/backend/server.ts", FileStatus.modified, 5, 5),
  context("packages/backend/vendor", NodeKind.collapsedDirectory),
  changed("docs/guide.md", FileStatus.added, 7, 0),
  context("LICENSE", NodeKind.file),
];

/** Parents first: every folder on a path is created before anything inside it. */
function buildTree(leaves: readonly Leaf[]): Tree {
  const columns = { names: [""], parents: [-1], kinds: [0], statuses: [0], bytes: [0], additions: [0], deletions: [0], fileCounts: [0] };
  const folderByPath = new Map<string, number>([["", 0]]);
  const push = (name: string, parent: number, leaf: Leaf | null): number => {
    columns.names.push(name);
    columns.parents.push(parent);
    columns.kinds.push(leaf === null ? NodeKind.directory : leaf.kind);
    columns.statuses.push(leaf === null ? 0 : leaf.status);
    columns.bytes.push(leaf === null ? 0 : 100);
    columns.additions.push(leaf === null ? 0 : leaf.additions);
    columns.deletions.push(leaf === null ? 0 : leaf.deletions);
    columns.fileCounts.push(leaf === null ? 0 : 1);
    return columns.names.length - 1;
  };
  for (const leaf of leaves) {
    const segments = leaf.path.split("/");
    let parent = 0;
    for (let depth = 0; depth < segments.length - 1; depth++) {
      const folderPath = segments.slice(0, depth + 1).join("/");
      const existing = folderByPath.get(folderPath);
      parent = existing ?? push(segments[depth] ?? "", parent, null);
      folderByPath.set(folderPath, parent);
    }
    push(segments[segments.length - 1] ?? "", parent, leaf);
  }
  const json = loadFixtureJson(TINY_FIXTURE);
  json["tree"] = columns;
  return decodePullRequestData(json).tree;
}

interface Scenario {
  readonly tree: Tree;
  readonly index: TreeIndex;
  readonly fileTree: FileTree;
  readonly nodeOf: (path: string) => number;
}

function createScenario(leaves: readonly Leaf[]): Scenario {
  const tree = buildTree(leaves);
  const index = buildTreeIndex(tree);
  const nodeOf = (path: string): number => {
    const node = index.paths.indexOf(path);
    assert.ok(node >= 0, `no node at ${path}`);
    return node;
  };
  return { tree, index, fileTree: createFileTree(tree, index), nodeOf };
}

function compute(scenario: Scenario, filters: Filters, rootNode: number, collapsed: ReadonlySet<number>): void {
  const weights = new Float64Array(scenario.tree.nodeCount);
  computeWeights(scenario.tree, scenario.index, filters, weights);
  computeFileTree(scenario.tree, scenario.index, weights, rootNode, collapsed, scenario.fileTree);
}

/** One line per row: indented by level, folders end in "/", closed folders say so. */
function describeRows(scenario: Scenario): string[] {
  const { tree, fileTree } = scenario;
  const lines: string[] = [];
  for (let row = 0; row < fileTree.rowCount; row++) {
    const indent = "  ".repeat((fileTree.rowLevels[row] ?? 1) - 1);
    const label = rowLabel(tree, fileTree, row);
    if (!isFolderRow(tree, fileTree, row)) {
      lines.push(`${indent}${label}`);
    } else {
      lines.push(`${indent}${label}/${fileTree.rowExpanded[row] === 1 ? "" : " (closed)"}`);
    }
  }
  return lines;
}

function rowOfPath(scenario: Scenario, path: string): number {
  return scenario.fileTree.rowOfNode[scenario.nodeOf(path)] ?? NO_ROW;
}

const NOTHING_COLLAPSED: ReadonlySet<number> = new Set();

test("folders come first, then files, each in case-insensitive name order", () => {
  const scenario = createScenario(LEAVES);
  compute(scenario, DEFAULT_FILTERS, 0, NOTHING_COLLAPSED);
  assert.deepEqual(describeRows(scenario), [
    "docs/",
    "  guide.md",
    "packages/",
    "  backend/",
    "    server.ts",
    "  frontend/src/",
    "    components/",
    "      Button.tsx",
    "      card.tsx",
    "      Dialog.tsx",
    "    Alpha.ts",
    "    App.tsx",
    "    zeta.ts",
  ]);
});

test("chains merge on visible children only, so filters can lengthen them", () => {
  const scenario = createScenario(LEAVES);
  compute(scenario, { ...DEFAULT_FILTERS, hiddenStatuses: 1 << FileStatus.modified }, 0, NOTHING_COLLAPSED);
  assert.deepEqual(describeRows(scenario), [
    "docs/",
    "  guide.md",
    "packages/frontend/src/",
    "  components/",
    "    Button.tsx",
    "    card.tsx",
    "  zeta.ts",
  ]);
  compute(scenario, { ...DEFAULT_FILTERS, include: parsePathPattern("components/") }, 0, NOTHING_COLLAPSED);
  assert.deepEqual(describeRows(scenario), ["packages/frontend/src/components/", "  Button.tsx", "  card.tsx", "  Dialog.tsx"]);
  const chainRow = rowOfPath(scenario, "packages/frontend/src/components");
  assert.equal(rowOfPath(scenario, "packages"), chainRow, "every folder of a chain maps to its row");
  assert.equal(scenario.fileTree.rowChainTops[chainRow], scenario.nodeOf("packages"));
  assert.equal(scenario.fileTree.rowNodes[chainRow], scenario.nodeOf("packages/frontend/src/components"));
});

test("folder rows sum the lines and count the files that pass the filters", () => {
  const scenario = createScenario(LEAVES);
  const { fileTree, nodeOf } = scenario;
  compute(scenario, DEFAULT_FILTERS, 0, NOTHING_COLLAPSED);
  const source = nodeOf("packages/frontend/src");
  assert.deepEqual([fileTree.visibleAdditions[source], fileTree.visibleDeletions[source], fileTree.visibleFiles[source]], [74, 37, 6]);
  const packages = nodeOf("packages");
  assert.deepEqual([fileTree.visibleAdditions[packages], fileTree.visibleDeletions[packages], fileTree.visibleFiles[packages]], [79, 42, 7]);
  assert.equal(fileTree.visibleFiles[0], 8);
  compute(scenario, { ...DEFAULT_FILTERS, exclude: parsePathPattern("\\.tsx$") }, 0, NOTHING_COLLAPSED);
  assert.deepEqual([fileTree.visibleAdditions[source], fileTree.visibleDeletions[source], fileTree.visibleFiles[source]], [1, 31, 2]);
  assert.equal(fileTree.visibleFiles[nodeOf("packages/frontend/src/components")], 0);
  assert.equal(rowOfPath(scenario, "packages/frontend/src/components"), NO_ROW, "a folder with no visible files is not shown");
  assert.equal(fileTree.visibleFiles[nodeOf("packages/backend/vendor")], 0, "context is never part of the tree");
});

test("rows carry their level, parent, and place among their siblings", () => {
  const scenario = createScenario(LEAVES);
  const { fileTree } = scenario;
  compute(scenario, DEFAULT_FILTERS, 0, NOTHING_COLLAPSED);
  const packages = rowOfPath(scenario, "packages");
  const frontend = rowOfPath(scenario, "packages/frontend/src");
  const zeta = rowOfPath(scenario, "packages/frontend/src/zeta.ts");
  assert.deepEqual([fileTree.rowLevels[packages], fileTree.rowParents[packages], fileTree.rowPositions[packages], fileTree.rowSetSizes[packages]], [1, NO_ROW, 2, 2]);
  assert.deepEqual([fileTree.rowLevels[frontend], fileTree.rowParents[frontend], fileTree.rowPositions[frontend], fileTree.rowSetSizes[frontend]], [2, packages, 2, 2]);
  assert.deepEqual([fileTree.rowLevels[zeta], fileTree.rowParents[zeta], fileTree.rowPositions[zeta], fileTree.rowSetSizes[zeta]], [3, frontend, 4, 4]);
});

test("a closed folder hides its descendants, and a closed folder inside a chain closes the chain", () => {
  const scenario = createScenario(LEAVES);
  const { tree, nodeOf } = scenario;
  const closed = withFolderExpanded(NOTHING_COLLAPSED, tree, nodeOf("packages/frontend"), nodeOf("packages/frontend/src"), false);
  assert.deepEqual([...closed], [nodeOf("packages/frontend/src")], "closing marks the chain's end");
  compute(scenario, DEFAULT_FILTERS, 0, closed);
  assert.deepEqual(describeRows(scenario), ["docs/", "  guide.md", "packages/", "  backend/", "    server.ts", "  frontend/src/ (closed)"]);
  compute(scenario, { ...DEFAULT_FILTERS, hiddenStatuses: 1 << FileStatus.modified }, 0, closed);
  assert.deepEqual(describeRows(scenario), ["docs/", "  guide.md", "packages/frontend/src/ (closed)"]);
  const opened = withFolderExpanded(closed, tree, nodeOf("packages"), nodeOf("packages/frontend/src"), true);
  assert.equal(opened.size, 0, "opening clears every folder of the chain");
  assert.equal(closed.size, 1, "the previous set is not modified");
});

test("hovered tiles map to their row, or to the closed folder that hides them", () => {
  const scenario = createScenario(LEAVES);
  const { tree, fileTree, nodeOf } = scenario;
  const closed = new Set([nodeOf("packages/frontend/src")]);
  compute(scenario, DEFAULT_FILTERS, 0, closed);
  const chainRow = rowOfPath(scenario, "packages/frontend/src");
  assert.equal(rowForHoveredNode(tree, fileTree, nodeOf("packages/frontend/src/components/card.tsx")), chainRow);
  assert.equal(rowForHoveredNode(tree, fileTree, nodeOf("packages/frontend/src/components")), chainRow);
  assert.equal(rowForHoveredNode(tree, fileTree, nodeOf("packages/frontend")), chainRow);
  assert.equal(rowForHoveredNode(tree, fileTree, nodeOf("docs/guide.md")), rowOfPath(scenario, "docs/guide.md"));
  assert.equal(rowForHoveredNode(tree, fileTree, nodeOf("packages/frontend/README.md")), NO_ROW, "unchanged files have no row");
  assert.equal(rowForHoveredNode(tree, fileTree, nodeOf("packages/backend/vendor")), NO_ROW, "context folders have no row");
  assert.equal(rowForHoveredNode(tree, fileTree, -1), NO_ROW);
  compute(scenario, { ...DEFAULT_FILTERS, include: parsePathPattern("docs") }, 0, closed);
  assert.equal(rowForHoveredNode(tree, fileTree, nodeOf("packages/backend/server.ts")), NO_ROW, "filtered-out files have no row");
});

test("a zoomed folder roots the tree, and its own chain starts below it", () => {
  const scenario = createScenario(LEAVES);
  const { fileTree, nodeOf } = scenario;
  compute(scenario, DEFAULT_FILTERS, nodeOf("packages"), NOTHING_COLLAPSED);
  assert.deepEqual(describeRows(scenario), [
    "backend/",
    "  server.ts",
    "frontend/src/",
    "  components/",
    "    Button.tsx",
    "    card.tsx",
    "    Dialog.tsx",
    "  Alpha.ts",
    "  App.tsx",
    "  zeta.ts",
  ]);
  assert.equal(rowOfPath(scenario, "docs/guide.md"), NO_ROW, "nothing outside the zoomed folder is shown");
  compute(scenario, DEFAULT_FILTERS, nodeOf("packages/frontend"), NOTHING_COLLAPSED);
  assert.deepEqual(describeRows(scenario).slice(0, 2), ["src/", "  components/"]);
  assert.equal(rowForHoveredNode(scenario.tree, fileTree, nodeOf("packages/frontend")), NO_ROW, "the root itself has no row");
});

test("a folder hidden by the filters keeps its state until it is shown again", () => {
  const scenario = createScenario(LEAVES);
  const { tree, nodeOf } = scenario;
  const backend = nodeOf("packages/backend");
  const closed = withFolderExpanded(NOTHING_COLLAPSED, tree, backend, backend, false);
  compute(scenario, { ...DEFAULT_FILTERS, hiddenStatuses: 1 << FileStatus.modified }, 0, closed);
  assert.equal(rowOfPath(scenario, "packages/backend"), NO_ROW);
  compute(scenario, DEFAULT_FILTERS, 0, closed);
  assert.deepEqual(describeRows(scenario).slice(2, 5), ["packages/", "  backend/ (closed)", "  frontend/src/"]);
});

function checkRowProperties(scenario: Scenario): void {
  const { tree, fileTree } = scenario;
  const seenFiles = new Set<number>();
  for (let row = 0; row < fileTree.rowCount; row++) {
    const node = fileTree.rowNodes[row] ?? 0;
    const parent = fileTree.rowParents[row] ?? NO_ROW;
    assert.ok(parent < row, "parents precede children");
    assert.equal(fileTree.rowLevels[row], parent === NO_ROW ? 1 : (fileTree.rowLevels[parent] ?? 0) + 1);
    assert.ok((fileTree.visibleFiles[node] ?? 0) > 0, "every row shows something visible");
    if (isFolderRow(tree, fileTree, row)) {
      checkChainEnd(scenario, node);
    } else {
      assert.ok(!seenFiles.has(node), "a file appears once");
      seenFiles.add(node);
    }
    const next = row + 1;
    if (next < fileTree.rowCount && fileTree.rowParents[next] === parent) checkSiblingOrder(scenario, row, next);
  }
  assert.equal(seenFiles.size, fileTree.visibleFiles[fileTree.rootNode], "every visible file below the root has a row");
}

/** A chain ends where a folder has several visible children or a visible file. */
function checkChainEnd(scenario: Scenario, node: number): void {
  const { tree, fileTree } = scenario;
  const visibleChildren: number[] = [];
  for (let cursor = fileTree.childStart[node] ?? 0; cursor < (fileTree.childStart[node + 1] ?? 0); cursor++) {
    const child = fileTree.childIndices[cursor] ?? 0;
    if ((fileTree.visibleFiles[child] ?? 0) > 0) visibleChildren.push(child);
  }
  const only = visibleChildren[0] ?? 0;
  assert.ok(visibleChildren.length > 1 || tree.kinds[only] !== NodeKind.directory, "chains run to their end");
}

function checkSiblingOrder(scenario: Scenario, row: number, next: number): void {
  const { tree, fileTree } = scenario;
  const first = isFolderRow(tree, fileTree, row);
  const second = isFolderRow(tree, fileTree, next);
  assert.ok(first || !second, "folders come before files");
  if (first !== second) return;
  const firstName = rowLabel(tree, fileTree, row).toLowerCase();
  const secondName = rowLabel(tree, fileTree, next).toLowerCase();
  assert.ok(firstName.localeCompare(secondName, "en", { sensitivity: "accent" }) <= 0, `${firstName} sorts before ${secondName}`);
}

test("the real fixture: each visible file once, consistent levels, ordered siblings, chains to their end", () => {
  const tree = decodePullRequestData(loadFixtureJson(REAL_FIXTURE)).tree;
  const index = buildTreeIndex(tree);
  const scenario: Scenario = { tree, index, fileTree: createFileTree(tree, index), nodeOf: () => 0 };
  const filterCases: readonly Filters[] = [
    DEFAULT_FILTERS,
    { ...DEFAULT_FILTERS, include: parsePathPattern("frontend") },
    { ...DEFAULT_FILTERS, exclude: parsePathPattern("test"), hiddenStatuses: 1 << FileStatus.modified },
  ];
  for (const filters of filterCases) {
    compute(scenario, filters, 0, NOTHING_COLLAPSED);
    assert.ok(scenario.fileTree.rowCount > 0);
    checkRowProperties(scenario);
    let total = 0;
    for (let row = 0; row < scenario.fileTree.rowCount; row++) {
      if (scenario.fileTree.rowParents[row] === NO_ROW) total += scenario.fileTree.visibleFiles[scenario.fileTree.rowNodes[row] ?? 0] ?? 0;
    }
    assert.equal(total, scenario.fileTree.visibleFiles[0], "top-level rows account for every visible file");
  }
});

test("keys move between rows, open and close folders, and leave links to the browser", () => {
  const scenario = createScenario(LEAVES);
  const { tree, fileTree } = scenario;
  compute(scenario, DEFAULT_FILTERS, 0, new Set([scenario.nodeOf("packages/backend")]));
  const docs = rowOfPath(scenario, "docs");
  const guide = rowOfPath(scenario, "docs/guide.md");
  const packages = rowOfPath(scenario, "packages");
  const backend = rowOfPath(scenario, "packages/backend");
  const frontend = rowOfPath(scenario, "packages/frontend/src");
  const last = fileTree.rowCount - 1;
  const act = (row: number, key: string) => treeKeyAction(tree, fileTree, row, key);
  const focus = (row: number) => ({ kind: TreeKeyKind.focus, row });

  assert.deepEqual(act(docs, "ArrowDown"), focus(guide));
  assert.deepEqual(act(guide, "ArrowUp"), focus(docs));
  assert.deepEqual(act(docs, "ArrowUp"), focus(docs), "the first row stays put");
  assert.deepEqual(act(last, "ArrowDown"), focus(last), "the last row stays put");
  assert.deepEqual(act(packages, "Home"), focus(0));
  assert.deepEqual(act(packages, "End"), focus(last));

  assert.deepEqual(act(backend, "ArrowRight"), { kind: TreeKeyKind.expand, row: backend });
  assert.deepEqual(act(packages, "ArrowRight"), focus(backend), "an open folder moves to its first child");
  assert.deepEqual(act(guide, "ArrowRight"), focus(guide));
  assert.deepEqual(act(frontend, "ArrowLeft"), { kind: TreeKeyKind.collapse, row: frontend });
  assert.deepEqual(act(backend, "ArrowLeft"), focus(packages), "a closed folder moves to its parent");
  assert.deepEqual(act(guide, "ArrowLeft"), focus(docs), "a file moves to its parent");
  assert.deepEqual(act(packages, "ArrowLeft"), { kind: TreeKeyKind.collapse, row: packages });

  assert.deepEqual(act(frontend, "Enter"), { kind: TreeKeyKind.collapse, row: frontend });
  assert.deepEqual(act(backend, " "), { kind: TreeKeyKind.expand, row: backend });
  assert.equal(act(guide, "Enter").kind, TreeKeyKind.none, "Enter on a file follows its link");
  assert.deepEqual(act(guide, " "), focus(guide), "Space on a file is swallowed");
  assert.equal(act(guide, "a").kind, TreeKeyKind.none);
});
