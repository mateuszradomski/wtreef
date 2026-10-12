package prune

import (
	"strings"
	"testing"

	"wtreef/internal/pullrequest"
)

// checkInvariants verifies every invariant listed in docs/wire-format.md,
// reading only the parallel arrays, exactly as the client will.
func checkInvariants(t *testing.T, nodes Nodes) {
	t.Helper()
	count := checkShape(t, nodes)
	for index := 0; index < count; index++ {
		checkNode(t, nodes, index)
	}
	checkSiblings(t, nodes)
	checkExpandedDirectoriesHoldChanges(t, nodes)
	checkPruningBounds(t, nodes)
}

func checkShape(t *testing.T, nodes Nodes) int {
	t.Helper()
	count := len(nodes.Names)
	lengths := []int{
		len(nodes.Parents), len(nodes.Kinds), len(nodes.Statuses), len(nodes.Bytes),
		len(nodes.Additions), len(nodes.Deletions), len(nodes.FileCounts),
	}
	for _, length := range lengths {
		if length != count {
			t.Fatalf("array lengths differ: names %d vs %v", count, lengths)
		}
	}
	if count < 1 {
		t.Fatal("tree is empty; N >= 1 is required")
	}
	if nodes.Names[0] != "" || nodes.Parents[0] != -1 || nodes.Kinds[0] != KindDirectory {
		t.Fatalf("root = %q parent %d kind %d", nodes.Names[0], nodes.Parents[0], nodes.Kinds[0])
	}
	return count
}

func checkNode(t *testing.T, nodes Nodes, index int) {
	t.Helper()
	kind, status := nodes.Kinds[index], nodes.Statuses[index]
	if index >= 1 {
		parent := int(nodes.Parents[index])
		if parent < 0 || parent >= index {
			t.Fatalf("node %d: parent %d not in [0, %d)", index, parent, index)
		}
		if nodes.Kinds[parent] != KindDirectory {
			t.Fatalf("node %d: parent %d has kind %d", index, parent, nodes.Kinds[parent])
		}
	}
	if nodes.Bytes[index] < 0 || nodes.Additions[index] < 0 || nodes.Deletions[index] < 0 {
		t.Fatalf("node %d: negative values", index)
	}
	unchangedHasNoLines := status != pullrequest.StatusUnchanged || (nodes.Additions[index] == 0 && nodes.Deletions[index] == 0)
	switch kind {
	case KindDirectory:
		if status != 0 || nodes.Bytes[index] != 0 || nodes.Additions[index] != 0 || nodes.Deletions[index] != 0 || nodes.FileCounts[index] != 0 {
			t.Fatalf("node %d: directory carries values", index)
		}
	case KindFile:
		if nodes.FileCounts[index] != 1 || status < 0 || status > pullrequest.StatusRenamed || !unchangedHasNoLines {
			t.Fatalf("node %d: file count %d status %d", index, nodes.FileCounts[index], status)
		}
		if status == pullrequest.StatusDeleted && nodes.Bytes[index] != 0 {
			t.Fatalf("node %d: deleted file has %d bytes", index, nodes.Bytes[index])
		}
	case KindCollapsedDirectory, KindRest:
		if status != 0 || nodes.Additions[index] != 0 || nodes.Deletions[index] != 0 || nodes.FileCounts[index] < 1 {
			t.Fatalf("node %d: aggregate status %d file count %d", index, status, nodes.FileCounts[index])
		}
	default:
		t.Fatalf("node %d: unknown kind %d", index, kind)
	}
	checkName(t, nodes, index)
}

func checkName(t *testing.T, nodes Nodes, index int) {
	t.Helper()
	if index == 0 {
		return
	}
	name := nodes.Names[index]
	if nodes.Kinds[index] == KindRest {
		if name != "" {
			t.Fatalf("node %d: rest node named %q", index, name)
		}
		return
	}
	if name == "" || strings.Contains(name, "/") {
		t.Fatalf("node %d: invalid name %q", index, name)
	}
}

