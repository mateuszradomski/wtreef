package github

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"wtreef/internal/pullrequest"
)

// Methodology: a fake GitHub (httptest.Server) answers GraphQL and REST
// requests from per-test handlers and records what the client sent. Tests
// assert both the parsed result and the requests made (count, query shape,
// headers), because the private-repository and pagination guarantees are
// about what the client does, not only what it returns.

const (
	testToken   = "ghp_testtokenthatmustneverbelogged"
	testHeadSHA = "81f6d0e53bf3b57632075b9e37590b3b37e50be3"
	testBaseSHA = "9da73dfae06746bd429870df0e9ac7099ae248a0"
)

type fakeGitHub struct {
	server          *httptest.Server
	graphqlRequests atomic.Int32
	treeRequests    atomic.Int32
	mutex           sync.Mutex
	queries         []graphqlRequest
	treeHeaders     http.Header
	treeQuery       string
	treePath        string
	authorization   string
	// graphql answers the n-th (0-based) GraphQL request.
	graphql func(writer http.ResponseWriter, index int, request graphqlRequest)
	tree    func(writer http.ResponseWriter)
}

func newFakeGitHub(t *testing.T) *fakeGitHub {
	fake := &fakeGitHub{}
	fake.server = httptest.NewServer(http.HandlerFunc(fake.serve))
	t.Cleanup(fake.server.Close)
	return fake
}

func (fake *fakeGitHub) serve(writer http.ResponseWriter, request *http.Request) {
	fake.mutex.Lock()
	fake.authorization = request.Header.Get("Authorization")
	fake.mutex.Unlock()
	if request.URL.Path == "/graphql" {
		var decoded graphqlRequest
		if err := json.NewDecoder(request.Body).Decode(&decoded); err != nil {
			http.Error(writer, "bad request body", http.StatusBadRequest)
			return
		}
		index := int(fake.graphqlRequests.Add(1)) - 1
		fake.mutex.Lock()
		fake.queries = append(fake.queries, decoded)
		fake.mutex.Unlock()
		fake.graphql(writer, index, decoded)
		return
	}
	fake.treeRequests.Add(1)
	fake.mutex.Lock()
	fake.treeHeaders = request.Header.Clone()
	fake.treeQuery = request.URL.RawQuery
	fake.treePath = request.URL.Path
	fake.mutex.Unlock()
	fake.tree(writer)
}

func (fake *fakeGitHub) recordedQueries() []graphqlRequest {
	fake.mutex.Lock()
	defer fake.mutex.Unlock()
	return append([]graphqlRequest(nil), fake.queries...)
}

func (fake *fakeGitHub) recordedAuthorization() string {
	fake.mutex.Lock()
	defer fake.mutex.Unlock()
	return fake.authorization
}

func newTestClient(t *testing.T, fake *fakeGitHub, concurrencyMax int) (*Client, *bytes.Buffer) {
	logs := &bytes.Buffer{}
	logger := slog.New(slog.NewTextHandler(&lockedWriter{target: logs}, &slog.HandlerOptions{Level: slog.LevelDebug}))
	client := NewClient(Config{
		Token:          testToken,
		GraphQLURL:     fake.server.URL + "/graphql",
		RESTBaseURL:    fake.server.URL,
		ConcurrencyMax: concurrencyMax,
		RequestTimeout: 5 * time.Second,
		Logger:         logger,
	})
	return client, logs
}

type lockedWriter struct {
	mutex  sync.Mutex
	target *bytes.Buffer
}

func (writer *lockedWriter) Write(data []byte) (int, error) {
	writer.mutex.Lock()
	defer writer.mutex.Unlock()
	return writer.target.Write(data)
}

