// Package localgit reads a branch from a local checkout: the working tree
// compared with the commit where the branch left its base. Every call shells
// out to git, so the answer is always the checkout's current state.
package localgit

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"wtreef/internal/pullrequest"
)

const (
	// binarySniffBytes matches git's own heuristic: a NUL in the first 8000
	// bytes makes a file binary, and binary files count no lines.
	binarySniffBytes = 8000
	gitlinkMode      = "160000"
	errorOutputMax   = 512
)

// baseCandidates are tried in order when no base is given and origin/HEAD
// is not set.
var baseCandidates = []string{"origin/main", "origin/master", "main", "master"}

var ErrNoCommits = errors.New("the repository has no commits yet")

// Repository is a checkout opened by Open. Base is re-resolved on every
// Snapshot, so switching branches is picked up on the next page load.
type Repository struct {
	root string
	// base is the ref given on the command line; "" means detect it.
	base string
}

// Snapshot is the branch as the page shows it: changed files between the
// merge base and the working tree, and the working tree's file listing.
type Snapshot struct {
	Name string
	Root string
	// HeadRef is the checked-out branch, "" when HEAD is detached.
	HeadRef string
	BaseRef string
	// BaseSHA is the merge base of BaseRef and HEAD.
	BaseSHA     string
	HeadSHA     string
	Uncommitted bool
	Additions   int64
	Deletions   int64
	Files       []pullrequest.ChangedFile
	Tree        pullrequest.Tree
}

// Open finds the root of the checkout containing directory.
func Open(ctx context.Context, directory string, base string) (*Repository, error) {
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return nil, err
	}
	output, err := runGit(ctx, absolute, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, fmt.Errorf("%s is not inside a git repository", absolute)
	}
	root := strings.TrimSuffix(string(output), "\n")
	if root == "" {
		return nil, fmt.Errorf("%s is not inside a work tree", absolute)
	}
	return &Repository{root: filepath.Clean(root), base: base}, nil
}

func (repository *Repository) Root() string { return repository.root }

