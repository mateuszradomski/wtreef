package cache

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"wtreef/internal/pullrequest"
)

const (
	treeFileSuffix      = ".json.gz"
	treeTemporaryPrefix = ".tmp-"
	treeFormatVersion   = 1
	// treeStoreEntriesMax bounds the in-memory index; at a few hundred bytes
	// per small tree it is never the binding limit before bytes are.
	treeStoreEntriesMax        = 1 << 16
	treeFileCompressedBytesMax = 64 << 20
	treeFileDecodedBytesMax    = 256 << 20
	treeGzipLevel              = 6
	directoryScanBatchSize     = 1024
	directoryScanEntriesMax    = 1 << 20
	directoryPermissions       = 0o700
)

// TreeStore keeps head-commit trees on disk forever (a commit's tree never
// changes), bounded by total file bytes with least-recently-used eviction.
// File modification times record recency, so the order survives restarts.
// It is safe for concurrent use.
type TreeStore struct {
	directory      string
	logger         *slog.Logger
	mutex          sync.Mutex
	index          *LRU[struct{}]
	evictedScratch []string
}

// treeFile is the on-disk form, stored gzip-compressed.
type treeFile struct {
	Format    int      `json:"format"`
	Truncated bool     `json:"truncated"`
	Paths     []string `json:"paths"`
	Sizes     []int64  `json:"sizes"`
}

type storedTreeFile struct {
	sha        string
	bytes      int64
	modifiedAt time.Time
}

// OpenTreeStore indexes existing trees oldest-first, evicting any beyond the
// bounds, and removes temporary files left behind by a crash.
func OpenTreeStore(directory string, bytesMax int64, logger *slog.Logger) (*TreeStore, error) {
	assert(directory != "", "tree store directory is set")
	assert(bytesMax >= 1, "tree store byte bound is positive")
	assert(logger != nil, "logger is required")
	if err := os.MkdirAll(directory, directoryPermissions); err != nil {
		return nil, err
	}
	files, temporaryNames, err := scanTreeDirectory(directory)
	if err != nil {
		return nil, err
	}
	for _, name := range temporaryNames {
		removeLogged(logger, filepath.Join(directory, name))
	}
	slices.SortFunc(files, compareOldestFirst)
	store := &TreeStore{
		directory:      directory,
		logger:         logger,
		index:          NewLRU[struct{}](treeStoreEntriesMax, bytesMax),
		evictedScratch: make([]string, 0, 16),
	}
	for _, file := range files {
		if file.bytes > bytesMax {
			removeLogged(logger, store.pathOf(file.sha))
			continue
		}
		store.evictedScratch = store.index.Put(file.sha, struct{}{}, file.bytes, store.evictedScratch[:0])
		store.removeEvicted()
	}
	logger.Info("tree store opened", "directory", directory,
		"trees", store.index.Len(), "bytes", store.index.BytesTotal(), "bytes_max", bytesMax)
	return store, nil
}

// Get returns the stored tree for sha. Unreadable entries are discarded and
// reported as misses so the caller refetches.
func (store *TreeStore) Get(sha pullrequest.CommitSHA) (pullrequest.Tree, bool) {
	path := store.pathOf(sha.String())
	store.mutex.Lock()
	_, present := store.index.Get(sha.String())
	store.mutex.Unlock()
	if !present {
		return pullrequest.Tree{}, false
	}
	tree, err := readTreeFile(path)
	if err != nil {
		store.logger.Warn("tree store entry unreadable, discarding", "sha", sha.String(), "error", err)
		store.mutex.Lock()
		store.index.Remove(sha.String())
		store.mutex.Unlock()
		removeLogged(store.logger, path)
		return pullrequest.Tree{}, false
	}
	now := time.Now()
	if err := os.Chtimes(path, now, now); err != nil {
		store.logger.Warn("tree store could not record access time", "sha", sha.String(), "error", err)
	}
	return tree, true
}

// Put writes the tree to a temporary file and renames it into place, so a
// crash never leaves a partial tree under a valid name.
func (store *TreeStore) Put(sha pullrequest.CommitSHA, tree pullrequest.Tree) error {
	path := store.pathOf(sha.String())
	temporaryPath, bytes, err := writeTemporaryTreeFile(store.directory, tree)
	if err != nil {
		return err
	}
	if bytes > store.index.BytesMax() {
		removeLogged(store.logger, temporaryPath)
		return errors.New("tree file is larger than the whole tree store")
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		removeLogged(store.logger, temporaryPath)
		return err
	}
	store.mutex.Lock()
	defer store.mutex.Unlock()
	store.evictedScratch = store.index.Put(sha.String(), struct{}{}, bytes, store.evictedScratch[:0])
	store.removeEvicted()
	return nil
}

// removeEvicted deletes the files of keys the index just evicted. Callers
// hold the mutex or have exclusive access.
func (store *TreeStore) removeEvicted() {
	for _, sha := range store.evictedScratch {
		removeLogged(store.logger, store.pathOf(sha))
	}
	store.evictedScratch = store.evictedScratch[:0]
}

// pathOf is the security boundary between GitHub data and the file system:
// only a 40-character lowercase hex name may become a path.
func (store *TreeStore) pathOf(sha string) string {
	assert(pullrequest.IsCommitSHA(sha), "tree file names are commit SHAs")
	assert(!strings.ContainsAny(sha, `/\.`), "tree file names cannot traverse directories")
	return filepath.Join(store.directory, sha+treeFileSuffix)
}