func testID(t *testing.T) pullrequest.ID {
	id, err := pullrequest.ParseID("l2beat", "l2beat", "13157")
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func boolPointer(value bool) *bool { return &value }

func stringPointer(value string) *string { return &value }

func testPullRequest(files []graphqlFile, changedFiles int64, hasNextPage bool, cursor string) *graphqlPullRequest {
	return &graphqlPullRequest{
		Title:        "Blobs page",
		URL:          "https://github.com/L2Beat/l2beat/pull/13157",
		State:        "CLOSED",
		Merged:       true,
		Author:       nil,
		BaseRefName:  "main",
		HeadRefName:  "blobs-page",
		BaseRefOid:   testBaseSHA,
		HeadRefOid:   testHeadSHA,
		Additions:    10,
		Deletions:    2,
		ChangedFiles: changedFiles,
		Files: &graphqlFiles{
			PageInfo: graphqlPageInfo{HasNextPage: hasNextPage, EndCursor: stringPointer(cursor)},
			Nodes:    files,
		},
	}
}

func writeRepository(writer http.ResponseWriter, isPrivate bool, pull *graphqlPullRequest) {
	writeJSON(writer, graphqlResponse{Data: &graphqlData{Repository: &graphqlRepository{
		IsPrivate:     boolPointer(isPrivate),
		NameWithOwner: "L2Beat/l2beat",
		PullRequest:   pull,
	}}})
}

func writeJSON(writer http.ResponseWriter, value any) {
	writer.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(writer).Encode(value); err != nil {
		panic(err)
	}
}

func generatedFiles(start int, count int) []graphqlFile {
	changeTypes := []string{"ADDED", "MODIFIED", "DELETED", "RENAMED", "COPIED", "CHANGED"}
	files := make([]graphqlFile, 0, count)
	for index := start; index < start+count; index++ {
		files = append(files, graphqlFile{
			Path:       "packages/p" + strconv.Itoa(index%7) + "/file" + strconv.Itoa(index) + ".ts",
			Additions:  int64(index),
			Deletions:  1,
			ChangeType: changeTypes[index%len(changeTypes)],
		})
	}
	return files
}

func TestFetchPullRequestPaginates(t *testing.T) {
	fake := newFakeGitHub(t)
	const fileCount = 250
	fake.graphql = func(writer http.ResponseWriter, index int, request graphqlRequest) {
		start := index * filesPageSize
		count := min(filesPageSize, fileCount-start)
		hasNextPage := start+count < fileCount
		writeRepository(writer, false, testPullRequest(generatedFiles(start, count), fileCount, hasNextPage, "cursor"+strconv.Itoa(index)))
	}
	client, _ := newTestClient(t, fake, 4)
	pull, err := client.FetchPullRequest(context.Background(), testID(t))
	if err != nil {
		t.Fatal(err)
	}
	if got := fake.graphqlRequests.Load(); got != 3 {
		t.Fatalf("GraphQL requests = %d, want 3", got)
	}
	checkPaginationQueries(t, fake.recordedQueries())
	if len(pull.Files) != fileCount || pull.FilesTruncated() {
		t.Fatalf("files = %d, truncated = %v", len(pull.Files), pull.FilesTruncated())
	}
	wantStatuses := []pullrequest.Status{
		pullrequest.StatusAdded, pullrequest.StatusModified, pullrequest.StatusDeleted,
		pullrequest.StatusRenamed, pullrequest.StatusAdded, pullrequest.StatusModified,
	}
	for index, file := range pull.Files {
		if file.Status() != wantStatuses[index%len(wantStatuses)] || file.Additions() != int64(index) {
			t.Fatalf("file %d = %+v", index, file)
		}
	}
	if pull.Repository.Owner() != "L2Beat" || pull.State != pullrequest.StateMerged || pull.Author != "" {
		t.Fatalf("metadata = %+v", pull)
	}
	if pull.HeadSHA.String() != testHeadSHA || pull.BaseSHA.String() != testBaseSHA || pull.Number != 13157 {
		t.Fatalf("metadata = %+v", pull)
	}
}

func checkPaginationQueries(t *testing.T, queries []graphqlRequest) {
	t.Helper()
	if queries[0].Variables.After != nil || !strings.Contains(queries[0].Query, "title") {
		t.Fatalf("first query must request metadata without a cursor: %+v", queries[0])
	}
	for index, query := range queries[1:] {
		if strings.Contains(query.Query, "title") {
			t.Fatalf("page %d refetched metadata", index+1)
		}
		if !strings.Contains(query.Query, "isPrivate") || !strings.Contains(query.Query, "headRefOid") {
			t.Fatalf("page %d must recheck privacy and head", index+1)
		}
		if query.Variables.After == nil || *query.Variables.After != "cursor"+strconv.Itoa(index) {
			t.Fatalf("page %d cursor = %v", index+1, query.Variables.After)
		}
		if query.Variables.Owner != "l2beat" || query.Variables.Name != "l2beat" || query.Variables.Number != 13157 {
			t.Fatalf("page %d variables = %+v", index+1, query.Variables)
		}
	}
}

func TestFetchPullRequestStopsAtPageLimit(t *testing.T) {
	fake := newFakeGitHub(t)
	fake.graphql = func(writer http.ResponseWriter, index int, request graphqlRequest) {
		writeRepository(writer, false, testPullRequest(generatedFiles(index*filesPageSize, filesPageSize), 3500, true, "c"+strconv.Itoa(index)))
	}
	client, _ := newTestClient(t, fake, 4)
	pull, err := client.FetchPullRequest(context.Background(), testID(t))
	if err != nil {
		t.Fatal(err)
	}
	if got := fake.graphqlRequests.Load(); got != filesPagesMax {
		t.Fatalf("GraphQL requests = %d, want %d", got, filesPagesMax)
	}
	if len(pull.Files) != 3000 || !pull.FilesTruncated() {
		t.Fatalf("files = %d, truncated = %v", len(pull.Files), pull.FilesTruncated())
	}
}

func TestFetchPullRequestNullFilesIsTruncated(t *testing.T) {
	fake := newFakeGitHub(t)
	fake.graphql = func(writer http.ResponseWriter, index int, request graphqlRequest) {
		pull := testPullRequest(nil, 5, false, "")
		pull.Files = nil
		writeRepository(writer, false, pull)
	}
	client, _ := newTestClient(t, fake, 4)
	pull, err := client.FetchPullRequest(context.Background(), testID(t))
	if err != nil || len(pull.Files) != 0 || !pull.FilesTruncated() {
		t.Fatalf("pull = %+v, err = %v", pull, err)
	}
}

func TestFetchPullRequestNotFound(t *testing.T) {
	testCases := map[string]string{
		"repository missing": `{"data":{"repository":null},"errors":[{"type":"NOT_FOUND","path":["repository"],"message":"Could not resolve to a Repository"}]}`,
		"pull request missing": `{"data":{"repository":{"isPrivate":false,"nameWithOwner":"l2beat/l2beat","pullRequest":null}},` +
			`"errors":[{"type":"NOT_FOUND","path":["repository","pullRequest"],"message":"Could not resolve to a PullRequest"}]}`,
		"repository null without errors": `{"data":{"repository":null}}`,
		"errors only":                    `{"errors":[{"type":"NOT_FOUND","message":"gone"}]}`,
	}
	for name, body := range testCases {
		t.Run(name, func(t *testing.T) {
			fake := newFakeGitHub(t)
			fake.graphql = func(writer http.ResponseWriter, index int, request graphqlRequest) {
				writer.Header().Set("Content-Type", "application/json")
				fmt.Fprint(writer, body)
			}
			client, _ := newTestClient(t, fake, 4)
			_, err := client.FetchPullRequest(context.Background(), testID(t))
			if !errors.Is(err, ErrNotFound) {
				t.Fatalf("error = %v, want ErrNotFound", err)
			}
		})
	}
}

// The deploy token may read private repositories. A private repository
// must produce the same ErrNotFound as a missing one, stop before fetching
// more pages, and leave no trace of its contents in the logs.
func TestFetchPullRequestPrivateRepositoryIsNotFound(t *testing.T) {
	const secretTitle = "secret-acquisition-plan"
	const secretPath = "confidential/merger.txt"
	for _, privatePageIndex := range []int{0, 1} {
		t.Run("private on page "+strconv.Itoa(privatePageIndex), func(t *testing.T) {
			fake := newFakeGitHub(t)
			fake.graphql = func(writer http.ResponseWriter, index int, request graphqlRequest) {
				files := []graphqlFile{{Path: secretPath + strconv.Itoa(index), Additions: 1, ChangeType: "ADDED"}}
				pull := testPullRequest(files, 2, true, "next")
				pull.Title = secretTitle
				writeRepository(writer, index == privatePageIndex, pull)
			}
			client, logs := newTestClient(t, fake, 4)
			pull, err := client.FetchPullRequest(context.Background(), testID(t))
			if !errors.Is(err, ErrNotFound) {
				t.Fatalf("error = %v, want ErrNotFound", err)
			}
			if pull.Title != "" || len(pull.Files) != 0 {
				t.Fatalf("private contents returned: %+v", pull)
			}
			if got := fake.graphqlRequests.Load(); got != int32(privatePageIndex+1) {
				t.Fatalf("GraphQL requests = %d, want %d", got, privatePageIndex+1)
			}
			if strings.Contains(logs.String(), secretTitle) || strings.Contains(logs.String(), "confidential") {
				t.Fatalf("logs leak private contents: %s", logs.String())
			}
		})
	}
}

func TestFetchPullRequestRateLimited(t *testing.T) {
	type testCase struct {
		name              string
		status            int
		header            map[string]string
		body              string
		retryAfterSeconds int
	}
	resetUnix := strconv.FormatInt(time.Now().Add(120*time.Second).Unix(), 10)
	testCases := []testCase{
		{"primary limit 403", 403, map[string]string{"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": resetUnix}, `{"message":"API rate limit exceeded"}`, 120},
		{"secondary limit 403", 403, map[string]string{"Retry-After": "30"}, `{"message":"secondary rate limit"}`, 30},
		{"429 without headers", 429, nil, `{}`, retryAfterDefaultSeconds},
		{"GraphQL RATE_LIMITED", 200, map[string]string{"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": resetUnix}, `{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}`, 120},
		{"reset far in the future is clamped", 403, map[string]string{"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "99999999999"}, `{}`, retryAfterSecondsMax},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			fake := newFakeGitHub(t)
			fake.graphql = func(writer http.ResponseWriter, index int, request graphqlRequest) {
				for key, value := range testCase.header {
					writer.Header().Set(key, value)
				}
				writer.WriteHeader(testCase.status)
				fmt.Fprint(writer, testCase.body)
			}
			client, _ := newTestClient(t, fake, 4)
			_, err := client.FetchPullRequest(context.Background(), testID(t))
			var rateLimit *RateLimitError
			if !errors.As(err, &rateLimit) {
				t.Fatalf("error = %v, want RateLimitError", err)
			}
			// One second of slack: the reset is computed against the wall clock.
			difference := rateLimit.RetryAfterSeconds - testCase.retryAfterSeconds
			if difference < -1 || difference > 1 {
				t.Fatalf("RetryAfterSeconds = %d, want %d", rateLimit.RetryAfterSeconds, testCase.retryAfterSeconds)
			}
		})
	}
}

func TestFetchPullRequestRejectsMalformedResponses(t *testing.T) {
	valid := func() *graphqlPullRequest { return testPullRequest(generatedFiles(0, 3), 3, false, "") }
	mutate := func(change func(pull *graphqlPullRequest)) string {
		pull := valid()
		change(pull)
		encoded, err := json.Marshal(graphqlResponse{Data: &graphqlData{Repository: &graphqlRepository{
			IsPrivate: boolPointer(false), NameWithOwner: "l2beat/l2beat", PullRequest: pull,
		}}})
		if err != nil {
			t.Fatal(err)
		}
		return string(encoded)
	}
	testCases := map[string]string{
		"not JSON":               `<html>oops</html>`,
		"truncated JSON":         `{"data":{"repository":`,
		"no data no errors":      `{}`,
		"isPrivate missing":      `{"data":{"repository":{"nameWithOwner":"l2beat/l2beat","pullRequest":{"headRefOid":"` + testHeadSHA + `"}}}}`,
		"other GraphQL error":    `{"data":null,"errors":[{"type":"INTERNAL","message":"boom"}]}`,
		"bad head SHA":           mutate(func(pull *graphqlPullRequest) { pull.HeadRefOid = "../../etc/passwd" }),
		"uppercase head SHA":     mutate(func(pull *graphqlPullRequest) { pull.HeadRefOid = strings.ToUpper(testHeadSHA) }),
		"unknown state":          mutate(func(pull *graphqlPullRequest) { pull.State = "DRAFT" }),
		"unknown change type":    mutate(func(pull *graphqlPullRequest) { pull.Files.Nodes[0].ChangeType = "MOVED" }),
		"duplicate path":         mutate(func(pull *graphqlPullRequest) { pull.Files.Nodes[1].Path = pull.Files.Nodes[0].Path }),
		"absolute path":          mutate(func(pull *graphqlPullRequest) { pull.Files.Nodes[0].Path = "/etc/passwd" }),
		"empty path segment":     mutate(func(pull *graphqlPullRequest) { pull.Files.Nodes[0].Path = "a//b" }),
		"negative additions":     mutate(func(pull *graphqlPullRequest) { pull.Files.Nodes[0].Additions = -1 }),
		"foreign URL":            mutate(func(pull *graphqlPullRequest) { pull.URL = "https://evil.example/pull/1" }),
		"next page no cursor":    mutate(func(pull *graphqlPullRequest) { pull.Files.PageInfo = graphqlPageInfo{HasNextPage: true} }),
		"page larger than asked": mutate(func(pull *graphqlPullRequest) { pull.Files.Nodes = generatedFiles(0, filesPageSize+1) }),
	}
	for name, body := range testCases {
		t.Run(name, func(t *testing.T) {
			fake := newFakeGitHub(t)
			fake.graphql = func(writer http.ResponseWriter, index int, request graphqlRequest) {
				writer.Header().Set("Content-Type", "application/json")
				fmt.Fprint(writer, body)
			}
			client, _ := newTestClient(t, fake, 4)
			_, err := client.FetchPullRequest(context.Background(), testID(t))
			if !errors.Is(err, ErrUpstream) {
				t.Fatalf("error = %v, want ErrUpstream", err)
			}
		})
	}
}

func TestFetchPullRequestUpstreamStatusIsLoggedWithoutToken(t *testing.T) {
	fake := newFakeGitHub(t)
	fake.graphql = func(writer http.ResponseWriter, index int, request graphqlRequest) {
		http.Error(writer, `{"message":"Bad credentials"}`, http.StatusUnauthorized)
	}
	client, logs := newTestClient(t, fake, 4)
	_, err := client.FetchPullRequest(context.Background(), testID(t))
	if !errors.Is(err, ErrUpstream) {
		t.Fatalf("error = %v, want ErrUpstream", err)
	}
	if got := fake.recordedAuthorization(); got != "Bearer "+testToken {
		t.Fatalf("Authorization = %q", got)
	}
	if !strings.Contains(logs.String(), "Bad credentials") {
		t.Fatalf("upstream detail missing from logs: %s", logs.String())
	}
	if strings.Contains(logs.String(), testToken) {
		t.Fatal("token leaked into logs")
	}
}

func TestFetchPullRequestHeadMovedDuringPagination(t *testing.T) {
	fake := newFakeGitHub(t)
	fake.graphql = func(writer http.ResponseWriter, index int, request graphqlRequest) {
		pull := testPullRequest(generatedFiles(index*filesPageSize, filesPageSize), 300, true, "c")
		if index == 1 {
			pull.HeadRefOid = testBaseSHA
		}
		writeRepository(writer, false, pull)
	}
	client, _ := newTestClient(t, fake, 4)
	_, err := client.FetchPullRequest(context.Background(), testID(t))
	if !errors.Is(err, ErrUpstream) {
		t.Fatalf("error = %v, want ErrUpstream", err)
	}
}

// offsetPages answers like GitHub: a files cursor is the base64 offset of the
// next file, so any page can be requested without walking the ones before it.
// It tracks how many requests overlap to check the in-flight bound.
type offsetPages struct {
	fileCount    int
	changedFiles int64
	pageSize     func(offset int) int
	// pull adjusts the page served at offset, to inject a moved head or privacy.
	pull        func(offset int, pull *graphqlPullRequest) bool
	inFlight    atomic.Int32
	inFlightMax atomic.Int32
}

func (pages *offsetPages) answer(t *testing.T, writer http.ResponseWriter, request graphqlRequest) {
	inFlight := pages.inFlight.Add(1)
	defer pages.inFlight.Add(-1)
	for observed := pages.inFlightMax.Load(); inFlight > observed; observed = pages.inFlightMax.Load() {
		if pages.inFlightMax.CompareAndSwap(observed, inFlight) {
			break
		}
	}
	// Holding each request open lets concurrent ones overlap visibly.
	time.Sleep(10 * time.Millisecond)
	offset := 0
	if request.Variables.After != nil {
		decoded, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(*request.Variables.After, "="))
		if err != nil {
			t.Errorf("cursor %q is not base64", *request.Variables.After)
		}
		offset, err = strconv.Atoi(string(decoded))
		if err != nil {
			t.Errorf("cursor %q is not an offset", *request.Variables.After)
		}
	}
	count := max(0, min(pages.pageSize(offset), pages.fileCount-offset))
	// Encoded here rather than with filesCursor, so the test pins GitHub's
	// unpadded format instead of agreeing with the code under test.
	endCursor := base64.RawStdEncoding.EncodeToString([]byte(strconv.Itoa(offset + count)))
	pull := testPullRequest(generatedFiles(offset, count), pages.changedFiles, offset+count < pages.fileCount, endCursor)
	isPrivate := false
	if pages.pull != nil {
		isPrivate = pages.pull(offset, pull)
	}
	writeRepository(writer, isPrivate, pull)
}

