package cache

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// callersOf reports how many callers joined the in-flight call for key.
func (group *Group[V]) callersOf(key string) int {
	group.mutex.Lock()
	defer group.mutex.Unlock()
	current, inFlight := group.calls[key]
	if !inFlight {
		return 0
	}
	return current.callers
}

func waitForCallers[V any](t *testing.T, group *Group[V], key string, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for group.callersOf(key) < want {
		if time.Now().After(deadline) {
			t.Fatalf("only %d of %d callers joined", group.callersOf(key), want)
		}
		time.Sleep(time.Millisecond)
	}
}

// Methodology: the work blocks until every caller has provably joined the
// in-flight call (observed through the group's own bookkeeping), so the
// test cannot pass by callers arriving one after another.
func TestGroupCoalescesConcurrentCallers(t *testing.T) {
	const callers = 64
	group := NewGroup[int]()
	release := make(chan struct{})
	workCalls := atomic.Int32{}
	work := func() (int, error) {
		workCalls.Add(1)
		<-release
		return 42, nil
	}
	results := make(chan int, callers)
	waitGroup := sync.WaitGroup{}
	for range callers {
		waitGroup.Go(func() {
			value, err := group.Do(context.Background(), "tree", work)
			if err != nil {
				t.Error(err)
			}
			results <- value
		})
	}
	waitForCallers(t, group, "tree", callers)
	close(release)
	waitGroup.Wait()
	close(results)
	for value := range results {
		if value != 42 {
			t.Fatalf("caller got %d, want 42", value)
		}
	}
	if workCalls.Load() != 1 {
		t.Fatalf("work ran %d times for %d concurrent callers, want 1", workCalls.Load(), callers)
	}
	value, err := group.Do(context.Background(), "tree", func() (int, error) { return 7, nil })
	if err != nil || value != 7 {
		t.Fatalf("a call after completion must run fresh work, got %d, %v", value, err)
	}
}

func TestGroupCallerCancellationDoesNotCancelWork(t *testing.T) {
	group := NewGroup[string]()
	release := make(chan struct{})
	work := func() (string, error) {
		<-release
		return "done", nil
	}
	impatient, cancel := context.WithCancel(context.Background())
	impatientErr := make(chan error, 1)
	go func() {
		_, err := group.Do(impatient, "key", work)
		impatientErr <- err
	}()
	waitForCallers(t, group, "key", 1)
	patient := make(chan string, 1)
	go func() {
		value, err := group.Do(context.Background(), "key", work)
		if err != nil {
			t.Error(err)
		}
		patient <- value
	}()
	waitForCallers(t, group, "key", 2)
	cancel()
	if err := <-impatientErr; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled caller got %v", err)
	}
	close(release)
	if value := <-patient; value != "done" {
		t.Fatalf("remaining caller got %q", value)
	}
}

func TestGroupSharesErrorsAndKeepsKeysIndependent(t *testing.T) {
	group := NewGroup[int]()
	failure := errors.New("upstream down")
	if _, err := group.Do(context.Background(), "a", func() (int, error) { return 0, failure }); !errors.Is(err, failure) {
		t.Fatalf("error = %v", err)
	}
	release := make(chan struct{})
	go func() {
		_, _ = group.Do(context.Background(), "slow", func() (int, error) { <-release; return 1, nil })
	}()
	waitForCallers(t, group, "slow", 1)
	value, err := group.Do(context.Background(), "fast", func() (int, error) { return 2, nil })
	close(release)
	if err != nil || value != 2 {
		t.Fatalf("an unrelated key waited on another: %d, %v", value, err)
	}
}
