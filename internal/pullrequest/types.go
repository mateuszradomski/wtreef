package pullrequest

import "errors"

const (
	CommitSHALength = 40
	// PathLengthMax is far above git's practical limits; it bounds work per path.
	PathLengthMax = 4096
	// TreeEntriesMax leaves headroom over GitHub's 100k-entry recursive tree cap.
	TreeEntriesMax = 1_000_000
)

var (
	ErrCommitSHAInvalid   = errors.New("commit SHA must be 40 lowercase hexadecimal characters")
	ErrPathInvalid        = errors.New("path must be relative, without empty, '.' or '..' segments or NUL bytes")
	ErrChangedFileInvalid = errors.New("changed file must have a change status and non-negative line counts")
	ErrTreeInvalid        = errors.New("tree must have matching paths and non-negative sizes within bounds")
)

// CommitSHA is a full lowercase hexadecimal SHA-1 object name. It is safe to
// use as a file name.
type CommitSHA struct {
	hexadecimal string
}

// Status is a file's change status, numbered as in the wire format.
type Status int8

const (
	StatusUnchanged Status = 0
	StatusAdded     Status = 1
	StatusModified  Status = 2
	StatusDeleted   Status = 3
	StatusRenamed   Status = 4
)

type State int8

const (
	StateOpen   State = 1
	StateClosed State = 2
	StateMerged State = 3
)

// ChangedFile is one entry of a pull request's file list.
type ChangedFile struct {
	path      string
	status    Status
	additions int64
	deletions int64
}

// Tree is the head commit's file listing: blobs with their sizes and
// submodules with size 0. Directories are implied by paths.
type Tree struct {
	truncated bool
	paths     []string
	sizes     []int64
}

// PullRequest is the metadata and changed files of a public pull request.
type PullRequest struct {
	Repository   Repository
	Number       int32
	Title        string
	URL          string
	Author       string
	State        State
	BaseRef      string
	HeadRef      string
	BaseSHA      CommitSHA
	HeadSHA      CommitSHA
	Additions    int64
	Deletions    int64
	ChangedFiles int64
	Files        []ChangedFile
}

func ParseCommitSHA(hexadecimal string) (CommitSHA, error) {
	if !IsCommitSHA(hexadecimal) {
		return CommitSHA{}, ErrCommitSHAInvalid
	}
	return CommitSHA{hexadecimal: hexadecimal}, nil
}

func IsCommitSHA(hexadecimal string) bool {
	if len(hexadecimal) != CommitSHALength {
		return false
	}
	for index := 0; index < len(hexadecimal); index++ {
		character := hexadecimal[index]
		isDigit := character >= '0' && character <= '9'
		isLowerHex := character >= 'a' && character <= 'f'
		if !isDigit && !isLowerHex {
			return false
		}
	}
	return true
}

func (sha CommitSHA) String() string {
	assert(len(sha.hexadecimal) == CommitSHALength, "CommitSHA must come from ParseCommitSHA")
	return sha.hexadecimal
}

func (state State) String() string {
	switch state {
	case StateOpen:
		return "open"
	case StateClosed:
		return "closed"
	case StateMerged:
		return "merged"
	}
	panic("assertion failed: State must be open, closed, or merged")
}

// IsPath reports whether path is a well-formed git path: relative, with
// non-empty segments that are not "." or "..", and without NUL bytes.
func IsPath(path string) bool {
	if len(path) == 0 || len(path) > PathLengthMax {
		return false
	}
	segmentStart := 0
	for index := 0; index <= len(path); index++ {
		if index < len(path) && path[index] == 0 {
			return false
		}
		if index < len(path) && path[index] != '/' {
			continue
		}
		segment := path[segmentStart:index]
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
		segmentStart = index + 1
	}
	return true
}

func NewChangedFile(path string, status Status, additions int64, deletions int64) (ChangedFile, error) {
	if !IsPath(path) {
		return ChangedFile{}, ErrPathInvalid
	}
	if status < StatusAdded || status > StatusRenamed {
		return ChangedFile{}, ErrChangedFileInvalid
	}
	if additions < 0 || deletions < 0 {
		return ChangedFile{}, ErrChangedFileInvalid
	}
	return ChangedFile{path: path, status: status, additions: additions, deletions: deletions}, nil
}

func (file ChangedFile) Path() string {
	assert(file.path != "", "ChangedFile must come from NewChangedFile")
	return file.path
}

func (file ChangedFile) Status() Status   { return file.status }
func (file ChangedFile) Additions() int64 { return file.additions }
func (file ChangedFile) Deletions() int64 { return file.deletions }

// ParseTree takes ownership of paths and sizes.
func ParseTree(truncated bool, paths []string, sizes []int64) (Tree, error) {
	if len(paths) != len(sizes) || len(paths) > TreeEntriesMax {
		return Tree{}, ErrTreeInvalid
	}
	for index := range paths {
		if !IsPath(paths[index]) {
			return Tree{}, ErrPathInvalid
		}
		if sizes[index] < 0 {
			return Tree{}, ErrTreeInvalid
		}
	}
	return Tree{truncated: truncated, paths: paths, sizes: sizes}, nil
}

func (tree Tree) Truncated() bool { return tree.truncated }
func (tree Tree) Len() int        { return len(tree.paths) }

func (tree Tree) Path(index int) string {
	assert(index >= 0, "tree index is not negative")
	assert(index < len(tree.paths), "tree index is in bounds")
	return tree.paths[index]
}

func (tree Tree) Size(index int) int64 {
	assert(index >= 0, "tree index is not negative")
	assert(index < len(tree.sizes), "tree index is in bounds")
	return tree.sizes[index]
}

// FilesTruncated reports that GitHub returned fewer files than it counted.
func (pull PullRequest) FilesTruncated() bool {
	return int64(len(pull.Files)) < pull.ChangedFiles
}
