package prune

import (
	"fmt"
	"math/rand/v2"
	"reflect"
	"slices"
	"strconv"
	"testing"

	"wtreef/internal/pullrequest"
)

// Methodology: each test builds a synthetic head tree and changed-file list,
// runs Build, checks every contract invariant with checkInvariants, then
// checks the specific pruning rule under test by locating nodes by path.

type entry struct {
	path string
	size int64
}

type change struct {
	path      string
	status    pullrequest.Status
	additions int64
	deletions int64
}

func newTree(t *testing.T, truncated bool, entries ...entry) pullrequest.Tree {
	t.Helper()
	paths := make([]string, 0, len(entries))
	sizes := make([]int64, 0, len(entries))
	for _, treeEntry := range entries {
		paths = append(paths, treeEntry.path)
		sizes = append(sizes, treeEntry.size)
	}
	tree, err := pullrequest.ParseTree(truncated, paths, sizes)
	if err != nil {
		t.Fatal(err)
	}
	return tree
}

func newFiles(t *testing.T, changes ...change) []pullrequest.ChangedFile {
	t.Helper()
	files := make([]pullrequest.ChangedFile, 0, len(changes))
	for _, changed := range changes {
		file, err := pullrequest.NewChangedFile(changed.path, changed.status, changed.additions, changed.deletions)
		if err != nil {
			t.Fatalf("%s: %v", changed.path, err)
		}
		files = append(files, file)
	}
	return files
}

func TestBuildKeepsLargestUnchangedChildrenAndMergesRest(t *testing.T) {
	const unchangedCount = 40
	entries := []entry{{"src/main.go", 500}}
	for index := range unchangedCount {
		// Sizes repeat every 10 files, so ties are broken by name.
		entries = append(entries, entry{fmt.Sprintf("f%02d.txt", index), int64(index%10) * 100})
	}
	nodes := Build(newTree(t, false, entries...), newFiles(t, change{"src/main.go", pullrequest.StatusModified, 3, 1}))
	checkInvariants(t, nodes)

	expected := slices.Clone(entries[1:])
	slices.SortFunc(expected, func(left entry, right entry) int {
		if left.size != right.size {
			return int(right.size - left.size)
		}
		return compareStrings(left.path, right.path)
	})
	for _, kept := range expected[:UnchangedChildrenMax] {
		index := findNode(t, nodes, kept.path)
		if nodes.Kinds[index] != KindFile || nodes.Bytes[index] != kept.size || nodes.Statuses[index] != pullrequest.StatusUnchanged {
			t.Fatalf("%s: kind %d bytes %d", kept.path, nodes.Kinds[index], nodes.Bytes[index])
		}
	}
	restBytes := int64(0)
	for _, merged := range expected[UnchangedChildrenMax:] {
		if hasNode(nodes, merged.path) {
			t.Fatalf("%s should be merged into the rest node", merged.path)
		}
		restBytes += merged.size
	}
	rest := findNode(t, nodes, "*rest*")
	if nodes.Bytes[rest] != restBytes || nodes.FileCounts[rest] != unchangedCount-UnchangedChildrenMax {
		t.Fatalf("rest bytes %d files %d, want %d %d", nodes.Bytes[rest], nodes.FileCounts[rest], restBytes, unchangedCount-UnchangedChildrenMax)
	}
	children := childrenOf(nodes, 0)
	if children[len(children)-1] != rest {
		t.Fatal("rest node must be the last child")
	}
}

func compareStrings(left string, right string) int {
	if left < right {
		return -1
	}
	if left > right {
		return 1
	}
	return 0
}

func TestBuildRestNodeAppearsOnlyPastTheLimit(t *testing.T) {
	for _, unchangedCount := range []int{UnchangedChildrenMax, UnchangedChildrenMax + 1} {
		t.Run(strconv.Itoa(unchangedCount), func(t *testing.T) {
			entries := []entry{}
			for index := range unchangedCount {
				entries = append(entries, entry{"dir/f" + strconv.Itoa(index), 10})
			}
			nodes := Build(newTree(t, false, entries...), newFiles(t, change{"dir/new.ts", pullrequest.StatusAdded, 1, 0}))
			checkInvariants(t, nodes)
			hasRest := hasNode(nodes, "dir/*rest*")
			if hasRest != (unchangedCount > UnchangedChildrenMax) {
				t.Fatalf("%d unchanged children: rest present = %v", unchangedCount, hasRest)
			}
			if hasRest && nodes.FileCounts[findNode(t, nodes, "dir/*rest*")] != 1 {
				t.Fatal("rest should hold exactly one file")
			}
		})
	}
}

