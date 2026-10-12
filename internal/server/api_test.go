package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"wtreef/internal/github"
)

func TestAPIServesTreeWithGzipNegotiation(t *testing.T) {
	fake := newFakeGitHub(t)
	server := newTestServer(t, testServerOptions{github: fake})
	compressed := serve(server, "GET", "/api/pr/l2beat/l2beat/13157", http.Header{"Accept-Encoding": {"gzip, deflate, br"}})
	plain := serve(server, "GET", "/api/pr/L2BEAT/L2Beat/13157", nil)
	refused := serve(server, "GET", "/api/pr/l2beat/l2beat/13157", http.Header{"Accept-Encoding": {"gzip;q=0, *"}})
	for name, response := range map[string]*httptest.ResponseRecorder{"gzip": compressed, "plain": plain, "refused": refused} {
		header := response.Header()
		if response.Code != 200 || header.Get("Vary") != "Accept-Encoding" ||
			header.Get("Cache-Control") != "public, max-age=60" || header.Get("Content-Type") != "application/json" {
			t.Fatalf("%s: %d %v", name, response.Code, header)
		}
	}
	if compressed.Header().Get("Content-Encoding") != "gzip" || plain.Header().Get("Content-Encoding") != "" ||
		refused.Header().Get("Content-Encoding") != "" {
		t.Fatal("Content-Encoding must follow Accept-Encoding")
	}
	body := gunzip(t, compressed.Body.Bytes())
	if !bytes.Equal(body, plain.Body.Bytes()) || !bytes.Equal(body, refused.Body.Bytes()) {
		t.Fatal("gzip and identity bodies differ")
	}
	if plain.Header().Get("Content-Length") != fmt.Sprint(len(body)) {
		t.Fatalf("Content-Length = %s, body %d", plain.Header().Get("Content-Length"), len(body))
	}
	var decoded struct {
		Version     int `json:"version"`
		PullRequest struct {
			Owner   string `json:"owner"`
			HeadSHA string `json:"headSha"`
		} `json:"pullRequest"`
		Tree struct {
			Names []string `json:"names"`
		} `json:"tree"`
	}
	check(t, json.Unmarshal(body, &decoded))
	if decoded.Version != 1 || decoded.PullRequest.Owner != "L2Beat" || decoded.PullRequest.HeadSHA != testHeadSHA {
		t.Fatalf("decoded = %+v", decoded)
	}
	wantNames := []string{"", "README.md", "packages", "backend", "frontend", "index.ts"}
	if strings.Join(decoded.Tree.Names, ",") != strings.Join(wantNames, ",") {
		t.Fatalf("names = %v", decoded.Tree.Names)
	}
	if fake.pullRequestCalls.Load() != 1 || fake.treeCalls.Load() != 1 {
		t.Fatalf("GitHub calls: pull %d tree %d; the response cache must absorb repeats, any casing",
			fake.pullRequestCalls.Load(), fake.treeCalls.Load())
	}
}

func TestAPITreeStoreSurvivesResponseCache(t *testing.T) {
	fake := newFakeGitHub(t)
	treeDirectory := t.TempDir()
	first := newTestServer(t, testServerOptions{github: fake, treeDirectory: treeDirectory})
	serve(first, "GET", "/api/pr/l2beat/l2beat/13157", nil)
	// A fresh server has an empty response cache but shares the disk store,
	// as after a restart: metadata is refetched, the tree is not.
	second := newTestServer(t, testServerOptions{github: fake, treeDirectory: treeDirectory})
	if response := serve(second, "GET", "/api/pr/l2beat/l2beat/13157", nil); response.Code != 200 {
		t.Fatalf("status %d", response.Code)
	}
	if fake.pullRequestCalls.Load() != 2 || fake.treeCalls.Load() != 1 {
		t.Fatalf("GitHub calls: pull %d tree %d", fake.pullRequestCalls.Load(), fake.treeCalls.Load())
	}
}

func TestAPIErrorMapping(t *testing.T) {
	type testCase struct {
		err        error
		status     int
		code       string
		retryAfter string
	}
	testCases := map[string]testCase{
		"not found":    {github.ErrNotFound, 404, "not_found", ""},
		"rate limited": {&github.RateLimitError{RetryAfterSeconds: 42}, 503, "github_rate_limited", "42"},
		"upstream":     {fmt.Errorf("%w: graphql: HTTP status 500", github.ErrUpstream), 502, "upstream_error", ""},
		"unexpected":   {errors.New("anything else"), 502, "upstream_error", ""},
	}
	for name, testCase := range testCases {
		t.Run(name, func(t *testing.T) {
			fake := newFakeGitHub(t)
			fake.pullRequestError = testCase.err
			server := newTestServer(t, testServerOptions{github: fake})
			for attempt := 1; attempt <= 2; attempt++ {
				response := serve(server, "GET", "/api/pr/l2beat/l2beat/13157", nil)
				var body apiError
				check(t, json.Unmarshal(response.Body.Bytes(), &body))
				if response.Code != testCase.status || body.Error != testCase.code || body.Message == "" {
					t.Fatalf("response = %d %+v", response.Code, body)
				}
				if response.Header().Get("Retry-After") != testCase.retryAfter || response.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("headers = %v", response.Header())
				}
				if fake.pullRequestCalls.Load() != int32(attempt) {
					t.Fatal("errors must not be cached")
				}
			}
		})
	}
}

