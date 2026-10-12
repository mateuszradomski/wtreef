package cache

import (
	"context"
	"sync"
)

// Group coalesces concurrent calls with the same key into one execution of
// the work. The work runs in its own goroutine, detached from any caller, so
// one visitor closing their tab does not cancel it for everyone else; each
// caller stops waiting when its own context ends. The number of in-flight
// keys is bounded by the number of concurrent callers.
type Group[V any] struct {
	mutex sync.Mutex
	calls map[string]*call[V]
}

type call[V any] struct {
	done    chan struct{}
	value   V
	err     error
	callers int
}

func NewGroup[V any]() *Group[V] {
	return &Group[V]{calls: make(map[string]*call[V])}
}

// Do runs work once per key at a time and hands its result to every caller
// that joined while it ran. work must bound its own duration.
func (group *Group[V]) Do(ctx context.Context, key string, work func() (V, error)) (V, error) {
	group.mutex.Lock()
	current, inFlight := group.calls[key]
	if !inFlight {
		current = &call[V]{done: make(chan struct{})}
		group.calls[key] = current
		go group.run(key, current, work)
	}
	current.callers++
	group.mutex.Unlock()

	select {
	case <-current.done:
		return current.value, current.err
	case <-ctx.Done():
		var zero V
		return zero, ctx.Err()
	}
}

func (group *Group[V]) run(key string, current *call[V], work func() (V, error)) {
	value, err := work()
	group.mutex.Lock()
	assert(group.calls[key] == current, "only the running call is registered under its key")
	delete(group.calls, key)
	current.value = value
	current.err = err
	group.mutex.Unlock()
	// Closing after the writes publishes them to every waiter.
	close(current.done)
}