func newOffsetGitHub(t *testing.T, pages *offsetPages) *fakeGitHub {
	fake := newFakeGitHub(t)
	fake.graphql = func(writer http.ResponseWriter, index int, request graphqlRequest) {
		pages.answer(t, writer, request)
	}
	return fake
}

func fullPages(int) int { return filesPageSize }

func checkFilesInOrder(t *testing.T, files []pullrequest.ChangedFile, wantCount int) {
	t.Helper()
	if len(files) != wantCount {
		t.Fatalf("files = %d, want %d", len(files), wantCount)
	}
	for index, file := range files {
		if file.Additions() != int64(index) {
			t.Fatalf("file %d has additions %d, files are out of order", index, file.Additions())
		}
	}
}

func TestFetchPullRequestPrefetchesOffsetPages(t *testing.T) {
	type testCase struct {
		fileCount    int
		wantRequests int32
		wantFiles    int
	}
	testCases := map[string]testCase{
		"25 pages":                  {fileCount: 2500, wantRequests: 25, wantFiles: 2500},
		"stops at the page limit":   {fileCount: 3500, wantRequests: filesPagesMax, wantFiles: filesPagesMax * filesPageSize},
		"two pages, one prefetched": {fileCount: 150, wantRequests: 2, wantFiles: 150},
	}
	for name, testCase := range testCases {
		t.Run(name, func(t *testing.T) {
			pages := &offsetPages{fileCount: testCase.fileCount, changedFiles: int64(testCase.fileCount), pageSize: fullPages}
			fake := newOffsetGitHub(t, pages)
			client, logs := newTestClient(t, fake, 16)
			pull, err := client.FetchPullRequest(context.Background(), testID(t))
			if err != nil {
				t.Fatal(err)
			}
			checkFilesInOrder(t, pull.Files, testCase.wantFiles)
			if pull.FilesTruncated() != (testCase.wantFiles < testCase.fileCount) {
				t.Fatalf("truncated = %v", pull.FilesTruncated())
			}
			if got := fake.graphqlRequests.Load(); got != testCase.wantRequests {
				t.Fatalf("GraphQL requests = %d, want %d", got, testCase.wantRequests)
			}
			cursors := map[string]bool{}
			for _, query := range fake.recordedQueries()[1:] {
				if cursors[*query.Variables.After] {
					t.Fatalf("cursor %q requested twice", *query.Variables.After)
				}
				cursors[*query.Variables.After] = true
			}
			if got := pages.inFlightMax.Load(); got > filesPagesInFlightMax {
				t.Fatalf("in flight = %d, want at most %d", got, filesPagesInFlightMax)
			}
			if testCase.wantRequests > 2 && pages.inFlightMax.Load() < 2 {
				t.Fatal("pages were not fetched concurrently")
			}
			if strings.Contains(logs.String(), "sequentially") {
				t.Fatalf("offset cursors fell back to sequential: %s", logs.String())
			}
		})
	}
}

