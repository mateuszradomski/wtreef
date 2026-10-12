// Package prune cuts the head commit's tree down to the changed files, their
// ancestors, and each expanded directory's largest unchanged children, and
// lays the result out as the wire format's parallel arrays.
package prune

import (
	"cmp"
	"slices"
	"strings"

	"wtreef/internal/pullrequest"
)

type Kind int8

const (
	KindDirectory          Kind = 0
	KindFile               Kind = 1
	KindCollapsedDirectory Kind = 2
	KindRest               Kind = 3
)

// UnchangedChildrenMax is how many unchanged children an expanded directory
// shows before the remainder merges into its rest node.
const UnchangedChildrenMax = 32

// NodesPerDirectoryMax counts an expanded directory, its shown unchanged
// children, and its rest node: the contract's "expandedDirectories × 34".
const NodesPerDirectoryMax = 1 + UnchangedChildrenMax + 1

// Nodes is the pruned tree as parallel arrays, field for field the wire
// format's "tree" object. Kind and Status are int8 rather than uint8
// because encoding/json would encode a []uint8 as base64.
type Nodes struct {
	Names      []string             `json:"names"`
	Parents    []int32              `json:"parents"`
	Kinds      []Kind               `json:"kinds"`
	Statuses   []pullrequest.Status `json:"statuses"`
	Bytes      []int64              `json:"bytes"`
	Additions  []int64              `json:"additions"`
	Deletions  []int64              `json:"deletions"`
	FileCounts []int64              `json:"fileCounts"`
}

// layout is the intermediate form between the inputs and Nodes: expanded
// directories, changed files, and unchanged candidates, linked by index.
type layout struct {
	directories            []directory
	directoryIndexByPath   map[string]int32
	changedFiles           []changedFile
	changedFileIndexByPath map[string]int32
	candidates             []candidate
	candidateIndexByPath   map[string]int32
}

type directory struct {
	name                string
	subdirectoryIndexes []int32
	changedFileIndexes  []int32
	candidateIndexes    []int32
	restBytes           int64
	restFileCount       int64
}

type changedFile struct {
	name      string
	status    pullrequest.Status
	additions int64
	deletions int64
	// headBytes stays 0 when the tree lacks the file (deleted or truncated).
	headBytes int64
}

// candidate is an unchanged child of an expanded directory: a file, or a
// subdirectory aggregated over every file beneath it.
type candidate struct {
	name      string
	kind      Kind
	bytes     int64
	fileCount int64
}

// Build prunes tree around files. It is deterministic: the output depends
// only on the inputs' contents, not on the order of files. Tree order only
// matters for malformed trees whose paths collide (see placeUnchangedFile).
func Build(tree pullrequest.Tree, files []pullrequest.ChangedFile) Nodes {
	layout := newLayout(files)
	layout.placeTreeEntries(tree)
	layout.selectUnchangedChildren()
	nodes := layout.emit()
	assert(len(nodes.Names) >= 1, "the root is always emitted")
	assert(len(nodes.Names) <= layout.nodeCountMax(), "node count respects the contract's bound")
	return nodes
}

func newLayout(files []pullrequest.ChangedFile) *layout {
	result := &layout{
		directories:            make([]directory, 0, 1+len(files)),
		directoryIndexByPath:   make(map[string]int32, 1+len(files)),
		changedFiles:           make([]changedFile, 0, len(files)),
		changedFileIndexByPath: make(map[string]int32, len(files)),
		candidateIndexByPath:   make(map[string]int32),
	}
	result.directories = append(result.directories, directory{name: ""})
	result.directoryIndexByPath[""] = 0
	// Pass 1: every ancestor of a changed file becomes an expanded directory.
	for _, file := range files {
		result.addAncestorDirectories(file.Path())
	}
	// Pass 2: changed files attach to their (now existing) parents.
	for _, file := range files {
		result.addChangedFile(file)
	}
	return result
}

func (layout *layout) addAncestorDirectories(path string) {
	parentIndex := int32(0)
	for position := 0; position < len(path); position++ {
		if path[position] != '/' {
			continue
		}
		prefix := path[:position]
		index, exists := layout.directoryIndexByPath[prefix]
		if !exists {
			index = int32(len(layout.directories))
			layout.directories = append(layout.directories, directory{name: baseName(prefix)})
			layout.directories[parentIndex].subdirectoryIndexes = append(
				layout.directories[parentIndex].subdirectoryIndexes, index)
			layout.directoryIndexByPath[prefix] = index
		}
		parentIndex = index
	}
}

func (layout *layout) addChangedFile(file pullrequest.ChangedFile) {
	path := file.Path()
	// A path that is a file on one side of the diff and a directory on the
	// other cannot be both in one tree; the directory wins because it holds
	// other changed files. Names stay unique among siblings.
	if _, isDirectory := layout.directoryIndexByPath[path]; isDirectory {
		return
	}
	_, duplicate := layout.changedFileIndexByPath[path]
	assert(!duplicate, "changed file paths are unique")
	directoryPath, name := splitPath(path)
	directoryIndex, exists := layout.directoryIndexByPath[directoryPath]
	assert(exists, "the parent of a changed file is expanded")
	fileIndex := int32(len(layout.changedFiles))
	layout.changedFiles = append(layout.changedFiles, changedFile{
		name:      name,
		status:    file.Status(),
		additions: file.Additions(),
		deletions: file.Deletions(),
	})
	layout.changedFileIndexByPath[path] = fileIndex
	layout.directories[directoryIndex].changedFileIndexes = append(
		layout.directories[directoryIndex].changedFileIndexes, fileIndex)
}