func TestBuildCollapsesUnchangedDirectories(t *testing.T) {
	tree := newTree(t, false,
		entry{"docs/a.md", 10},
		entry{"docs/deep/b.md", 20},
		entry{"docs/deep/er/c.md", 30},
		entry{"src/x.ts", 7},
		entry{"src/lib/y.ts", 8},
	)
	nodes := Build(tree, newFiles(t, change{"src/x.ts", pullrequest.StatusModified, 1, 1}))
	checkInvariants(t, nodes)
	docs := findNode(t, nodes, "docs")
	if nodes.Kinds[docs] != KindCollapsedDirectory || nodes.Bytes[docs] != 60 || nodes.FileCounts[docs] != 3 {
		t.Fatalf("docs kind %d bytes %d files %d", nodes.Kinds[docs], nodes.Bytes[docs], nodes.FileCounts[docs])
	}
	lib := findNode(t, nodes, "src/lib")
	if nodes.Kinds[lib] != KindCollapsedDirectory || nodes.Bytes[lib] != 8 || nodes.FileCounts[lib] != 1 {
		t.Fatalf("src/lib kind %d bytes %d", nodes.Kinds[lib], nodes.Bytes[lib])
	}
	if nodes.Kinds[findNode(t, nodes, "src")] != KindDirectory {
		t.Fatal("src must be expanded")
	}
	if hasNode(nodes, "docs/a.md") {
		t.Fatal("collapsed directories have no children")
	}
}

func TestBuildDeletedFilesHaveZeroBytes(t *testing.T) {
	// A deleted file is normally absent from the head tree; the second one is
	// present to prove the status, not the lookup, decides.
	tree := newTree(t, false, entry{"keep.ts", 100}, entry{"lib/stale.ts", 999})
	nodes := Build(tree, newFiles(t,
		change{"lib/gone.ts", pullrequest.StatusDeleted, 0, 40},
		change{"lib/stale.ts", pullrequest.StatusDeleted, 0, 9},
	))
	checkInvariants(t, nodes)
	for _, path := range []string{"lib/gone.ts", "lib/stale.ts"} {
		index := findNode(t, nodes, path)
		if nodes.Kinds[index] != KindFile || nodes.Statuses[index] != pullrequest.StatusDeleted || nodes.Bytes[index] != 0 {
			t.Fatalf("%s: kind %d status %d bytes %d", path, nodes.Kinds[index], nodes.Statuses[index], nodes.Bytes[index])
		}
	}
	if nodes.Deletions[findNode(t, nodes, "lib/gone.ts")] != 40 {
		t.Fatal("deletions lost")
	}
}

func TestBuildChangedFileMissingFromTruncatedTree(t *testing.T) {
	tree := newTree(t, true, entry{"a/present.ts", 5})
	nodes := Build(tree, newFiles(t, change{"deep/er/missing.ts", pullrequest.StatusModified, 2, 2}))
	checkInvariants(t, nodes)
	missing := findNode(t, nodes, "deep/er/missing.ts")
	if nodes.Bytes[missing] != 0 || nodes.Statuses[missing] != pullrequest.StatusModified || nodes.Additions[missing] != 2 {
		t.Fatalf("missing file bytes %d status %d", nodes.Bytes[missing], nodes.Statuses[missing])
	}
	for _, path := range []string{"deep", "deep/er"} {
		if nodes.Kinds[findNode(t, nodes, path)] != KindDirectory {
			t.Fatalf("%s must be expanded", path)
		}
	}
	if nodes.Kinds[findNode(t, nodes, "a")] != KindCollapsedDirectory {
		t.Fatal("unchanged a must be collapsed")
	}
}

func TestBuildRootLevelChangedFile(t *testing.T) {
	tree := newTree(t, false, entry{"README.md", 1234}, entry{"src/a.ts", 1})
	nodes := Build(tree, newFiles(t, change{"README.md", pullrequest.StatusModified, 7, 3}))
	checkInvariants(t, nodes)
	readme := findNode(t, nodes, "README.md")
	if nodes.Parents[readme] != 0 || nodes.Bytes[readme] != 1234 || nodes.Additions[readme] != 7 || nodes.Deletions[readme] != 3 {
		t.Fatalf("README.md parent %d bytes %d", nodes.Parents[readme], nodes.Bytes[readme])
	}
	if len(nodes.Names) != 3 {
		t.Fatalf("want root, README.md, src; got %v", fullPaths(nodes))
	}
}

