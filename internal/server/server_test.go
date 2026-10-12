package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"wtreef/internal/cache"
	"wtreef/internal/pullrequest"
)

// Methodology: handlers run in-process against an in-memory asset FS and a
// fake GitHub that counts calls, so every test can assert both the HTTP
// result and how much upstream work it caused.

const testHeadSHA = "81f6d0e53bf3b57632075b9e37590b3b37e50be3"

type fakeGitHub struct {
	pullRequestCalls atomic.Int32
	treeCalls        atomic.Int32
	pullRequestError error
	// release, when set, blocks FetchPullRequest until it is closed.
	release chan struct{}
	pull    pullrequest.PullRequest
	tree    pullrequest.Tree
}

func (fake *fakeGitHub) FetchPullRequest(ctx context.Context, id pullrequest.ID) (pullrequest.PullRequest, error) {
	fake.pullRequestCalls.Add(1)
	if fake.release != nil {
		<-fake.release
	}
	if fake.pullRequestError != nil {
		return pullrequest.PullRequest{}, fake.pullRequestError
	}
	return fake.pull, nil
}

func (fake *fakeGitHub) FetchTree(ctx context.Context, repository pullrequest.Repository, sha pullrequest.CommitSHA) (pullrequest.Tree, error) {
	fake.treeCalls.Add(1)
	return fake.tree, nil
}

func newFakeGitHub(t *testing.T) *fakeGitHub {
	t.Helper()
	repository, err := pullrequest.ParseRepository("L2Beat", "l2beat")
	check(t, err)
	headSHA, err := pullrequest.ParseCommitSHA(testHeadSHA)
	check(t, err)
	file, err := pullrequest.NewChangedFile("packages/frontend/index.ts", pullrequest.StatusModified, 40, 3)
	check(t, err)
	tree, err := pullrequest.ParseTree(false,
		[]string{"README.md", "packages/frontend/index.ts", "packages/backend/main.ts"},
		[]int64{100, 1820, 5000})
	check(t, err)
	return &fakeGitHub{
		pull: pullrequest.PullRequest{
			Repository: repository, Number: 13157, Title: "Blobs page", URL: "https://github.com/L2Beat/l2beat/pull/13157",
			Author: "someone", State: pullrequest.StateOpen, BaseRef: "main", HeadRef: "blobs-page",
			BaseSHA: headSHA, HeadSHA: headSHA, Additions: 40, Deletions: 3, ChangedFiles: 1,
			Files: []pullrequest.ChangedFile{file},
		},
		tree: tree,
	}
}