func writeTemporaryTreeFile(directory string, tree pullrequest.Tree) (string, int64, error) {
	file, err := os.CreateTemp(directory, treeTemporaryPrefix+"*")
	if err != nil {
		return "", 0, err
	}
	temporaryPath := file.Name()
	bytes, err := encodeTreeFile(file, tree)
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		removeErr := os.Remove(temporaryPath)
		return "", 0, errors.Join(err, removeErr)
	}
	assert(bytes > 0, "a gzip stream is never empty")
	return temporaryPath, bytes, nil
}

func encodeTreeFile(file *os.File, tree pullrequest.Tree) (int64, error) {
	contents := treeFile{
		Format:    treeFormatVersion,
		Truncated: tree.Truncated(),
		Paths:     make([]string, tree.Len()),
		Sizes:     make([]int64, tree.Len()),
	}
	for index := 0; index < tree.Len(); index++ {
		contents.Paths[index] = tree.Path(index)
		contents.Sizes[index] = tree.Size(index)
	}
	compressor, err := gzip.NewWriterLevel(file, treeGzipLevel)
	assert(err == nil, "gzip level is valid")
	encoder := json.NewEncoder(compressor)
	// Never served to browsers, so HTML escaping would only cost bytes.
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(contents); err != nil {
		return 0, err
	}
	if err := compressor.Close(); err != nil {
		return 0, err
	}
	if err := file.Sync(); err != nil {
		return 0, err
	}
	info, err := file.Stat()
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

func readTreeFile(path string) (pullrequest.Tree, error) {
	file, err := os.Open(path)
	if err != nil {
		return pullrequest.Tree{}, err
	}
	contents, decodeErr := decodeTreeFile(file)
	closeErr := file.Close()
	if decodeErr != nil {
		return pullrequest.Tree{}, decodeErr
	}
	if closeErr != nil {
		return pullrequest.Tree{}, closeErr
	}
	if contents.Format != treeFormatVersion {
		return pullrequest.Tree{}, errors.New("tree file has an unknown format version")
	}
	return pullrequest.ParseTree(contents.Truncated, contents.Paths, contents.Sizes)
}

func decodeTreeFile(file io.Reader) (treeFile, error) {
	decompressor, err := gzip.NewReader(io.LimitReader(file, treeFileCompressedBytesMax))
	if err != nil {
		return treeFile{}, err
	}
	var contents treeFile
	decoder := json.NewDecoder(io.LimitReader(decompressor, treeFileDecodedBytesMax))
	if err := decoder.Decode(&contents); err != nil {
		return treeFile{}, err
	}
	// Reading to the end makes gzip verify its checksum.
	if _, err := io.Copy(io.Discard, decompressor); err != nil {
		return treeFile{}, err
	}
	return contents, nil
}

// scanTreeDirectory lists stored trees and leftover temporary files, in
// bounded batches. Anything else in the directory is left alone.
func scanTreeDirectory(directory string) ([]storedTreeFile, []string, error) {
	handle, err := os.Open(directory)
	if err != nil {
		return nil, nil, err
	}
	files, temporaryNames, scanErr := readTreeDirectory(handle)
	closeErr := handle.Close()
	if scanErr != nil {
		return nil, nil, scanErr
	}
	if closeErr != nil {
		return nil, nil, closeErr
	}
	return files, temporaryNames, nil
}

func readTreeDirectory(handle *os.File) ([]storedTreeFile, []string, error) {
	files := make([]storedTreeFile, 0, 64)
	temporaryNames := make([]string, 0, 4)
	for batchIndex := 0; batchIndex < directoryScanEntriesMax/directoryScanBatchSize; batchIndex++ {
		entries, readErr := handle.ReadDir(directoryScanBatchSize)
		for _, entry := range entries {
			name := entry.Name()
			if strings.HasPrefix(name, treeTemporaryPrefix) {
				temporaryNames = append(temporaryNames, name)
				continue
			}
			file, isTree, err := parseStoredTreeFile(entry)
			if err != nil {
				return nil, nil, err
			}
			if isTree {
				files = append(files, file)
			}
		}
		if errors.Is(readErr, io.EOF) {
			return files, temporaryNames, nil
		}
		if readErr != nil {
			return nil, nil, readErr
		}
	}
	return nil, nil, errors.New("tree store directory has too many entries")
}

func parseStoredTreeFile(entry fs.DirEntry) (storedTreeFile, bool, error) {
	sha, hasSuffix := strings.CutSuffix(entry.Name(), treeFileSuffix)
	if !hasSuffix || !pullrequest.IsCommitSHA(sha) || !entry.Type().IsRegular() {
		return storedTreeFile{}, false, nil
	}
	info, err := entry.Info()
	if err != nil {
		return storedTreeFile{}, false, err
	}
	return storedTreeFile{sha: sha, bytes: info.Size(), modifiedAt: info.ModTime()}, true, nil
}

func compareOldestFirst(left storedTreeFile, right storedTreeFile) int {
	if comparison := left.modifiedAt.Compare(right.modifiedAt); comparison != 0 {
		return comparison
	}
	return strings.Compare(left.sha, right.sha)
}

func removeLogged(logger *slog.Logger, path string) {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		logger.Warn("tree store could not remove file", "path", path, "error", err)
	}
}
