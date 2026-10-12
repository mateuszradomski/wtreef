package prune

import (
	"slices"
	"strings"

	"wtreef/internal/pullrequest"
)

// source says which layout slice a pending node comes from.
type source int8

const (
	sourceDirectory source = iota
	sourceChangedFile
	sourceCandidate
	sourceRest
)

type pendingNode struct {
	source source
	// index points into directories, changedFiles, or candidates; for a
	// rest node it is the owning directory's index.
	index      int32
	parentNode int32
}

type child struct {
	name   string
	source source
	index  int32
}

type node struct {
	name      string
	parent    int32
	kind      Kind
	status    pullrequest.Status
	bytes     int64
	additions int64
	deletions int64
	fileCount int64
}

// emit lays the layout out in pre-order with an explicit stack: a directory,
// then its children sorted by name with the rest node last. Pre-order puts
// every parent before its children, which the contract requires.
func (layout *layout) emit() Nodes {
	nodeCountMax := layout.nodeCountMax()
	nodes := newNodes(nodeCountMax)
	stack := make([]pendingNode, 0, 64)
	stack = append(stack, pendingNode{source: sourceDirectory, index: 0, parentNode: -1})
	children := make([]child, 0, 64)
	for iteration := 0; len(stack) > 0; iteration++ {
		assert(iteration < nodeCountMax, "every node is pushed exactly once")
		pending := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		nodeIndex := int32(len(nodes.Names))
		switch pending.source {
		case sourceDirectory:
			directory := &layout.directories[pending.index]
			nodes.append(node{name: directory.name, parent: pending.parentNode, kind: KindDirectory})
			children = layout.sortedChildren(pending.index, children[:0])
			stack = pushChildren(stack, children, directory.restFileCount > 0, pending.index, nodeIndex)
		case sourceChangedFile:
			file := layout.changedFiles[pending.index]
			nodes.append(node{
				name: file.name, parent: pending.parentNode, kind: KindFile, status: file.status,
				bytes: changedFileBytes(file), additions: file.additions, deletions: file.deletions, fileCount: 1,
			})
		case sourceCandidate:
			unchanged := layout.candidates[pending.index]
			nodes.append(node{
				name: unchanged.name, parent: pending.parentNode, kind: unchanged.kind,
				bytes: unchanged.bytes, fileCount: unchanged.fileCount,
			})
		case sourceRest:
			directory := &layout.directories[pending.index]
			nodes.append(node{
				name: "", parent: pending.parentNode, kind: KindRest,
				bytes: directory.restBytes, fileCount: directory.restFileCount,
			})
		}
	}
	return nodes
}

func (layout *layout) sortedChildren(directoryIndex int32, children []child) []child {
	assert(len(children) == 0, "children scratch starts empty")
	directory := &layout.directories[directoryIndex]
	for _, index := range directory.subdirectoryIndexes {
		children = append(children, child{name: layout.directories[index].name, source: sourceDirectory, index: index})
	}
	for _, index := range directory.changedFileIndexes {
		children = append(children, child{name: layout.changedFiles[index].name, source: sourceChangedFile, index: index})
	}
	for _, index := range directory.candidateIndexes {
		children = append(children, child{name: layout.candidates[index].name, source: sourceCandidate, index: index})
	}
	sortChildrenByName(children)
	for index := 1; index < len(children); index++ {
		assert(children[index-1].name < children[index].name, "sibling names are unique")
	}
	return children
}

func sortChildrenByName(children []child) {
	compare := func(left child, right child) int { return strings.Compare(left.name, right.name) }
	slices.SortFunc(children, compare)
}

// pushChildren pushes in reverse so the first child pops first; the rest
// node goes in before them so it pops last.
func pushChildren(stack []pendingNode, children []child, hasRest bool, directoryIndex int32, parentNode int32) []pendingNode {
	if hasRest {
		stack = append(stack, pendingNode{source: sourceRest, index: directoryIndex, parentNode: parentNode})
	}
	for index := len(children) - 1; index >= 0; index-- {
		stack = append(stack, pendingNode{source: children[index].source, index: children[index].index, parentNode: parentNode})
	}
	return stack
}

func changedFileBytes(file changedFile) int64 {
	if file.status == pullrequest.StatusDeleted {
		return 0
	}
	return file.headBytes
}

func newNodes(capacity int) Nodes {
	assert(capacity >= 1, "there is room for the root")
	return Nodes{
		Names:      make([]string, 0, capacity),
		Parents:    make([]int32, 0, capacity),
		Kinds:      make([]Kind, 0, capacity),
		Statuses:   make([]pullrequest.Status, 0, capacity),
		Bytes:      make([]int64, 0, capacity),
		Additions:  make([]int64, 0, capacity),
		Deletions:  make([]int64, 0, capacity),
		FileCounts: make([]int64, 0, capacity),
	}
}

// append asserts the per-node contract invariants at the point of writing;
// the client asserts the same ones after reading.
func (nodes *Nodes) append(value node) {
	index := int32(len(nodes.Names))
	if index == 0 {
		assert(value.parent == -1, "the root has no parent")
		assert(value.kind == KindDirectory, "the root is a directory")
	} else {
		assert(value.parent >= 0, "non-root nodes have a parent")
		assert(value.parent < index, "parents come before children")
		assert(nodes.Kinds[value.parent] == KindDirectory, "parents are expanded directories")
	}
	switch value.kind {
	case KindDirectory:
		assert(value.bytes == 0, "directories carry no bytes")
		assert(value.fileCount == 0, "directories carry no file count")
		assert(value.status == pullrequest.StatusUnchanged, "directories carry no status")
	case KindFile:
		assert(value.fileCount == 1, "a file counts once")
		assert(value.status >= pullrequest.StatusUnchanged, "file status is in range")
		assert(value.status <= pullrequest.StatusRenamed, "file status is in range")
		if value.status == pullrequest.StatusDeleted {
			assert(value.bytes == 0, "deleted files have no bytes")
		}
	case KindCollapsedDirectory, KindRest:
		assert(value.status == pullrequest.StatusUnchanged, "aggregates are unchanged")
		assert(value.fileCount >= 1, "aggregates represent at least one file")
	default:
		panic("assertion failed: node kind is one of the four wire kinds")
	}
	if value.kind == KindRest {
		assert(value.name == "", "rest nodes are unnamed")
	} else if index > 0 {
		assert(value.name != "", "every non-root node except rest is named")
	} else {
		assert(value.name == "", "the root is unnamed")
	}
	if value.status == pullrequest.StatusUnchanged {
		assert(value.additions == 0, "unchanged nodes have no additions")
		assert(value.deletions == 0, "unchanged nodes have no deletions")
	}
	assert(!strings.Contains(value.name, "/"), "names are single segments")
	assert(value.bytes >= 0, "bytes are not negative")
	nodes.Names = append(nodes.Names, value.name)
	nodes.Parents = append(nodes.Parents, value.parent)
	nodes.Kinds = append(nodes.Kinds, value.kind)
	nodes.Statuses = append(nodes.Statuses, value.status)
	nodes.Bytes = append(nodes.Bytes, value.bytes)
	nodes.Additions = append(nodes.Additions, value.additions)
	nodes.Deletions = append(nodes.Deletions, value.deletions)
	nodes.FileCounts = append(nodes.FileCounts, value.fileCount)
}