func TestAPICoalescesConcurrentRequests(t *testing.T) {
	fake := newFakeGitHub(t)
	fake.release = make(chan struct{})
	server := newTestServer(t, testServerOptions{github: fake})
	go func() {
		// Let the requests pile up on the in-flight build before it finishes.
		time.Sleep(100 * time.Millisecond)
		close(fake.release)
	}()
	for _, response := range serveConcurrently(server, "/api/pr/l2beat/l2beat/13157", 20) {
		if response.Code != 200 {
			t.Fatalf("status %d", response.Code)
		}
	}
	if fake.pullRequestCalls.Load() != 1 || fake.treeCalls.Load() != 1 {
		t.Fatalf("GitHub calls: pull %d tree %d, want 1 each", fake.pullRequestCalls.Load(), fake.treeCalls.Load())
	}
}

// The deploy token may read private repositories. This runs the real GitHub
// client against a fake API and checks that a private repository's
// response is byte-for-byte the missing repository's response, that its
// tree is never fetched, and that nothing about it is cached or logged.
func TestAPIPrivateRepositoryIsIndistinguishableFromMissing(t *testing.T) {
	const secretTitle = "secret-roadmap-title"
	treeRequests := atomic.Int32{}
	api := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/graphql" {
			treeRequests.Add(1)
			http.Error(writer, "unexpected", http.StatusInternalServerError)
			return
		}
		var query struct {
			Variables struct {
				Name string `json:"name"`
			} `json:"variables"`
		}
		check(t, json.NewDecoder(request.Body).Decode(&query))
		writer.Header().Set("Content-Type", "application/json")
		if query.Variables.Name == "secret" {
			fmt.Fprintf(writer, `{"data":{"repository":{"isPrivate":true,"nameWithOwner":"acme/secret","pullRequest":{"title":%q,`+
				`"url":"https://github.com/acme/secret/pull/1","state":"OPEN","headRefOid":"%s","baseRefOid":"%s",`+
				`"changedFiles":1,"files":{"pageInfo":{"hasNextPage":false},"nodes":[{"path":"plans/secret.md","changeType":"ADDED"}]}}}}}`,
				secretTitle, testHeadSHA, testHeadSHA)
			return
		}
		fmt.Fprint(writer, `{"data":{"repository":null},"errors":[{"type":"NOT_FOUND","path":["repository"],"message":"Could not resolve"}]}`)
	}))
	defer api.Close()

	logs := &bytes.Buffer{}
	treeDirectory := t.TempDir()
	client := github.NewClient(github.Config{
		Token: "test-token", GraphQLURL: api.URL + "/graphql", RESTBaseURL: api.URL,
		ConcurrencyMax: 2, RequestTimeout: 5 * time.Second,
		Logger: slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
	})
	server := newTestServer(t, testServerOptions{github: client, treeDirectory: treeDirectory, logs: logs})

	private := serve(server, "GET", "/api/pr/acme/secret/1", http.Header{"Accept-Encoding": {"gzip"}})
	missing := serve(server, "GET", "/api/pr/acme/missing/1", http.Header{"Accept-Encoding": {"gzip"}})
	if private.Code != 404 || private.Code != missing.Code || !bytes.Equal(private.Body.Bytes(), missing.Body.Bytes()) {
		t.Fatalf("private %d %q vs missing %d %q", private.Code, private.Body, missing.Code, missing.Body)
	}
	if fmt.Sprint(private.Header()) != fmt.Sprint(missing.Header()) {
		t.Fatalf("headers differ: %v vs %v", private.Header(), missing.Header())
	}
	if treeRequests.Load() != 0 {
		t.Fatal("the private repository's tree was fetched")
	}
	if _, hit := server.responses.Get("acme/secret#1", time.Now()); hit {
		t.Fatal("the private repository's response was cached")
	}
	entries, err := os.ReadDir(treeDirectory)
	check(t, err)
	if len(entries) != 0 || strings.Contains(logs.String(), secretTitle) || strings.Contains(logs.String(), "plans/secret") {
		t.Fatalf("private contents persisted or logged: %v %s", entries, logs.String())
	}
}

func TestAcceptsGzip(t *testing.T) {
	testCases := map[string]bool{
		"":                      false,
		"gzip":                  true,
		"GZIP":                  true,
		"deflate, gzip;q=0.5":   true,
		"br;q=1.0, gzip; q=0.1": true,
		"gzip;q=0":              false,
		"gzip;q=0.000":          false,
		"*":                     true,
		"*;q=0":                 false,
		"gzip;q=0, *":           false,
		"identity":              false,
		"x-gzip":                true,
		"gzip;q=abc":            false,
		"gzip;q=2":              false,
		"gzipx":                 false,
	}
	for header, want := range testCases {
		if got := acceptsGzip([]string{header}); got != want {
			t.Errorf("acceptsGzip(%q) = %v, want %v", header, got, want)
		}
	}
	if !acceptsGzip([]string{"br", "gzip"}) {
		t.Error("multiple header lines must be combined")
	}
}