// A prefetched page is only used when the previous page's endCursor proves it
// is the next one; otherwise the walk fetches by the real cursor, so a wrong
// guess about GitHub's pagination costs requests but never files.
func TestFetchPullRequestPrefetchFallsBackToRealCursors(t *testing.T) {
	type testCase struct {
		pages        *offsetPages
		wantRequests int32
	}
	testCases := map[string]testCase{
		// Prefetched 100 (used), 200, 300; then walked 150, 250, 350.
		"short page shifts the cursors": {
			pages: &offsetPages{fileCount: 400, changedFiles: 400, pageSize: func(offset int) int {
				if offset == 100 {
					return 50
				}
				return filesPageSize
			}},
			wantRequests: 7,
		},
		// Prefetched 100 (used); then walked 200, 300.
		"changedFiles undercounts the connection": {
			pages:        &offsetPages{fileCount: 400, changedFiles: 200, pageSize: fullPages},
			wantRequests: 4,
		},
	}
	for name, testCase := range testCases {
		t.Run(name, func(t *testing.T) {
			pages := testCase.pages
			fake := newOffsetGitHub(t, pages)
			client, _ := newTestClient(t, fake, 16)
			pull, err := client.FetchPullRequest(context.Background(), testID(t))
			if err != nil {
				t.Fatal(err)
			}
			checkFilesInOrder(t, pull.Files, pages.fileCount)
			if got := fake.graphqlRequests.Load(); got != testCase.wantRequests {
				t.Fatalf("GraphQL requests = %d, want %d", got, testCase.wantRequests)
			}
		})
	}
}