// placeTreeEntries assigns every tree entry to exactly one place: a changed
// file's size, an unchanged candidate, or a directory's rest.
func (layout *layout) placeTreeEntries(tree pullrequest.Tree) {
	for index := 0; index < tree.Len(); index++ {
		path := tree.Path(index)
		size := tree.Size(index)
		if fileIndex, isChanged := layout.changedFileIndexByPath[path]; isChanged {
			layout.changedFiles[fileIndex].headBytes = size
			continue
		}
		directoryIndex, childPath := deepestExpandedAncestor(layout.directoryIndexByPath, path)
		if childPath == path {
			layout.placeUnchangedFile(directoryIndex, path, size)
		} else {
			layout.placeUnchangedDirectoryEntry(directoryIndex, childPath, size)
		}
	}
}

// placeUnchangedFile sends a file whose name is already taken by a sibling
// to the rest node. Well-formed trees never collide here except when a
// changed path is a directory at head; malformed ones (duplicates, a path
// that is both file and directory) degrade instead of breaking invariants.
func (layout *layout) placeUnchangedFile(directoryIndex int32, path string, size int64) {
	_, isExpanded := layout.directoryIndexByPath[path]
	_, isCandidate := layout.candidateIndexByPath[path]
	if isExpanded || isCandidate {
		layout.addToRest(directoryIndex, size, 1)
		return
	}
	layout.addCandidate(directoryIndex, path, candidate{name: baseName(path), kind: KindFile, bytes: size, fileCount: 1})
}

func (layout *layout) placeUnchangedDirectoryEntry(directoryIndex int32, childPath string, size int64) {
	if _, isChanged := layout.changedFileIndexByPath[childPath]; isChanged {
		layout.addToRest(directoryIndex, size, 1)
		return
	}
	candidateIndex, exists := layout.candidateIndexByPath[childPath]
	if !exists {
		collapsed := candidate{name: baseName(childPath), kind: KindCollapsedDirectory, bytes: size, fileCount: 1}
		layout.addCandidate(directoryIndex, childPath, collapsed)
		return
	}
	if layout.candidates[candidateIndex].kind != KindCollapsedDirectory {
		layout.addToRest(directoryIndex, size, 1)
		return
	}
	layout.candidates[candidateIndex].bytes += size
	layout.candidates[candidateIndex].fileCount++
}

func (layout *layout) addCandidate(directoryIndex int32, path string, unchanged candidate) {
	assert(unchanged.name != "", "candidates are named")
	assert(unchanged.fileCount >= 1, "candidates represent at least one file")
	candidateIndex := int32(len(layout.candidates))
	layout.candidates = append(layout.candidates, unchanged)
	layout.candidateIndexByPath[path] = candidateIndex
	layout.directories[directoryIndex].candidateIndexes = append(
		layout.directories[directoryIndex].candidateIndexes, candidateIndex)
}

func (layout *layout) addToRest(directoryIndex int32, bytes int64, fileCount int64) {
	assert(bytes >= 0, "rest bytes are not negative")
	assert(fileCount >= 1, "rest grows by whole files")
	layout.directories[directoryIndex].restBytes += bytes
	layout.directories[directoryIndex].restFileCount += fileCount
}

// selectUnchangedChildren keeps each directory's largest candidates (ties by
// name ascending) and merges the remainder into its rest node.
func (layout *layout) selectUnchangedChildren() {
	compare := func(left int32, right int32) int {
		return compareCandidates(layout.candidates[left], layout.candidates[right])
	}
	for directoryIndex := range layout.directories {
		directory := &layout.directories[directoryIndex]
		slices.SortFunc(directory.candidateIndexes, compare)
		if len(directory.candidateIndexes) <= UnchangedChildrenMax {
			continue
		}
		for _, candidateIndex := range directory.candidateIndexes[UnchangedChildrenMax:] {
			layout.addToRest(int32(directoryIndex), layout.candidates[candidateIndex].bytes,
				layout.candidates[candidateIndex].fileCount)
		}
		directory.candidateIndexes = directory.candidateIndexes[:UnchangedChildrenMax]
		assert(directory.restFileCount >= 1, "overflowing candidates produce a rest node")
	}
}

func (layout *layout) nodeCountMax() int {
	return len(layout.changedFiles) + len(layout.directories)*NodesPerDirectoryMax
}

func compareCandidates(left candidate, right candidate) int {
	if left.bytes != right.bytes {
		return cmp.Compare(right.bytes, left.bytes)
	}
	return strings.Compare(left.name, right.name)
}

// deepestExpandedAncestor returns the deepest expanded directory above path
// and the path of its child that leads to path (path itself when the entry
// sits directly in that directory). Ancestors of expanded directories are
// expanded, so the walk stops at the first prefix that is not.
func deepestExpandedAncestor(directoryIndexByPath map[string]int32, path string) (int32, string) {
	directoryIndex := int32(0)
	for position := 0; position < len(path); position++ {
		if path[position] != '/' {
			continue
		}
		index, expanded := directoryIndexByPath[path[:position]]
		if !expanded {
			return directoryIndex, path[:position]
		}
		directoryIndex = index
	}
	return directoryIndex, path
}

func splitPath(path string) (string, string) {
	slash := strings.LastIndexByte(path, '/')
	if slash < 0 {
		return "", path
	}
	return path[:slash], path[slash+1:]
}

func baseName(path string) string {
	_, name := splitPath(path)
	assert(name != "", "paths have non-empty segments")
	return name
}

func assert(condition bool, message string) {
	if !condition {
		panic("assertion failed: " + message)
	}
}
