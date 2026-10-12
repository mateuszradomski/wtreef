package pullrequest

import (
	"errors"
	"strings"
	"testing"
)

// Methodology: every rule in the contract's "Path parsing" section gets a
// boundary case on each side (just valid, just invalid), plus inputs that
// a lenient parser (strconv, regex without anchors) would wrongly accept.
func TestParseID(t *testing.T) {
	type testCase struct {
		name   string
		owner  string
		repo   string
		number string
		err    error
	}
	testCases := []testCase{
		{"typical", "l2beat", "l2beat", "13157", nil},
		{"owner single character", "a", "r", "1", nil},
		{"owner 39 characters", strings.Repeat("a", 39), "r", "1", nil},
		{"owner inner hyphens", "a-b--c", "r", "1", nil},
		{"owner digits and uppercase", "Org123", "r", "1", nil},
		{"repo dots underscores hyphens", "o", "my.repo_name-x", "1", nil},
		{"repo 100 characters", "o", strings.Repeat("r", 100), "1", nil},
		{"repo triple dot", "o", "...", "1", nil},
		{"repo leading dot", "o", ".github", "1", nil},
		{"number max", "o", "r", "2147483647", nil},
		{"owner empty", "", "r", "1", ErrOwnerInvalid},
		{"owner 40 characters", strings.Repeat("a", 40), "r", "1", ErrOwnerInvalid},
		{"owner leading hyphen", "-a", "r", "1", ErrOwnerInvalid},
		{"owner trailing hyphen", "a-", "r", "1", ErrOwnerInvalid},
		{"owner only hyphen", "-", "r", "1", ErrOwnerInvalid},
		{"owner underscore", "a_b", "r", "1", ErrOwnerInvalid},
		{"owner dot", "a.b", "r", "1", ErrOwnerInvalid},
		{"owner non-ASCII", "zażółć", "r", "1", ErrOwnerInvalid},
		{"owner percent encoded", "a%2Fb", "r", "1", ErrOwnerInvalid},
		{"repo empty", "o", "", "1", ErrRepoInvalid},
		{"repo 101 characters", "o", strings.Repeat("r", 101), "1", ErrRepoInvalid},
		{"repo dot", "o", ".", "1", ErrRepoInvalid},
		{"repo dot dot", "o", "..", "1", ErrRepoInvalid},
		{"repo slash", "o", "a/b", "1", ErrRepoInvalid},
		{"repo space", "o", "a b", "1", ErrRepoInvalid},
		{"repo NUL", "o", "a\x00", "1", ErrRepoInvalid},
		{"number empty", "o", "r", "", ErrNumberInvalid},
		{"number zero", "o", "r", "0", ErrNumberInvalid},
		{"number leading zero", "o", "r", "01", ErrNumberInvalid},
		{"number plus sign", "o", "r", "+1", ErrNumberInvalid},
		{"number minus sign", "o", "r", "-1", ErrNumberInvalid},
		{"number above max", "o", "r", "2147483648", ErrNumberInvalid},
		{"number eleven digits", "o", "r", "10000000000", ErrNumberInvalid},
		{"number twenty digits", "o", "r", "99999999999999999999", ErrNumberInvalid},
		{"number hex", "o", "r", "0x1", ErrNumberInvalid},
		{"number decimal point", "o", "r", "1.0", ErrNumberInvalid},
		{"number trailing letter", "o", "r", "12a", ErrNumberInvalid},
		{"number whitespace", "o", "r", " 1", ErrNumberInvalid},
		{"number full-width digit", "o", "r", "１", ErrNumberInvalid},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			id, err := ParseID(testCase.owner, testCase.repo, testCase.number)
			if !errors.Is(err, testCase.err) {
				t.Fatalf("ParseID(%q, %q, %q) error = %v, want %v",
					testCase.owner, testCase.repo, testCase.number, err, testCase.err)
			}
			if err != nil {
				return
			}
			if id.Repository().Owner() != testCase.owner || id.Repository().Name() != testCase.repo {
				t.Fatalf("ParseID kept %q/%q, want %q/%q",
					id.Repository().Owner(), id.Repository().Name(), testCase.owner, testCase.repo)
			}
			if got := id.String(); got != testCase.owner+"/"+testCase.repo+"#"+testCase.number {
				t.Fatalf("String() = %q", got)
			}
		})
	}
}

