package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"wtreef/internal/localgit"
	"wtreef/internal/pullrequest"
)

type fakeBranch struct {
	snapshot localgit.Snapshot
	err      error
}

func (fake *fakeBranch) Snapshot(ctx context.Context) (localgit.Snapshot, error) {
	return fake.snapshot, fake.err
}

func newFakeBranch(t *testing.T) *fakeBranch {
	t.Helper()
	file, err := pullrequest.NewChangedFile("src/index.ts", pullrequest.StatusModified, 4, 1)
	check(t, err)
	tree, err := pullrequest.ParseTree(false, []string{"README.md", "src/index.ts"}, []int64{100, 1820})
	check(t, err)
	return &fakeBranch{snapshot: localgit.Snapshot{
		Name: "wtreef", HeadRef: "local-mode", BaseRef: "origin/main",
		BaseSHA: testHeadSHA, HeadSHA: testHeadSHA, Uncommitted: true, Additions: 4, Deletions: 1,
		Files: []pullrequest.ChangedFile{file}, Tree: tree,
	}}
}

func newTestLocalServer(t *testing.T, branch LocalBranch) *LocalServer {
	t.Helper()
	server, err := NewLocal(LocalConfig{
		Branch: branch, Assets: testAssets(), AllowedHosts: []string{"localhost", "127.0.0.1", "::1"},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	check(t, err)
	return server
}

func TestLocalServesBranch(t *testing.T) {
	server := newTestLocalServer(t, newFakeBranch(t))
	response := serve(server, http.MethodGet, "http://localhost:3753/api/local", nil)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status %d, headers %v", response.Code, response.Header())
	}
	var body struct {
		Version int `json:"version"`
		Branch  struct {
			Repo         string `json:"repo"`
			HeadRef      string `json:"headRef"`
			BaseRef      string `json:"baseRef"`
			Uncommitted  bool   `json:"uncommitted"`
			ChangedFiles int64  `json:"changedFiles"`
		} `json:"branch"`
		Tree struct {
			Names []string `json:"names"`
		} `json:"tree"`
	}
	check(t, json.Unmarshal(response.Body.Bytes(), &body))
	if body.Version != 1 || body.Branch.Repo != "wtreef" || body.Branch.HeadRef != "local-mode" ||
		body.Branch.BaseRef != "origin/main" || !body.Branch.Uncommitted || body.Branch.ChangedFiles != 1 {
		t.Fatalf("body = %+v", body)
	}
	if !strings.Contains(strings.Join(body.Tree.Names, "/"), "index.ts") {
		t.Fatalf("tree names = %v", body.Tree.Names)
	}
}

func TestLocalRoutes(t *testing.T) {
	server := newTestLocalServer(t, newFakeBranch(t))
	testCases := []struct {
		target string
		status int
	}{
		{"http://localhost:3753/", http.StatusOK},
		{"http://localhost:3753/healthz", http.StatusOK},
		{"http://localhost:3753/assets/app.js", http.StatusOK},
		{"http://localhost:3753/l2beat/l2beat/pull/1", http.StatusNotFound},
		{"http://localhost:3753/api/pr/l2beat/l2beat/1", http.StatusNotFound},
		{"http://127.0.0.1:3753/", http.StatusOK},
		{"http://[::1]:3753/", http.StatusOK},
		{"http://LOCALHOST/", http.StatusOK},
		{"http://attacker.example:3753/api/local", http.StatusForbidden},
		{"http://localhost.attacker.example/", http.StatusForbidden},
	}
	for _, testCase := range testCases {
		response := serve(server, http.MethodGet, testCase.target, nil)
		if response.Code != testCase.status {
			t.Errorf("GET %s = %d, want %d", testCase.target, response.Code, testCase.status)
		}
	}
	page := serve(server, http.MethodGet, "http://localhost:3753/", nil)
	if strings.Contains(page.Body.String(), modePlaceholder) {
		t.Fatal("mode placeholder left in the page")
	}
}

func TestLocalPageCarriesMode(t *testing.T) {
	assets := testAssets()
	assets["index.html"].Data = []byte(`<meta name="wtreef-mode" content="{{MODE}}"><script src="/assets/app.js?v={{VERSION}}"></script>`)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	local, err := NewLocal(LocalConfig{Branch: newFakeBranch(t), Assets: assets, Logger: logger})
	check(t, err)
	if body := serve(local, http.MethodGet, "/", nil).Body.String(); !strings.Contains(body, `content="local"`) {
		t.Fatalf("local page = %s", body)
	}
	web := newTestServer(t, testServerOptions{github: newFakeGitHub(t), assets: assets})
	if body := serve(web, http.MethodGet, "/", nil).Body.String(); !strings.Contains(body, `content="web"`) {
		t.Fatalf("web page = %s", body)
	}
}

func TestLocalErrorIsReported(t *testing.T) {
	server := newTestLocalServer(t, &fakeBranch{err: errors.New("could not find a base branch")})
	response := serve(server, http.MethodGet, "http://localhost/api/local", nil)
	var body apiError
	check(t, json.Unmarshal(response.Body.Bytes(), &body))
	if response.Code != http.StatusInternalServerError || body.Error != "local_error" ||
		!strings.Contains(body.Message, "base branch") {
		t.Fatalf("status %d, body %+v", response.Code, body)
	}
}