func (repository *Repository) Snapshot(ctx context.Context) (Snapshot, error) {
	headSHA, err := repository.revParse(ctx, "HEAD")
	if err != nil {
		return Snapshot{}, ErrNoCommits
	}
	baseRef, err := repository.resolveBase(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	mergeBase, err := repository.git(ctx, "merge-base", baseRef, "HEAD")
	if err != nil {
		return Snapshot{}, fmt.Errorf("%s and HEAD share no history", baseRef)
	}
	snapshot := Snapshot{
		Name:    filepath.Base(repository.root),
		Root:    repository.root,
		HeadRef: repository.headRef(ctx),
		BaseRef: baseRef,
		BaseSHA: strings.TrimSpace(string(mergeBase)),
		HeadSHA: headSHA,
	}
	if !isObjectName(snapshot.BaseSHA) {
		return Snapshot{}, fmt.Errorf("git merge-base printed %q", snapshot.BaseSHA)
	}
	untracked, err := repository.untrackedPaths(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	snapshot.Files, err = repository.changedFiles(ctx, snapshot.BaseSHA, untracked)
	if err != nil {
		return Snapshot{}, err
	}
	for _, file := range snapshot.Files {
		snapshot.Additions += file.Additions()
		snapshot.Deletions += file.Deletions()
	}
	snapshot.Uncommitted, err = repository.hasUncommittedChanges(ctx, len(untracked) > 0)
	if err != nil {
		return Snapshot{}, err
	}
	snapshot.Tree, err = repository.workingTree(ctx, untracked)
	if err != nil {
		return Snapshot{}, err
	}
	return snapshot, nil
}

// resolveBase prefers the ref given on the command line, then the remote's
// default branch, then the usual names.
func (repository *Repository) resolveBase(ctx context.Context) (string, error) {
	if repository.base != "" {
		if _, err := repository.revParse(ctx, repository.base+"^{commit}"); err != nil {
			return "", fmt.Errorf("base %q is not a commit in this repository", repository.base)
		}
		return repository.base, nil
	}
	if output, err := repository.git(ctx, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"); err == nil {
		if ref := strings.TrimSpace(string(output)); ref != "" {
			return ref, nil
		}
	}
	for _, candidate := range baseCandidates {
		if _, err := repository.revParse(ctx, candidate+"^{commit}"); err == nil {
			return candidate, nil
		}
	}
	return "", errors.New("could not find a base branch (tried origin/HEAD, origin/main, origin/master, main, master); pass -base")
}

func (repository *Repository) headRef(ctx context.Context) string {
	output, err := repository.git(ctx, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func (repository *Repository) revParse(ctx context.Context, revision string) (string, error) {
	output, err := repository.git(ctx, "rev-parse", "--verify", "--quiet", "--end-of-options", revision)
	if err != nil {
		return "", err
	}
	sha := strings.TrimSpace(string(output))
	if !isObjectName(sha) {
		return "", fmt.Errorf("git rev-parse printed %q", sha)
	}
	return sha, nil
}

// changedFiles diffs the merge base against the working tree, staged or
// not, with renames detected, then adds untracked files as added.
func (repository *Repository) changedFiles(ctx context.Context, mergeBase string, untracked []string) ([]pullrequest.ChangedFile, error) {
	statusOutput, err := repository.git(ctx, "diff", "--no-color", "--no-ext-diff", "-M", "--name-status", "-z", mergeBase, "--")
	if err != nil {
		return nil, err
	}
	statuses, err := parseNameStatus(statusOutput)
	if err != nil {
		return nil, err
	}
	numstatOutput, err := repository.git(ctx, "diff", "--no-color", "--no-ext-diff", "-M", "--numstat", "-z", mergeBase, "--")
	if err != nil {
		return nil, err
	}
	lineCounts, err := parseNumstat(numstatOutput)
	if err != nil {
		return nil, err
	}
	files := make([]pullrequest.ChangedFile, 0, len(statuses)+len(untracked))
	for _, entry := range statuses {
		counts := lineCounts[entry.path]
		file, err := pullrequest.NewChangedFile(entry.path, entry.status, counts.additions, counts.deletions)
		if err != nil {
			return nil, fmt.Errorf("changed file %q: %w", entry.path, err)
		}
		files = append(files, file)
	}
	for _, path := range untracked {
		additions, err := countLines(filepath.Join(repository.root, filepath.FromSlash(path)))
		if err != nil {
			return nil, err
		}
		file, err := pullrequest.NewChangedFile(path, pullrequest.StatusAdded, additions, 0)
		if err != nil {
			return nil, fmt.Errorf("untracked file %q: %w", path, err)
		}
		files = append(files, file)
	}
	return files, nil
}

func (repository *Repository) untrackedPaths(ctx context.Context) ([]string, error) {
	output, err := repository.git(ctx, "ls-files", "-z", "--others", "--exclude-standard")
	if err != nil {
		return nil, err
	}
	paths := make([]string, 0)
	for _, path := range splitNUL(output) {
		// A nested repository is listed as "dir/"; it is not a file.
		if strings.HasSuffix(path, "/") {
			continue
		}
		paths = append(paths, path)
	}
	return paths, nil
}

func (repository *Repository) hasUncommittedChanges(ctx context.Context, hasUntracked bool) (bool, error) {
	if hasUntracked {
		return true, nil
	}
	_, err := repository.git(ctx, "diff", "--quiet", "--no-ext-diff", "HEAD", "--")
	if err == nil {
		return false, nil
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) && exitError.ExitCode() == 1 {
		return true, nil
	}
	return false, err
}

// workingTree lists the index plus untracked files, sized as they are on
// disk now. Files deleted from the disk are left out, as a head commit's
// tree would leave them out; submodules weigh nothing.
func (repository *Repository) workingTree(ctx context.Context, untracked []string) (pullrequest.Tree, error) {
	output, err := repository.git(ctx, "ls-files", "-z", "--stage")
	if err != nil {
		return pullrequest.Tree{}, err
	}
	entries := splitNUL(output)
	paths := make([]string, 0, len(entries)+len(untracked))
	sizes := make([]int64, 0, len(entries)+len(untracked))
	seen := make(map[string]struct{}, len(entries)+len(untracked))
	add := func(path string, isGitlink bool) error {
		if _, duplicate := seen[path]; duplicate {
			return nil
		}
		seen[path] = struct{}{}
		if isGitlink {
			paths = append(paths, path)
			sizes = append(sizes, 0)
			return nil
		}
		info, err := os.Lstat(filepath.Join(repository.root, filepath.FromSlash(path)))
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		paths = append(paths, path)
		sizes = append(sizes, info.Size())
		return nil
	}
	for _, entry := range entries {
		// "<mode> <object> <stage>\t<path>"; conflicted paths repeat per stage.
		metadata, path, found := strings.Cut(entry, "\t")
		if !found {
			return pullrequest.Tree{}, fmt.Errorf("git ls-files printed %q", entry)
		}
		if err := add(path, strings.HasPrefix(metadata, gitlinkMode+" ")); err != nil {
			return pullrequest.Tree{}, err
		}
	}
	for _, path := range untracked {
		if err := add(path, false); err != nil {
			return pullrequest.Tree{}, err
		}
	}
	return pullrequest.ParseTree(false, paths, sizes)
}

func (repository *Repository) git(ctx context.Context, arguments ...string) ([]byte, error) {
	return runGit(ctx, repository.root, arguments...)
}

// runGit pins the settings that change porcelain output so a user's config
// cannot reshape what is parsed here.
func runGit(ctx context.Context, directory string, arguments ...string) ([]byte, error) {
	fullArguments := append([]string{"-C", directory, "-c", "core.quotePath=false", "-c", "color.ui=never"}, arguments...)
	command := exec.CommandContext(ctx, "git", fullArguments...)
	command.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C")
	stderr := bytes.Buffer{}
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		message := strings.TrimSpace(stderr.String())
		if len(message) > errorOutputMax {
			message = message[:errorOutputMax]
		}
		return nil, fmt.Errorf("git %s: %w: %s", strings.Join(arguments, " "), err, message)
	}
	return output, nil
}

type statusEntry struct {
	path   string
	status pullrequest.Status
}

type lineCount struct {
	additions int64
	deletions int64
}

// parseNameStatus reads `git diff --name-status -z`: a status, then one
// path, or two (source, destination) for renames and copies.
func parseNameStatus(output []byte) ([]statusEntry, error) {
	fields := splitNUL(output)
	entries := make([]statusEntry, 0, len(fields)/2)
	for index := 0; index < len(fields); {
		code := fields[index]
		if code == "" {
			return nil, errors.New("git diff --name-status printed an empty status")
		}
		pathCount := 1
		if code[0] == 'R' || code[0] == 'C' {
			pathCount = 2
		}
		if index+pathCount >= len(fields) {
			return nil, fmt.Errorf("git diff --name-status ended inside entry %q", code)
		}
		path := fields[index+pathCount]
		index += 1 + pathCount
		status, known := statusByCode(code[0])
		if !known {
			continue
		}
		entries = append(entries, statusEntry{path: path, status: status})
	}
	return entries, nil
}

// statusByCode maps git's letters onto the wire format's statuses the way
// the GitHub client maps GitHub's: copies are additions, type changes and
// conflicts are modifications. Unknown letters ("X") are skipped.
func statusByCode(code byte) (pullrequest.Status, bool) {
	switch code {
	case 'A', 'C':
		return pullrequest.StatusAdded, true
	case 'M', 'T', 'U':
		return pullrequest.StatusModified, true
	case 'D':
		return pullrequest.StatusDeleted, true
	case 'R':
		return pullrequest.StatusRenamed, true
	}
	return 0, false
}

// parseNumstat reads `git diff --numstat -z`, keyed by destination path:
// "<added>\t<deleted>\t<path>" or, for renames, "<added>\t<deleted>\t"
// followed by the source and destination as their own fields. Binary
// files print "-" and count as zero lines.
func parseNumstat(output []byte) (map[string]lineCount, error) {
	fields := splitNUL(output)
	counts := make(map[string]lineCount, len(fields))
	for index := 0; index < len(fields); {
		added, rest, foundAdded := strings.Cut(fields[index], "\t")
		deleted, path, foundDeleted := strings.Cut(rest, "\t")
		if !foundAdded || !foundDeleted {
			return nil, fmt.Errorf("git diff --numstat printed %q", fields[index])
		}
		index++
		if path == "" {
			if index+1 >= len(fields) {
				return nil, errors.New("git diff --numstat ended inside a rename")
			}
			path = fields[index+1]
			index += 2
		}
		additions, err := parseLineCount(added)
		if err != nil {
			return nil, err
		}
		deletions, err := parseLineCount(deleted)
		if err != nil {
			return nil, err
		}
		counts[path] = lineCount{additions: additions, deletions: deletions}
	}
	return counts, nil
}

func parseLineCount(text string) (int64, error) {
	if text == "-" {
		return 0, nil
	}
	value, err := strconv.ParseInt(text, 10, 64)
	if err != nil || value < 0 {
		return 0, fmt.Errorf("git diff --numstat printed line count %q", text)
	}
	return value, nil
}

// countLines counts an untracked file's lines as git would show them added:
// zero for binaries and anything that is not a regular file.
func countLines(path string) (int64, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 {
		return 0, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, 64<<10)
	head, err := reader.Peek(binarySniffBytes)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, bufio.ErrBufferFull) {
		return 0, err
	}
	if bytes.IndexByte(head, 0) >= 0 {
		return 0, nil
	}
	lines := int64(0)
	endsWithNewline := false
	buffer := make([]byte, 64<<10)
	for {
		count, err := reader.Read(buffer)
		if count > 0 {
			lines += int64(bytes.Count(buffer[:count], []byte{'\n'}))
			endsWithNewline = buffer[count-1] == '\n'
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return 0, err
		}
	}
	if !endsWithNewline {
		lines++
	}
	return lines, nil
}

func splitNUL(output []byte) []string {
	text := strings.TrimSuffix(string(output), "\x00")
	if text == "" {
		return nil
	}
	return strings.Split(text, "\x00")
}

// isObjectName accepts SHA-1 and SHA-256 object names.
func isObjectName(text string) bool {
	if len(text) != 40 && len(text) != 64 {
		return false
	}
	for index := 0; index < len(text); index++ {
		character := text[index]
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}