func TestBuildWithoutChangedFiles(t *testing.T) {
	entries := []entry{}
	for index := range 50 {
		entries = append(entries, entry{"d" + strconv.Itoa(index) + "/x.ts", int64(index)})
		entries = append(entries, entry{"f" + strconv.Itoa(index), int64(index)})
	}
	nodes := Build(newTree(t, false, entries...), nil)
	checkInvariants(t, nodes)
	if len(nodes.Names) != 1+UnchangedChildrenMax+1 {
		t.Fatalf("want root, %d children and rest; got %d nodes", UnchangedChildrenMax, len(nodes.Names))
	}
	rest := findNode(t, nodes, "*rest*")
	if nodes.FileCounts[rest] != 100-UnchangedChildrenMax {
		t.Fatalf("rest file count %d", nodes.FileCounts[rest])
	}

	empty := Build(newTree(t, false), nil)
	checkInvariants(t, empty)
	if len(empty.Names) != 1 {
		t.Fatalf("empty tree and no files must be just the root, got %d nodes", len(empty.Names))
	}
}

func TestBuildSubmodulesAreZeroByteFiles(t *testing.T) {
	tree := newTree(t, false, entry{"vendor/lib", 0}, entry{"vendor/other", 0}, entry{"a.ts", 3})
	nodes := Build(tree, newFiles(t, change{"vendor/lib", pullrequest.StatusModified, 1, 1}))
	checkInvariants(t, nodes)
	submodule := findNode(t, nodes, "vendor/lib")
	other := findNode(t, nodes, "vendor/other")
	if nodes.Bytes[submodule] != 0 || nodes.Kinds[other] != KindFile || nodes.FileCounts[other] != 1 {
		t.Fatal("submodules must be zero-byte files")
	}
}

// A path can be a file on one side of the diff and a directory on the other.
// Names must stay unique among siblings, so the directory wins.
func TestBuildResolvesFileDirectoryCollisions(t *testing.T) {
	tree := newTree(t, false,
		entry{"lib/index.ts", 10},
		entry{"lib/util.ts", 20},
		entry{"docs/guide.md", 30},
		entry{"docs/api.md", 40},
	)
	nodes := Build(tree, newFiles(t,
		change{"lib", pullrequest.StatusDeleted, 0, 5},
		change{"lib/index.ts", pullrequest.StatusAdded, 10, 0},
		change{"docs", pullrequest.StatusAdded, 1, 0},
	))
	checkInvariants(t, nodes)
	if nodes.Kinds[findNode(t, nodes, "lib")] != KindDirectory {
		t.Fatal("lib must be an expanded directory")
	}
	if nodes.Statuses[findNode(t, nodes, "lib/util.ts")] != pullrequest.StatusUnchanged {
		t.Fatal("lib/util.ts must be an unchanged sibling")
	}
	// The changed file "docs" takes the name; the head directory of the same
	// name is accounted for in the root's rest node.
	docs := findNode(t, nodes, "docs")
	if nodes.Kinds[docs] != KindFile || nodes.Statuses[docs] != pullrequest.StatusAdded {
		t.Fatalf("docs kind %d status %d", nodes.Kinds[docs], nodes.Statuses[docs])
	}
	rest := findNode(t, nodes, "*rest*")
	if nodes.Bytes[rest] != 70 || nodes.FileCounts[rest] != 2 {
		t.Fatalf("rest bytes %d files %d", nodes.Bytes[rest], nodes.FileCounts[rest])
	}
}

func TestBuildMalformedTreeCollisionsKeepInvariants(t *testing.T) {
	tree := newTree(t, false,
		entry{"x", 1}, entry{"x/y", 2}, entry{"x", 3},
		entry{"d/f", 4}, entry{"d/f/g", 5},
	)
	nodes := Build(tree, newFiles(t, change{"d/new", pullrequest.StatusAdded, 1, 0}))
	checkInvariants(t, nodes)
	total := int64(0)
	for index := range nodes.Names {
		total += nodes.Bytes[index]
	}
	if total != 15 {
		t.Fatalf("bytes total %d, want 15: colliding entries must land in rest, not vanish", total)
	}
}

func TestBuildLayoutIsPreOrderSortedByNameWithRestLast(t *testing.T) {
	tree := newTree(t, false,
		entry{"b/z.ts", 1}, entry{"b/a.ts", 2}, entry{"a.md", 3}, entry{"c/x", 4},
	)
	nodes := Build(tree, newFiles(t,
		change{"b/z.ts", pullrequest.StatusModified, 1, 1},
		change{"b/new/q.ts", pullrequest.StatusAdded, 1, 0},
	))
	checkInvariants(t, nodes)
	wantPaths := []string{"", "a.md", "b", "b/a.ts", "b/new", "b/new/q.ts", "b/z.ts", "c"}
	if got := fullPaths(nodes); !reflect.DeepEqual(got, wantPaths) {
		t.Fatalf("layout = %v, want %v", got, wantPaths)
	}
	wantParents := []int32{-1, 0, 0, 2, 2, 4, 2, 0}
	if !reflect.DeepEqual(nodes.Parents, wantParents) {
		t.Fatalf("parents = %v, want %v", nodes.Parents, wantParents)
	}
}