func check(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func testAssets() fstest.MapFS {
	return fstest.MapFS{
		"index.html": {Data: []byte(`<!doctype html><link rel="stylesheet" href="/assets/style.css?v={{VERSION}}">` +
			`<script src="/assets/app.js?v={{VERSION}}"></script>`)},
		"app.js":    {Data: bytes.Repeat([]byte("console.log('wtreef');\n"), 200)},
		"style.css": {Data: []byte("body{margin:0}")},
		".gitkeep":  {Data: nil},
	}
}

type testServerOptions struct {
	github         GitHub
	assets         fstest.MapFS
	reloadAssets   bool
	clientIPHeader string
	limits         RateLimits
	treeDirectory  string
	logs           io.Writer
}

func newTestServer(t *testing.T, options testServerOptions) *Server {
	t.Helper()
	if options.assets == nil {
		options.assets = testAssets()
	}
	if options.limits == (RateLimits{}) {
		options.limits = RateLimits{RequestsPerMinute: 60_000, Burst: 1000, ClientsMax: 1000}
	}
	if options.treeDirectory == "" {
		options.treeDirectory = t.TempDir()
	}
	if options.logs == nil {
		options.logs = io.Discard
	}
	logger := slog.New(slog.NewTextHandler(options.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	trees, err := cache.OpenTreeStore(options.treeDirectory, 1<<30, logger)
	check(t, err)
	server, err := New(Config{
		GitHub: options.github, Trees: trees, Responses: cache.NewResponseCache(16, 1<<24, time.Minute),
		Assets: options.assets, ReloadAssets: options.reloadAssets, ClientIPHeader: options.clientIPHeader,
		Limits: options.limits, Logger: logger,
	})
	check(t, err)
	return server
}

func serve(handler http.Handler, method string, target string, header http.Header) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, nil)
	request.RemoteAddr = "192.0.2.1:41000"
	for key, values := range header {
		request.Header[key] = values
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func gunzip(t *testing.T, body []byte) []byte {
	t.Helper()
	reader, err := gzip.NewReader(bytes.NewReader(body))
	check(t, err)
	decoded, err := io.ReadAll(reader)
	check(t, err)
	return decoded
}

func TestRoutingAndSecurityHeaders(t *testing.T) {
	type route struct {
		method      string
		target      string
		status      int
		contentType string
	}
	const html, text, json, javascript, css = "text/html; charset=utf-8", "text/plain; charset=utf-8",
		"application/json", "text/javascript; charset=utf-8", "text/css; charset=utf-8"
	routes := []route{
		{"GET", "/", 200, html},
		{"HEAD", "/", 200, html},
		{"GET", "/l2beat/l2beat/pull/13157", 200, html},
		{"GET", "/l2beat/l2beat/pull/13157/", 200, html},
		{"GET", "/l2beat/l2beat/pull/13157/files", 200, html},
		{"GET", "/l2beat/l2beat/pull/13157/commits/abc?diff=split", 200, html},
		{"GET", "/l2beat/l2beat/pull/0", 404, text},
		{"GET", "/l2beat/l2beat/pull/01", 404, text},
		{"GET", "/-bad/l2beat/pull/1", 404, text},
		{"GET", "/l2beat/../pull/1", 404, text},
		{"GET", "/a%2Fb/c/pull/1", 404, text},
		{"GET", "/l2beat/l2beat/issues/1", 404, text},
		{"GET", "/l2beat/l2beat/pull", 404, text},
		{"GET", "/healthz", 200, text},
		{"GET", "/healthz/", 404, text},
		{"GET", "/assets/app.js", 200, javascript},
		{"GET", "/assets/style.css?v=whatever", 200, css},
		{"GET", "/assets/index.html", 404, text},
		{"GET", "/assets/.gitkeep", 404, text},
		{"GET", "/assets/missing.js", 404, text},
		{"GET", "/assets/", 404, text},
		{"GET", "/assets/%2e%2e/index.html", 404, text},
		{"GET", "/nope", 404, text},
		{"POST", "/", 404, text},
		{"OPTIONS", "/healthz", 404, text},
		{"DELETE", "/api/pr/l2beat/l2beat/1", 404, json},
		{"GET", "/api/pr/l2beat/l2beat/13157", 200, json},
		{"GET", "/api/pr/l2beat/l2beat/0", 400, json},
		{"GET", "/api/pr/l2beat/l2beat/+1", 400, json},
		{"GET", "/api/pr/l2beat/l2beat", 400, json},
		{"GET", "/api/pr/l2beat/l2beat/1/extra", 400, json},
		{"GET", "/api/pr/-x/l2beat/1", 400, json},
		{"GET", "/api/pr/l2beat/..%2F/1", 400, json},
		{"GET", "/api/pr/l2beat/l2beat/2147483648", 400, json},
		{"GET", "/api/pr/", 400, json},
		{"GET", "/api/pr", 404, json},
		{"GET", "/api/other", 404, json},
	}
	server := newTestServer(t, testServerOptions{github: newFakeGitHub(t)})
	for _, route := range routes {
		response := serve(server, route.method, route.target, nil)
		if response.Code != route.status || response.Header().Get("Content-Type") != route.contentType {
			t.Errorf("%s %s = %d %q, want %d %q", route.method, route.target,
				response.Code, response.Header().Get("Content-Type"), route.status, route.contentType)
		}
		checkSecurityHeaders(t, route.method+" "+route.target, response.Header())
	}
}

func checkSecurityHeaders(t *testing.T, name string, header http.Header) {
	t.Helper()
	want := map[string]string{
		"Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
			"connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy":        "strict-origin-when-cross-origin",
	}
	for key, value := range want {
		if header.Get(key) != value {
			t.Errorf("%s: %s = %q", name, key, header.Get(key))
		}
	}
}

func TestIndexGetsContentVersionAndAssetsAreImmutable(t *testing.T) {
	server := newTestServer(t, testServerOptions{github: newFakeGitHub(t)})
	page := serve(server, "GET", "/", nil)
	if page.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("index Cache-Control = %q", page.Header().Get("Cache-Control"))
	}
	versions := regexp.MustCompile(`\?v=([0-9a-f]{12})"`).FindAllStringSubmatch(page.Body.String(), -1)
	if len(versions) != 2 || versions[0][1] != versions[1][1] || strings.Contains(page.Body.String(), "{{VERSION}}") {
		t.Fatalf("index body = %s", page.Body.String())
	}
	asset := serve(server, "GET", "/assets/app.js", http.Header{"Accept-Encoding": {"gzip, br"}})
	if asset.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("asset Cache-Control = %q", asset.Header().Get("Cache-Control"))
	}
	if asset.Header().Get("Content-Encoding") != "gzip" || asset.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("large text asset should be served gzipped: %v", asset.Header())
	}
	if !bytes.Equal(gunzip(t, asset.Body.Bytes()), testAssets()["app.js"].Data) {
		t.Fatal("gzipped asset differs from the original")
	}
	plain := serve(server, "GET", "/assets/app.js", nil)
	if plain.Header().Get("Content-Encoding") != "" || !bytes.Equal(plain.Body.Bytes(), testAssets()["app.js"].Data) {
		t.Fatal("asset without Accept-Encoding must be served as-is")
	}
}