func TestFetchPullRequestPrefetchSkipsUnknownCursors(t *testing.T) {
	fake := newFakeGitHub(t)
	fake.graphql = func(writer http.ResponseWriter, index int, request graphqlRequest) {
		writeRepository(writer, false, testPullRequest(generatedFiles(index*filesPageSize, filesPageSize), 500, index < 4, "opaque"+strconv.Itoa(index)))
	}
	client, logs := newTestClient(t, fake, 16)
	pull, err := client.FetchPullRequest(context.Background(), testID(t))
	if err != nil {
		t.Fatal(err)
	}
	checkFilesInOrder(t, pull.Files, 500)
	if got := fake.graphqlRequests.Load(); got != 5 {
		t.Fatalf("GraphQL requests = %d, want 5", got)
	}
	for index, query := range fake.recordedQueries()[1:] {
		if *query.Variables.After != "opaque"+strconv.Itoa(index) {
			t.Fatalf("page %d cursor = %q, want GitHub's own", index+1, *query.Variables.After)
		}
	}
	if !strings.Contains(logs.String(), "fetching sequentially") {
		t.Fatalf("fallback to sequential pagination was not logged: %s", logs.String())
	}
}

func TestFetchPullRequestRejectsPrefetchedPage(t *testing.T) {
	type testCase struct {
		change  func(pull *graphqlPullRequest) bool
		wantErr error
	}
	testCases := map[string]testCase{
		"head moved": {
			change:  func(pull *graphqlPullRequest) bool { pull.HeadRefOid = testBaseSHA; return false },
			wantErr: ErrUpstream,
		},
		"repository turned private": {
			change:  func(pull *graphqlPullRequest) bool { pull.Title = "secret-acquisition-plan"; return true },
			wantErr: ErrNotFound,
		},
	}
	for name, testCase := range testCases {
		t.Run(name, func(t *testing.T) {
			pages := &offsetPages{fileCount: 2500, changedFiles: 2500, pageSize: fullPages,
				pull: func(offset int, pull *graphqlPullRequest) bool {
					if offset != 1200 {
						return false
					}
					return testCase.change(pull)
				}}
			fake := newOffsetGitHub(t, pages)
			client, logs := newTestClient(t, fake, 16)
			pull, err := client.FetchPullRequest(context.Background(), testID(t))
			if !errors.Is(err, testCase.wantErr) {
				t.Fatalf("error = %v, want %v", err, testCase.wantErr)
			}
			if len(pull.Files) != 0 || pull.Title != "" {
				t.Fatalf("partial pull request returned: %+v", pull)
			}
			if strings.Contains(logs.String(), "secret") {
				t.Fatalf("logs leak private contents: %s", logs.String())
			}
		})
	}
}