// Methodology: random trees and changes from fixed seeds; the same inputs in
// shuffled orders must produce identical output, every invariant must hold,
// and bytes and file counts must be conserved (every tree entry is counted
// exactly once, either as itself or inside an aggregate).
func TestBuildRandomTreesAreDeterministicAndConserveTotals(t *testing.T) {
	for seed := uint64(1); seed <= 40; seed++ {
		random := rand.New(rand.NewPCG(seed, seed*7919))
		entries, changes, missingCount := randomInputs(random)
		nodes := Build(newTree(t, false, entries...), newFiles(t, changes...))
		checkInvariants(t, nodes)
		checkConservation(t, nodes, entries, len(entries)+missingCount)
		for range 3 {
			random.Shuffle(len(changes), func(i, j int) { changes[i], changes[j] = changes[j], changes[i] })
			random.Shuffle(len(entries), func(i, j int) { entries[i], entries[j] = entries[j], entries[i] })
			shuffled := Build(newTree(t, false, entries...), newFiles(t, changes...))
			if !reflect.DeepEqual(nodes, shuffled) {
				t.Fatalf("seed %d: output depends on input order", seed)
			}
		}
	}
}

// randomInputs returns tree entries, changes (some on tree files, some new
// files not in the tree), and how many changed files are not in the tree.
func randomInputs(random *rand.Rand) ([]entry, []change, int) {
	entries := []entry{}
	fileCount := 50 + random.IntN(2000)
	for index := range fileCount {
		depth := random.IntN(5)
		path := ""
		for range depth {
			path += "d" + strconv.Itoa(random.IntN(6)) + "/"
		}
		entries = append(entries, entry{path + "f" + strconv.Itoa(index), int64(random.IntN(5000))})
	}
	changes := []change{}
	statuses := []pullrequest.Status{pullrequest.StatusAdded, pullrequest.StatusModified, pullrequest.StatusRenamed}
	for _, picked := range random.Perm(len(entries))[:random.IntN(60)] {
		changes = append(changes, change{entries[picked].path, statuses[random.IntN(len(statuses))], int64(random.IntN(100)), int64(random.IntN(100))})
	}
	missingCount := random.IntN(10)
	for index := range missingCount {
		status := []pullrequest.Status{pullrequest.StatusDeleted, pullrequest.StatusAdded}[random.IntN(2)]
		changes = append(changes, change{"d" + strconv.Itoa(random.IntN(6)) + "/gone" + strconv.Itoa(index), status, 0, 3})
	}
	return entries, changes, missingCount
}

func checkConservation(t *testing.T, nodes Nodes, entries []entry, fileCountWant int) {
	t.Helper()
	bytesWant := int64(0)
	for _, treeEntry := range entries {
		bytesWant += treeEntry.size
	}
	bytesTotal, filesTotal := int64(0), int64(0)
	for index := range nodes.Names {
		bytesTotal += nodes.Bytes[index]
		filesTotal += nodes.FileCounts[index]
	}
	if bytesTotal != bytesWant || filesTotal != int64(fileCountWant) {
		t.Fatalf("totals bytes %d files %d, want %d %d", bytesTotal, filesTotal, bytesWant, fileCountWant)
	}
}

// BenchmarkBuildLargeTree models GitHub's worst case: a 100k-entry tree
// (the recursive listing cap) and 3000 changed files (the files cap).
func BenchmarkBuildLargeTree(b *testing.B) {
	const entryCount = 100_000
	paths := make([]string, 0, entryCount)
	sizes := make([]int64, 0, entryCount)
	for index := range entryCount {
		paths = append(paths, "p"+strconv.Itoa(index%13)+"/m"+strconv.Itoa(index%97)+"/s"+strconv.Itoa(index%7)+"/f"+strconv.Itoa(index))
		sizes = append(sizes, int64(index%9000))
	}
	tree, err := pullrequest.ParseTree(false, paths, sizes)
	if err != nil {
		b.Fatal(err)
	}
	files := make([]pullrequest.ChangedFile, 0, 3000)
	for index := 0; index < entryCount; index += entryCount / 3000 {
		file, err := pullrequest.NewChangedFile(paths[index], pullrequest.StatusModified, 1, 1)
		if err != nil {
			b.Fatal(err)
		}
		files = append(files, file)
	}
	b.ReportAllocs()
	for b.Loop() {
		nodes := Build(tree, files)
		if len(nodes.Names) < len(files) {
			b.Fatal("changed files missing")
		}
	}
}
