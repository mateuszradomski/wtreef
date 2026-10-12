package localgit

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"wtreef/internal/pullrequest"
)

// Methodology: each test builds a real repository in a temp directory with
// the git binary, so parsing is checked against git's actual output.

func TestSnapshotComparesWorkingTreeWithMergeBase(t *testing.T) {
	root := newRepository(t)
	writeFile(t, root, "README.md", "hello\n")
	writeFile(t, root, "src/keep.ts", "a\nb\nc\n")
	writeFile(t, root, "src/old-name.ts", strings.Repeat("same line\n", 20))
	writeFile(t, root, "src/gone.ts", "x\ny\n")
	gitCommand(t, root, "add", ".")
	gitCommand(t, root, "commit", "-q", "-m", "base")
	gitCommand(t, root, "switch", "-q", "-c", "feature")

	// Committed on the branch.
	gitCommand(t, root, "mv", "src/old-name.ts", "src/new-name.ts")
	gitCommand(t, root, "rm", "-q", "src/gone.ts")
	gitCommand(t, root, "commit", "-q", "-m", "rename and delete")
	// Uncommitted: an edit, a staged new file, an untracked file, a binary.
	writeFile(t, root, "src/keep.ts", "a\nB\nc\nd\n")
	writeFile(t, root, "src/staged.ts", "one\ntwo")
	gitCommand(t, root, "add", "src/staged.ts")
	writeFile(t, root, "notes/untracked.md", "1\n2\n3\n")
	writeFile(t, root, "image.bin", "\x00\x01\x02")
	writeFile(t, root, ".gitignore", "ignored/\n")
	writeFile(t, root, "ignored/big.log", "never listed\n")

	repository, err := Open(context.Background(), filepath.Join(root, "src"), "")
	check(t, err)
	snapshot, err := repository.Snapshot(context.Background())
	check(t, err)

	if snapshot.HeadRef != "feature" || snapshot.BaseRef != "main" || !snapshot.Uncommitted {
		t.Fatalf("snapshot = head %q base %q uncommitted %v", snapshot.HeadRef, snapshot.BaseRef, snapshot.Uncommitted)
	}
	if snapshot.Name != filepath.Base(root) || snapshot.BaseSHA == snapshot.HeadSHA {
		t.Fatalf("name %q, base %s, head %s", snapshot.Name, snapshot.BaseSHA, snapshot.HeadSHA)
	}
	want := []string{
		".gitignore A +1 -0",
		"image.bin A +0 -0",
		"notes/untracked.md A +3 -0",
		"src/gone.ts D +0 -2",
		"src/keep.ts M +2 -1",
		"src/new-name.ts R +0 -0",
		"src/staged.ts A +2 -0",
	}
	if got := describeFiles(snapshot.Files); !slices.Equal(got, want) {
		t.Fatalf("files =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if snapshot.Additions != 8 || snapshot.Deletions != 3 {
		t.Fatalf("totals = +%d -%d", snapshot.Additions, snapshot.Deletions)
	}
	wantTree := []string{
		".gitignore 9", "README.md 6", "image.bin 3", "notes/untracked.md 6",
		"src/keep.ts 8", "src/new-name.ts 200", "src/staged.ts 7",
	}
	if got := describeTree(snapshot.Tree); !slices.Equal(got, wantTree) {
		t.Fatalf("tree = %v, want %v", got, wantTree)
	}
}

func TestSnapshotOnBaseBranchShowsOnlyUncommittedWork(t *testing.T) {
	root := newRepository(t)
	writeFile(t, root, "a.txt", "a\n")
	gitCommand(t, root, "add", ".")
	gitCommand(t, root, "commit", "-q", "-m", "base")

	repository, err := Open(context.Background(), root, "")
	check(t, err)
	snapshot, err := repository.Snapshot(context.Background())
	check(t, err)
	if len(snapshot.Files) != 0 || snapshot.Uncommitted || snapshot.BaseSHA != snapshot.HeadSHA {
		t.Fatalf("clean checkout of the base: %+v", snapshot)
	}

	writeFile(t, root, "a.txt", "a\nb\n")
	snapshot, err = repository.Snapshot(context.Background())
	check(t, err)
	if got := describeFiles(snapshot.Files); !slices.Equal(got, []string{"a.txt M +1 -0"}) || !snapshot.Uncommitted {
		t.Fatalf("files = %v, uncommitted %v", got, snapshot.Uncommitted)
	}
}

func TestSnapshotBaseSelection(t *testing.T) {
	root := newRepository(t)
	writeFile(t, root, "a.txt", "a\n")
	gitCommand(t, root, "add", ".")
	gitCommand(t, root, "commit", "-q", "-m", "base")
	gitCommand(t, root, "branch", "-m", "trunk")

	repository, err := Open(context.Background(), root, "")
	check(t, err)
	if _, err := repository.Snapshot(context.Background()); err == nil || !strings.Contains(err.Error(), "pass -base") {
		t.Fatalf("no base branch: error = %v", err)
	}
	repository, err = Open(context.Background(), root, "nope")
	check(t, err)
	if _, err := repository.Snapshot(context.Background()); err == nil || !strings.Contains(err.Error(), `"nope"`) {
		t.Fatalf("unknown base: error = %v", err)
	}
	repository, err = Open(context.Background(), root, "trunk")
	check(t, err)
	snapshot, err := repository.Snapshot(context.Background())
	check(t, err)
	if snapshot.BaseRef != "trunk" {
		t.Fatalf("base = %q", snapshot.BaseRef)
	}
}

// Methodology: origin/HEAD is written by hand as a symbolic ref, the way a
// clone leaves it, so no remote is needed.
func TestSnapshotBaseFromOriginHEAD(t *testing.T) {
	root := newRepository(t)
	writeFile(t, root, "a.txt", "a\n")
	gitCommand(t, root, "add", ".")
	gitCommand(t, root, "commit", "-q", "-m", "base")
	gitCommand(t, root, "update-ref", "refs/remotes/origin/main", "HEAD")
	gitCommand(t, root, "update-ref", "refs/remotes/origin/develop", "HEAD")
	repository, err := Open(context.Background(), root, "")
	check(t, err)

	gitCommand(t, root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop")
	snapshot, err := repository.Snapshot(context.Background())
	check(t, err)
	if snapshot.BaseRef != "origin/develop" {
		t.Fatalf("origin/HEAD names origin/develop: base = %q", snapshot.BaseRef)
	}

	// A clone made before the remote renamed master to main, then pruned.
	gitCommand(t, root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master")
	snapshot, err = repository.Snapshot(context.Background())
	check(t, err)
	if snapshot.BaseRef != "origin/main" {
		t.Fatalf("origin/HEAD names a deleted ref: base = %q", snapshot.BaseRef)
	}
}

func TestSnapshotUnrelatedHistory(t *testing.T) {
	root := newRepository(t)
	writeFile(t, root, "a.txt", "a\n")
	gitCommand(t, root, "add", ".")
	gitCommand(t, root, "commit", "-q", "-m", "base")
	gitCommand(t, root, "switch", "-q", "--orphan", "island")
	writeFile(t, root, "b.txt", "b\n")
	gitCommand(t, root, "add", ".")
	gitCommand(t, root, "commit", "-q", "-m", "island")

	repository, err := Open(context.Background(), root, "")
	check(t, err)
	if _, err := repository.Snapshot(context.Background()); err == nil || !strings.Contains(err.Error(), "main and HEAD share no history") {
		t.Fatalf("orphan branch: error = %v", err)
	}
}

func TestOpenRejectsDirectoryOutsideRepository(t *testing.T) {
	requireGit(t)
	if _, err := Open(context.Background(), t.TempDir(), ""); err == nil {
		t.Fatal("a plain directory opened as a repository")
	}
}

func TestSnapshotWithoutCommits(t *testing.T) {
	root := newRepository(t)
	repository, err := Open(context.Background(), root, "")
	check(t, err)
	if _, err := repository.Snapshot(context.Background()); err != ErrNoCommits {
		t.Fatalf("error = %v, want ErrNoCommits", err)
	}
}

func TestParseNumstatHandlesRenamesAndBinaries(t *testing.T) {
	output := []byte("3\t1\tsrc/a.ts\x00-\t-\tlogo.png\x000\t0\t\x00old/b.ts\x00new/b.ts\x00")
	counts, err := parseNumstat(output)
	check(t, err)
	if counts["src/a.ts"] != (lineCount{3, 1}) || counts["logo.png"] != (lineCount{}) || counts["new/b.ts"] != (lineCount{}) {
		t.Fatalf("counts = %v", counts)
	}
	if _, present := counts["old/b.ts"]; present || len(counts) != 3 {
		t.Fatalf("counts = %v", counts)
	}
	if _, err := parseNumstat([]byte("3\t1\t\x00only-source\x00")); err == nil {
		t.Fatal("truncated rename parsed")
	}
}

func describeFiles(files []pullrequest.ChangedFile) []string {
	letters := map[pullrequest.Status]string{
		pullrequest.StatusAdded: "A", pullrequest.StatusModified: "M",
		pullrequest.StatusDeleted: "D", pullrequest.StatusRenamed: "R",
	}
	described := make([]string, 0, len(files))
	for _, file := range files {
		described = append(described, file.Path()+" "+letters[file.Status()]+
			" +"+strconv.FormatInt(file.Additions(), 10)+" -"+strconv.FormatInt(file.Deletions(), 10))
	}
	slices.Sort(described)
	return described
}

func describeTree(tree pullrequest.Tree) []string {
	described := make([]string, 0, tree.Len())
	for index := 0; index < tree.Len(); index++ {
		described = append(described, tree.Path(index)+" "+strconv.FormatInt(tree.Size(index), 10))
	}
	slices.Sort(described)
	return described
}

func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
}

func newRepository(t *testing.T) string {
	t.Helper()
	requireGit(t)
	root := t.TempDir()
	gitCommand(t, root, "init", "-q", "-b", "main")
	gitCommand(t, root, "config", "user.email", "test@example.com")
	gitCommand(t, root, "config", "user.name", "Test")
	gitCommand(t, root, "config", "commit.gpgsign", "false")
	return root
}

func gitCommand(t *testing.T, root string, arguments ...string) {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", root}, arguments...)...)
	command.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", arguments, err, output)
	}
}

func writeFile(t *testing.T, root string, path string, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(path))
	check(t, os.MkdirAll(filepath.Dir(full), 0o755))
	check(t, os.WriteFile(full, []byte(content), 0o644))
}

func check(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