func TestVersionChangesWithAssetContents(t *testing.T) {
	assets := testAssets()
	first, err := loadAssetSnapshot(assets)
	check(t, err)
	assets["app.js"] = &fstest.MapFile{Data: []byte("console.log(2)")}
	second, err := loadAssetSnapshot(assets)
	check(t, err)
	if first.version == second.version {
		t.Fatal("version must change when an asset changes")
	}
	assets["index.html"] = &fstest.MapFile{Data: []byte("<p>{{VERSION}}</p>")}
	third, err := loadAssetSnapshot(assets)
	check(t, err)
	if third.version != second.version {
		t.Fatal("index.html is not an asset; editing it must not bust asset caches")
	}
}

func TestDevelopmentModeReloadsAssetsOnPageLoad(t *testing.T) {
	assets := testAssets()
	server := newTestServer(t, testServerOptions{github: newFakeGitHub(t), assets: assets, reloadAssets: true})
	before := serve(server, "GET", "/", nil).Body.String()
	assets["app.js"] = &fstest.MapFile{Data: []byte("console.log('rebuilt')")}
	after := serve(server, "GET", "/", nil).Body.String()
	if before == after {
		t.Fatal("page must reference the rebuilt asset version")
	}
	if body := serve(server, "GET", "/assets/app.js", nil).Body.String(); body != "console.log('rebuilt')" {
		t.Fatalf("asset body = %q", body)
	}
	delete(assets, "index.html")
	if serve(server, "GET", "/", nil).Body.String() != after {
		t.Fatal("a failed reload must keep serving the previous snapshot")
	}
}

func TestNewRequiresIndex(t *testing.T) {
	assets := testAssets()
	delete(assets, "index.html")
	trees, err := cache.OpenTreeStore(t.TempDir(), 1<<20, slog.New(slog.NewTextHandler(io.Discard, nil)))
	check(t, err)
	_, err = New(Config{
		GitHub: newFakeGitHub(t), Trees: trees, Responses: cache.NewResponseCache(1, 1<<20, time.Minute),
		Assets: assets, Limits: RateLimits{RequestsPerMinute: 1, Burst: 1, ClientsMax: 1},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if !errors.Is(err, ErrIndexMissing) {
		t.Fatalf("error = %v, want ErrIndexMissing", err)
	}
}

func TestHealthz(t *testing.T) {
	server := newTestServer(t, testServerOptions{github: newFakeGitHub(t)})
	response := serve(server, "GET", "/healthz", nil)
	if response.Code != 200 || response.Body.String() != "ok" {
		t.Fatalf("healthz = %d %q", response.Code, response.Body.String())
	}
}

// serveConcurrently issues requests from distinct client addresses at once.
func serveConcurrently(handler http.Handler, target string, count int) []*httptest.ResponseRecorder {
	responses := make([]*httptest.ResponseRecorder, count)
	group := sync.WaitGroup{}
	for index := range count {
		group.Go(func() {
			request := httptest.NewRequest("GET", target, nil)
			request.RemoteAddr = "198.51.100." + string(rune('0'+index%10)) + ":1"
			responses[index] = httptest.NewRecorder()
			handler.ServeHTTP(responses[index], request)
		})
	}
	group.Wait()
	return responses
}
