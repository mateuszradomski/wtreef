package cache

import (
	"bytes"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"wtreef/internal/pullrequest"
)

// Methodology: every stored tree has identical contents, so every file has
// the same compressed size; bounds are expressed in multiples of that size,
// and eviction is checked both in the index and on disk.

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(&bytes.Buffer{}, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

func shaFor(t *testing.T, index int) pullrequest.CommitSHA {
	t.Helper()
	hexadecimal := strings.Repeat("0", 40-len(strconv.Itoa(index))) + strconv.Itoa(index)
	sha, err := pullrequest.ParseCommitSHA(hexadecimal)
	if err != nil {
		t.Fatal(err)
	}
	return sha
}

func sampleTree(t *testing.T) pullrequest.Tree {
	t.Helper()
	paths := []string{}
	sizes := []int64{}
	for index := range 200 {
		paths = append(paths, "packages/p"+strconv.Itoa(index%9)+"/src/file"+strconv.Itoa(index)+".ts")
		sizes = append(sizes, int64(index*37))
	}
	tree, err := pullrequest.ParseTree(true, paths, sizes)
	if err != nil {
		t.Fatal(err)
	}
	return tree
}

func storedFileBytes(t *testing.T) int64 {
	t.Helper()
	store, err := OpenTreeStore(t.TempDir(), 1<<30, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Put(shaFor(t, 0), sampleTree(t)); err != nil {
		t.Fatal(err)
	}
	return store.index.BytesTotal()
}

func fileExists(t *testing.T, directory string, sha pullrequest.CommitSHA) bool {
	t.Helper()
	_, err := os.Stat(filepath.Join(directory, sha.String()+treeFileSuffix))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	return err == nil
}

func TestTreeStoreRoundTrip(t *testing.T) {
	store, err := OpenTreeStore(t.TempDir(), 1<<30, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	want := sampleTree(t)
	if _, ok := store.Get(shaFor(t, 1)); ok {
		t.Fatal("empty store returned a tree")
	}
	if err := store.Put(shaFor(t, 1), want); err != nil {
		t.Fatal(err)
	}
	got, ok := store.Get(shaFor(t, 1))
	if !ok || got.Len() != want.Len() || got.Truncated() != want.Truncated() {
		t.Fatalf("round trip: ok %v len %d truncated %v", ok, got.Len(), got.Truncated())
	}
	for index := 0; index < want.Len(); index++ {
		if got.Path(index) != want.Path(index) || got.Size(index) != want.Size(index) {
			t.Fatalf("entry %d differs", index)
		}
	}
}

func TestTreeStoreEvictsLeastRecentlyUsedBySize(t *testing.T) {
	fileBytes := storedFileBytes(t)
	directory := t.TempDir()
	store, err := OpenTreeStore(directory, 2*fileBytes+fileBytes/2, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	tree := sampleTree(t)
	for index := 1; index <= 3; index++ {
		if err := store.Put(shaFor(t, index), tree); err != nil {
			t.Fatal(err)
		}
	}
	if fileExists(t, directory, shaFor(t, 1)) || !fileExists(t, directory, shaFor(t, 2)) || !fileExists(t, directory, shaFor(t, 3)) {
		t.Fatal("the oldest tree must be evicted from disk")
	}
	if _, ok := store.Get(shaFor(t, 2)); !ok {
		t.Fatal("tree 2 missing")
	}
	if err := store.Put(shaFor(t, 4), tree); err != nil {
		t.Fatal(err)
	}
	if fileExists(t, directory, shaFor(t, 3)) || !fileExists(t, directory, shaFor(t, 2)) {
		t.Fatal("reading tree 2 must protect it; tree 3 is least recently used")
	}
	if store.index.BytesTotal() > 2*fileBytes+fileBytes/2 {
		t.Fatalf("store holds %d bytes", store.index.BytesTotal())
	}
}

func TestTreeStoreReopenKeepsRecencyAndCleansUp(t *testing.T) {
	fileBytes := storedFileBytes(t)
	directory := t.TempDir()
	store, err := OpenTreeStore(directory, 1<<30, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	for index := 1; index <= 3; index++ {
		if err := store.Put(shaFor(t, index), sampleTree(t)); err != nil {
			t.Fatal(err)
		}
	}
	// Tree 1 was written first but read most recently (newest mtime).
	now := time.Now()
	for index, age := range map[int]time.Duration{1: 0, 2: 2 * time.Hour, 3: time.Hour} {
		path := filepath.Join(directory, shaFor(t, index).String()+treeFileSuffix)
		if err := os.Chtimes(path, now.Add(-age), now.Add(-age)); err != nil {
			t.Fatal(err)
		}
	}
	leftovers := []string{treeTemporaryPrefix + "crashed", "README.txt"}
	for _, name := range leftovers {
		if err := os.WriteFile(filepath.Join(directory, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	reopened, err := OpenTreeStore(directory, 2*fileBytes+fileBytes/2, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	if fileExists(t, directory, shaFor(t, 2)) || !fileExists(t, directory, shaFor(t, 1)) || !fileExists(t, directory, shaFor(t, 3)) {
		t.Fatal("reopening over the bound must evict the oldest mtime (tree 2)")
	}
	if reopened.index.Len() != 2 {
		t.Fatalf("index holds %d trees, want 2", reopened.index.Len())
	}
	if _, err := os.Stat(filepath.Join(directory, leftovers[0])); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("temporary file from a crash must be removed")
	}
	if _, err := os.Stat(filepath.Join(directory, leftovers[1])); err != nil {
		t.Fatal("unrelated files must be left alone")
	}
}

func TestTreeStoreDiscardsCorruptFiles(t *testing.T) {
	directory := t.TempDir()
	corruptPath := filepath.Join(directory, shaFor(t, 9).String()+treeFileSuffix)
	if err := os.WriteFile(corruptPath, []byte("not gzip"), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenTreeStore(directory, 1<<30, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := store.Get(shaFor(t, 9)); ok {
		t.Fatal("corrupt tree served")
	}
	if fileExists(t, directory, shaFor(t, 9)) || store.index.Len() != 0 {
		t.Fatal("corrupt tree must be removed from disk and index")
	}
}

func TestTreeStoreRejectsTreeLargerThanStore(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenTreeStore(directory, 16, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Put(shaFor(t, 1), sampleTree(t)); err == nil {
		t.Fatal("oversized tree accepted")
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("oversized tree left files behind: %v", entries)
	}
}

func TestTreeStoreAssertsOnUnparsedSHA(t *testing.T) {
	store, err := OpenTreeStore(t.TempDir(), 1<<30, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if recover() == nil {
			t.Fatal("zero CommitSHA reached the file system")
		}
	}()
	_ = store.Put(pullrequest.CommitSHA{}, sampleTree(t))
}

func TestTreeStorePathAssertsOnTraversal(t *testing.T) {
	store, err := OpenTreeStore(t.TempDir(), 1<<30, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if recover() == nil {
			t.Fatal("traversal name reached the file system")
		}
	}()
	_ = store.pathOf("../../../../../../../../../../../etc/passwd")
}