func checkSiblings(t *testing.T, nodes Nodes) {
	t.Helper()
	type siblingKey struct {
		parent int32
		name   string
	}
	seen := map[siblingKey]bool{}
	restCountByParent := map[int32]int{}
	for index := 1; index < len(nodes.Names); index++ {
		if nodes.Kinds[index] == KindRest {
			restCountByParent[nodes.Parents[index]]++
			if restCountByParent[nodes.Parents[index]] > 1 {
				t.Fatalf("directory %d has more than one rest node", nodes.Parents[index])
			}
			continue
		}
		key := siblingKey{parent: nodes.Parents[index], name: nodes.Names[index]}
		if seen[key] {
			t.Fatalf("directory %d has two children named %q", key.parent, key.name)
		}
		seen[key] = true
	}
}

// checkExpandedDirectoriesHoldChanges aggregates in one reverse pass, the
// way the contract says the client aggregates values.
func checkExpandedDirectoriesHoldChanges(t *testing.T, nodes Nodes) {
	t.Helper()
	changedBelow := make([]int, len(nodes.Names))
	for index := len(nodes.Names) - 1; index >= 1; index-- {
		if nodes.Kinds[index] == KindFile && nodes.Statuses[index] != pullrequest.StatusUnchanged {
			changedBelow[index]++
		}
		changedBelow[nodes.Parents[index]] += changedBelow[index]
	}
	for index := 1; index < len(nodes.Names); index++ {
		if nodes.Kinds[index] == KindDirectory && changedBelow[index] == 0 {
			t.Fatalf("expanded directory %d (%q) contains no changed file", index, nodes.Names[index])
		}
	}
}

func checkPruningBounds(t *testing.T, nodes Nodes) {
	t.Helper()
	unchangedByParent := map[int32]int{}
	changedFiles, directories := 0, 0
	for index := 0; index < len(nodes.Names); index++ {
		kind := nodes.Kinds[index]
		if kind == KindDirectory {
			directories++
		}
		isChangedFile := kind == KindFile && nodes.Statuses[index] != pullrequest.StatusUnchanged
		if isChangedFile {
			changedFiles++
		}
		isUnchangedChild := (kind == KindFile && !isChangedFile) || kind == KindCollapsedDirectory
		if isUnchangedChild {
			unchangedByParent[nodes.Parents[index]]++
		}
	}
	for parent, count := range unchangedByParent {
		if count > UnchangedChildrenMax {
			t.Fatalf("directory %d shows %d unchanged children", parent, count)
		}
	}
	if len(nodes.Names) > changedFiles+directories*NodesPerDirectoryMax {
		t.Fatalf("%d nodes exceed bound %d + %d x %d", len(nodes.Names), changedFiles, directories, NodesPerDirectoryMax)
	}
}

// fullPaths joins ancestor names in one forward pass (parents come first).
// Rest nodes get "<parent path>/*rest*" so tests can find them.
func fullPaths(nodes Nodes) []string {
	paths := make([]string, len(nodes.Names))
	for index := 1; index < len(nodes.Names); index++ {
		name := nodes.Names[index]
		if nodes.Kinds[index] == KindRest {
			name = "*rest*"
		}
		parentPath := paths[nodes.Parents[index]]
		if parentPath == "" {
			paths[index] = name
		} else {
			paths[index] = parentPath + "/" + name
		}
	}
	return paths
}

func findNode(t *testing.T, nodes Nodes, path string) int {
	t.Helper()
	for index, candidatePath := range fullPaths(nodes) {
		if index > 0 && candidatePath == path {
			return index
		}
	}
	t.Fatalf("no node at %q; have %v", path, fullPaths(nodes))
	return -1
}

func hasNode(nodes Nodes, path string) bool {
	for index, candidatePath := range fullPaths(nodes) {
		if index > 0 && candidatePath == path {
			return true
		}
	}
	return false
}

func childrenOf(nodes Nodes, parent int) []int {
	var children []int
	for index := 1; index < len(nodes.Names); index++ {
		if int(nodes.Parents[index]) == parent {
			children = append(children, index)
		}
	}
	return children
}
