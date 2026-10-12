package github

import "sync/atomic"

// Stage is the step a pull request load is on, in the order they run.
type Stage int32

const (
	// StagePullRequest waits for the metadata and the first files page.
	StagePullRequest Stage = iota
	// StageFiles fetches the remaining files pages.
	StageFiles
	// StageTree lists the head commit's tree.
	StageTree
)

// treeEntriesReportInterval spaces tree progress updates; a listing holds
// up to TreeEntriesMax entries and nobody watches them one by one.
const treeEntriesReportInterval = 1024

// Progress counts how far one pull request load has come, for the loading
// page's progress bar. Fetches write it from several goroutines while the
// server reads it, so every field is atomic. A nil *Progress records nothing.
type Progress struct {
	stage        atomic.Int32
	filesTotal   atomic.Int64
	filesFetched atomic.Int64
	treeEntries  atomic.Int64
}

// ProgressSnapshot is one read of a Progress. Its fields are read one at a
// time, so they may be a moment apart; FilesFetched never exceeds FilesTotal.
type ProgressSnapshot struct {
	Stage Stage
	// FilesTotal is how many changed files the load will list, 0 until the
	// first page arrives.
	FilesTotal   int64
	FilesFetched int64
	// TreeEntries is how many files and submodules of the tree have been
	// read so far; the total is unknown until the listing ends.
	TreeEntries int64
}

func (progress *Progress) Snapshot() ProgressSnapshot {
	assert(progress != nil, "only a recording progress is read")
	filesTotal := progress.filesTotal.Load()
	return ProgressSnapshot{
		Stage:        Stage(progress.stage.Load()),
		FilesTotal:   filesTotal,
		FilesFetched: min(progress.filesFetched.Load(), filesTotal),
		TreeEntries:  progress.treeEntries.Load(),
	}
}

// StartTree marks the tree fetch as begun. The server calls it rather than
// FetchTree, so a load that joins another's tree fetch still moves on.
func (progress *Progress) StartTree() {
	if progress == nil {
		return
	}
	progress.stage.Store(int32(StageTree))
}

func (progress *Progress) startFiles(filesTotal int64) {
	if progress == nil {
		return
	}
	assert(filesTotal >= 0, "file totals are not negative")
	progress.filesTotal.Store(filesTotal)
	progress.stage.Store(int32(StageFiles))
}

// addFiles counts a fetched page. A prefetched page that turns out wrong is
// fetched again and counted twice; Snapshot clamps to the total.
func (progress *Progress) addFiles(page *graphqlFiles) {
	if progress == nil || page == nil {
		return
	}
	progress.filesFetched.Add(int64(len(page.Nodes)))
}

func (progress *Progress) setTreeEntries(entries int) {
	if progress == nil {
		return
	}
	progress.treeEntries.Store(int64(entries))
}
