package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"wtreef/internal/pullrequest"
)

func testRepositoryAndSHA(t *testing.T) (pullrequest.Repository, pullrequest.CommitSHA) {
	repository, err := pullrequest.ParseRepository("L2Beat", "l2beat")
	if err != nil {
		t.Fatal(err)
	}
	sha, err := pullrequest.ParseCommitSHA(testHeadSHA)
	if err != nil {
		t.Fatal(err)
	}
	return repository, sha
}

func TestFetchTreeKeepsBlobsAndSubmodules(t *testing.T) {
	fake := newFakeGitHub(t)
	fake.tree = func(writer http.ResponseWriter) {
		writer.Header().Set("Content-Type", "application/json")
		fmt.Fprint(writer, `{"sha":"`+testHeadSHA+`","url":"https://api.github.com/x","tree":[
			{"path":"README.md","mode":"100644","type":"blob","sha":"a","size":120,"url":"u"},
			{"path":"packages","mode":"040000","type":"tree","sha":"b","url":"u"},
			{"path":"packages/a.ts","mode":"100644","type":"blob","sha":"c","size":0,"url":"u"},
			{"path":"vendor/lib","mode":"160000","type":"commit","sha":"d"}
		],"truncated":true}`)
	}
	client, _ := newTestClient(t, fake, 4)
	repository, sha := testRepositoryAndSHA(t)
	progress := &Progress{}
	tree, err := client.FetchTree(context.Background(), repository, sha, progress)
	if err != nil {
		t.Fatal(err)
	}
	if !tree.Truncated() || tree.Len() != 3 {
		t.Fatalf("tree truncated = %v, len = %d", tree.Truncated(), tree.Len())
	}
	if got := progress.Snapshot().TreeEntries; got != 3 {
		t.Fatalf("progress counts %d tree entries, want 3", got)
	}
	wantPaths := []string{"README.md", "packages/a.ts", "vendor/lib"}
	wantSizes := []int64{120, 0, 0}
	for index := range wantPaths {
		if tree.Path(index) != wantPaths[index] || tree.Size(index) != wantSizes[index] {
			t.Fatalf("entry %d = %q %d", index, tree.Path(index), tree.Size(index))
		}
	}
	fake.mutex.Lock()
	defer fake.mutex.Unlock()
	if fake.treePath != "/repos/L2Beat/l2beat/git/trees/"+testHeadSHA || fake.treeQuery != "recursive=1" {
		t.Fatalf("tree request = %s?%s", fake.treePath, fake.treeQuery)
	}
	if fake.treeHeaders.Get("Accept") != "application/vnd.github+json" ||
		fake.treeHeaders.Get("X-GitHub-Api-Version") != "2022-11-28" ||
		fake.treeHeaders.Get("Authorization") != "Bearer "+testToken {
		t.Fatalf("tree headers = %v", fake.treeHeaders)
	}
}

func TestFetchTreeRejectsMalformedResponses(t *testing.T) {
	testCases := map[string]string{
		"not JSON":          `nope`,
		"array top level":   `[]`,
		"missing truncated": `{"tree":[]}`,
		"missing tree":      `{"truncated":false}`,
		"blob without size": `{"tree":[{"path":"a","type":"blob"}],"truncated":false}`,
		"negative size":     `{"tree":[{"path":"a","type":"blob","size":-1}],"truncated":false}`,
		"unknown type":      `{"tree":[{"path":"a","type":"symlink","size":1}],"truncated":false}`,
		"empty segment":     `{"tree":[{"path":"a//b","type":"blob","size":1}],"truncated":false}`,
		"dot dot segment":   `{"tree":[{"path":"a/../b","type":"blob","size":1}],"truncated":false}`,
		"tree not array":    `{"tree":{},"truncated":false}`,
		"trailing data":     `{"tree":[],"truncated":false}{}`,
		"cut off":           `{"tree":[{"path":"a","type":"blob","size":1},`,
	}
	for name, body := range testCases {
		t.Run(name, func(t *testing.T) {
			fake := newFakeGitHub(t)
			fake.tree = func(writer http.ResponseWriter) { fmt.Fprint(writer, body) }
			client, _ := newTestClient(t, fake, 4)
			repository, sha := testRepositoryAndSHA(t)
			_, err := client.FetchTree(context.Background(), repository, sha, nil)
			if !errors.Is(err, ErrUpstream) {
				t.Fatalf("error = %v, want ErrUpstream", err)
			}
		})
	}
}

