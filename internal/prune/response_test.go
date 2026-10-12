package prune

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"wtreef/internal/pullrequest"
)

func testPullRequest(t *testing.T, files []pullrequest.ChangedFile, changedFiles int64) pullrequest.PullRequest {
	t.Helper()
	repository, err := pullrequest.ParseRepository("L2Beat", "l2beat")
	if err != nil {
		t.Fatal(err)
	}
	baseSHA, err := pullrequest.ParseCommitSHA("9da73dfae06746bd429870df0e9ac7099ae248a0")
	if err != nil {
		t.Fatal(err)
	}
	headSHA, err := pullrequest.ParseCommitSHA("81f6d0e53bf3b57632075b9e37590b3b37e50be3")
	if err != nil {
		t.Fatal(err)
	}
	return pullrequest.PullRequest{
		Repository: repository, Number: 13157, Title: "Blobs <page> & more",
		URL: "https://github.com/L2Beat/l2beat/pull/13157", Author: "", State: pullrequest.StateMerged,
		BaseRef: "main", HeadRef: "blobs-page", BaseSHA: baseSHA, HeadSHA: headSHA,
		Additions: 10, Deletions: 2, ChangedFiles: changedFiles, Files: files,
	}
}

// Methodology: decode the encoded body generically and compare key sets and
// value types with the contract, so a renamed struct tag or a []uint8 that
// encoding/json turns into base64 fails here rather than in the browser.
func TestMarshalMatchesWireFormat(t *testing.T) {
	files := newFiles(t, change{"src/a.ts", pullrequest.StatusRenamed, 4, 1})
	tree := newTree(t, true, entry{"src/a.ts", 99}, entry{"README.md", 5})
	fetchedAt := time.Date(2026, 10, 12, 13, 0, 0, 999, time.FixedZone("CEST", 7200))
	body := Marshal(NewResponse(testPullRequest(t, files, 2), tree, fetchedAt))

	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	checkKeys(t, decoded, "version", "pullRequest", "tree", "truncated", "fetchedAt")
	if decoded["version"] != float64(1) || decoded["fetchedAt"] != "2026-10-12T11:00:00Z" {
		t.Fatalf("version %v fetchedAt %v", decoded["version"], decoded["fetchedAt"])
	}
	pull := decoded["pullRequest"].(map[string]any)
	checkKeys(t, pull, "owner", "repo", "number", "title", "url", "author", "state", "baseRef", "headRef",
		"baseSha", "headSha", "additions", "deletions", "changedFiles")
	if pull["owner"] != "L2Beat" || pull["state"] != "merged" || pull["author"] != "" || pull["number"] != float64(13157) {
		t.Fatalf("pullRequest = %v", pull)
	}
	truncated := decoded["truncated"].(map[string]any)
	if !reflect.DeepEqual(truncated, map[string]any{"files": true, "tree": true}) {
		t.Fatalf("truncated = %v", truncated)
	}
	treeJSON := decoded["tree"].(map[string]any)
	checkKeys(t, treeJSON, "names", "parents", "kinds", "statuses", "bytes", "additions", "deletions", "fileCounts")
	for key, value := range treeJSON {
		array, isArray := value.([]any)
		if !isArray || len(array) != 4 {
			t.Fatalf("tree.%s = %v, want an array of 4", key, value)
		}
	}
	if !reflect.DeepEqual(treeJSON["statuses"], []any{0.0, 0.0, 0.0, 4.0}) {
		t.Fatalf("statuses = %v", treeJSON["statuses"])
	}
	if strings.ContainsAny(string(body), "<>&") || pull["title"] != "Blobs <page> & more" {
		t.Fatal("HTML-significant characters must be escaped on the wire and round-trip intact")
	}
}

func checkKeys(t *testing.T, object map[string]any, want ...string) {
	t.Helper()
	got := make([]string, 0, len(object))
	for key := range object {
		got = append(got, key)
	}
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("keys = %v, want %v", got, want)
	}
}

func TestStateStrings(t *testing.T) {
	want := map[pullrequest.State]string{
		pullrequest.StateOpen: "open", pullrequest.StateClosed: "closed", pullrequest.StateMerged: "merged",
	}
	for state, text := range want {
		if state.String() != text {
			t.Fatalf("%d.String() = %q, want %q", state, state.String(), text)
		}
	}
}