func TestCacheKeyIsCaseInsensitive(t *testing.T) {
	upper, err := ParseID("L2Beat", "L2BEAT", "42")
	if err != nil {
		t.Fatal(err)
	}
	lower, err := ParseID("l2beat", "l2beat", "42")
	if err != nil {
		t.Fatal(err)
	}
	if upper.CacheKey() != lower.CacheKey() {
		t.Fatalf("cache keys differ: %q vs %q", upper.CacheKey(), lower.CacheKey())
	}
	if upper.CacheKey() != "l2beat/l2beat#42" {
		t.Fatalf("CacheKey() = %q", upper.CacheKey())
	}
}

func TestParseNameWithOwner(t *testing.T) {
	repository, err := ParseNameWithOwner("Microsoft/vscode")
	if err != nil || repository.Owner() != "Microsoft" || repository.Name() != "vscode" {
		t.Fatalf("ParseNameWithOwner = %v, %v", repository, err)
	}
	for _, invalid := range []string{"", "noslash", "a/b/c", "/b", "a/", "-a/b", "a/.."} {
		if _, err := ParseNameWithOwner(invalid); err == nil {
			t.Fatalf("ParseNameWithOwner(%q) accepted", invalid)
		}
	}
}

func TestZeroValueIDAsserts(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("zero ID did not assert")
		}
	}()
	_ = ID{}.Number()
}

func TestParseCommitSHA(t *testing.T) {
	valid := "81f6d0e53bf3b57632075b9e37590b3b37e50be3"
	if sha, err := ParseCommitSHA(valid); err != nil || sha.String() != valid {
		t.Fatalf("ParseCommitSHA(valid) = %v, %v", sha, err)
	}
	invalid := []string{
		"",
		valid[:39],
		valid + "0",
		strings.ToUpper(valid),
		"../../../../../../../../../../etc/passwd",
		"81f6d0e53bf3b57632075b9e37590b3b37e50be/",
		"g1f6d0e53bf3b57632075b9e37590b3b37e50be3",
	}
	for _, candidate := range invalid {
		if _, err := ParseCommitSHA(candidate); err == nil {
			t.Fatalf("ParseCommitSHA(%q) accepted", candidate)
		}
	}
}

func TestIsPath(t *testing.T) {
	valid := []string{"a", "a/b", "a/b/c.txt", ".github/workflows/ci.yml", "...", "a/.b"}
	for _, path := range valid {
		if !IsPath(path) {
			t.Fatalf("IsPath(%q) = false", path)
		}
	}
	invalid := []string{"", "/", "/a", "a/", "a//b", ".", "..", "a/./b", "a/../b", "a\x00b", strings.Repeat("a", PathLengthMax+1)}
	for _, path := range invalid {
		if IsPath(path) {
			t.Fatalf("IsPath(%q) = true", path)
		}
	}
}

func TestParseTreeRejectsMalformedInput(t *testing.T) {
	if _, err := ParseTree(false, []string{"a"}, []int64{1, 2}); err == nil {
		t.Fatal("length mismatch accepted")
	}
	if _, err := ParseTree(false, []string{"a"}, []int64{-1}); err == nil {
		t.Fatal("negative size accepted")
	}
	if _, err := ParseTree(false, []string{"a//b"}, []int64{1}); err == nil {
		t.Fatal("empty segment accepted")
	}
	tree, err := ParseTree(true, []string{"a", "b/c"}, []int64{1, 0})
	if err != nil || tree.Len() != 2 || !tree.Truncated() || tree.Path(1) != "b/c" || tree.Size(0) != 1 {
		t.Fatalf("ParseTree(valid) = %v, %v", tree, err)
	}
}

func TestNewChangedFileRejectsMalformedInput(t *testing.T) {
	if _, err := NewChangedFile("a", StatusUnchanged, 0, 0); err == nil {
		t.Fatal("unchanged status accepted")
	}
	if _, err := NewChangedFile("a", StatusRenamed+1, 0, 0); err == nil {
		t.Fatal("out-of-range status accepted")
	}
	if _, err := NewChangedFile("a", StatusAdded, -1, 0); err == nil {
		t.Fatal("negative additions accepted")
	}
	if _, err := NewChangedFile("/a", StatusAdded, 0, 0); err == nil {
		t.Fatal("absolute path accepted")
	}
}