// A missing tree for a pull request that exists is GitHub's inconsistency,
// not a missing pull request, so it maps to ErrUpstream rather than ErrNotFound.
func TestFetchTreeStatusMapping(t *testing.T) {
	fake := newFakeGitHub(t)
	status := atomic.Int32{}
	fake.tree = func(writer http.ResponseWriter) {
		if status.Load() == http.StatusForbidden {
			writer.Header().Set("X-RateLimit-Remaining", "0")
			writer.Header().Set("X-RateLimit-Reset", fmt.Sprint(time.Now().Add(time.Minute).Unix()))
		}
		writer.WriteHeader(int(status.Load()))
	}
	client, _ := newTestClient(t, fake, 4)
	repository, sha := testRepositoryAndSHA(t)

	status.Store(http.StatusNotFound)
	if _, err := client.FetchTree(context.Background(), repository, sha, nil); !errors.Is(err, ErrUpstream) {
		t.Fatalf("404 error = %v, want ErrUpstream", err)
	}
	status.Store(http.StatusForbidden)
	var rateLimit *RateLimitError
	if _, err := client.FetchTree(context.Background(), repository, sha, nil); !errors.As(err, &rateLimit) {
		t.Fatalf("403 error = %v, want RateLimitError", err)
	}
	status.Store(http.StatusBadGateway)
	if _, err := client.FetchTree(context.Background(), repository, sha, nil); !errors.Is(err, ErrUpstream) {
		t.Fatalf("502 error = %v, want ErrUpstream", err)
	}
}

// Methodology: requests block inside the fake until released; the fake
// tracks the peak number of concurrent requests it saw.
func TestOutboundConcurrencyIsCapped(t *testing.T) {
	const concurrencyMax = 2
	const callers = 6
	fake := newFakeGitHub(t)
	release := make(chan struct{})
	inFlight := atomic.Int32{}
	peak := atomic.Int32{}
	fake.tree = func(writer http.ResponseWriter) {
		current := inFlight.Add(1)
		for {
			observed := peak.Load()
			if current <= observed || peak.CompareAndSwap(observed, current) {
				break
			}
		}
		<-release
		inFlight.Add(-1)
		fmt.Fprint(writer, `{"tree":[],"truncated":false}`)
	}
	client, _ := newTestClient(t, fake, concurrencyMax)
	repository, sha := testRepositoryAndSHA(t)
	group := sync.WaitGroup{}
	for range callers {
		group.Go(func() {
			if _, err := client.FetchTree(context.Background(), repository, sha, nil); err != nil {
				t.Error(err)
			}
		})
	}
	deadline := time.Now().Add(5 * time.Second)
	for fake.treeRequests.Load() < concurrencyMax && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	// Give any request that slipped past the semaphore time to arrive.
	time.Sleep(50 * time.Millisecond)
	close(release)
	group.Wait()
	if peak.Load() != concurrencyMax {
		t.Fatalf("peak concurrent requests = %d, want %d", peak.Load(), concurrencyMax)
	}
	if fake.treeRequests.Load() != callers {
		t.Fatalf("tree requests = %d, want %d", fake.treeRequests.Load(), callers)
	}
}

func TestSendGivesUpWhenContextEndsWhileWaitingForSlot(t *testing.T) {
	fake := newFakeGitHub(t)
	client, _ := newTestClient(t, fake, 1)
	client.semaphore <- struct{}{}
	defer func() { <-client.semaphore }()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	repository, sha := testRepositoryAndSHA(t)
	_, err := client.FetchTree(ctx, repository, sha, nil)
	if !errors.Is(err, ErrUpstream) || !strings.Contains(err.Error(), "deadline") {
		t.Fatalf("error = %v, want ErrUpstream after deadline", err)
	}
	if fake.treeRequests.Load() != 0 {
		t.Fatal("request was sent without a semaphore slot")
	}
}
