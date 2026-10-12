// Package cache holds the server's bounded caches: an LRU index, an
// in-memory response cache with a TTL, a size-bounded on-disk tree store,
// and a singleflight group that coalesces identical concurrent work.
package cache

const lruNone int32 = -1

// lruEntriesMaxLimit keeps slot indexes comfortably inside int32.
const lruEntriesMaxLimit = 1 << 24

// LRU is a least-recently-used index bounded by entry count and by total
// bytes. Slots are allocated once up front and linked by index, so steady
// state does no allocation. It is not safe for concurrent use.
type LRU[V any] struct {
	slots      []lruSlot[V]
	indexByKey map[string]int32
	newest     int32
	oldest     int32
	free       int32
	count      int32
	bytesTotal int64
	bytesMax   int64
}

type lruSlot[V any] struct {
	key   string
	value V
	bytes int64
	// newer and older link the recency list; free slots chain through older.
	newer int32
	older int32
}

func NewLRU[V any](entriesMax int, bytesMax int64) *LRU[V] {
	assert(entriesMax >= 1, "LRU holds at least one entry")
	assert(entriesMax <= lruEntriesMaxLimit, "LRU entry bound fits int32 indexes")
	assert(bytesMax >= 1, "LRU byte bound is positive")
	lru := &LRU[V]{
		slots:      make([]lruSlot[V], entriesMax),
		indexByKey: make(map[string]int32, entriesMax),
		newest:     lruNone,
		oldest:     lruNone,
		free:       0,
		bytesMax:   bytesMax,
	}
	for index := range lru.slots {
		lru.slots[index].newer = lruNone
		lru.slots[index].older = int32(index + 1)
	}
	lru.slots[entriesMax-1].older = lruNone
	return lru
}

func (lru *LRU[V]) Len() int          { return int(lru.count) }
func (lru *LRU[V]) BytesTotal() int64 { return lru.bytesTotal }
func (lru *LRU[V]) BytesMax() int64   { return lru.bytesMax }

// Get returns the value for key and marks it most recently used.
func (lru *LRU[V]) Get(key string) (V, bool) {
	index, exists := lru.indexByKey[key]
	if !exists {
		var zero V
		return zero, false
	}
	lru.unlink(index)
	lru.linkNewest(index)
	return lru.slots[index].value, true
}

// Put inserts or replaces key as the most recently used entry, evicting the
// least recently used entries until both bounds hold. Evicted keys are
// appended to evictedKeys so the caller can release external resources.
func (lru *LRU[V]) Put(key string, value V, bytes int64, evictedKeys []string) []string {
	assert(bytes >= 0, "entry bytes are not negative")
	assert(bytes <= lru.bytesMax, "callers only insert entries that fit")
	if index, exists := lru.indexByKey[key]; exists {
		lru.bytesTotal += bytes - lru.slots[index].bytes
		lru.slots[index].value = value
		lru.slots[index].bytes = bytes
		lru.unlink(index)
		lru.linkNewest(index)
		for lru.bytesTotal > lru.bytesMax {
			assert(lru.oldest != index, "an entry that fits is never evicted by its own update")
			evictedKeys = append(evictedKeys, lru.evictOldest())
		}
		return evictedKeys
	}
	for lru.count == int32(len(lru.slots)) || lru.bytesTotal+bytes > lru.bytesMax {
		evictedKeys = append(evictedKeys, lru.evictOldest())
	}
	index := lru.free
	assert(index != lruNone, "eviction freed a slot")
	lru.free = lru.slots[index].older
	lru.slots[index] = lruSlot[V]{key: key, value: value, bytes: bytes, newer: lruNone, older: lruNone}
	lru.linkNewest(index)
	lru.indexByKey[key] = index
	lru.count++
	lru.bytesTotal += bytes
	assert(lru.bytesTotal <= lru.bytesMax, "byte bound holds after insert")
	return evictedKeys
}

// Remove deletes key and reports whether it was present.
func (lru *LRU[V]) Remove(key string) bool {
	index, exists := lru.indexByKey[key]
	if !exists {
		return false
	}
	lru.release(index)
	return true
}

func (lru *LRU[V]) evictOldest() string {
	assert(lru.count > 0, "eviction needs an entry")
	index := lru.oldest
	key := lru.slots[index].key
	lru.release(index)
	return key
}

// release unlinks a slot, clears it so its value can be collected, and puts
// it on the free list.
func (lru *LRU[V]) release(index int32) {
	key := lru.slots[index].key
	lru.unlink(index)
	delete(lru.indexByKey, key)
	lru.bytesTotal -= lru.slots[index].bytes
	lru.count--
	lru.slots[index] = lruSlot[V]{newer: lruNone, older: lru.free}
	lru.free = index
	assert(lru.bytesTotal >= 0, "byte total stays non-negative")
	assert(lru.count >= 0, "count stays non-negative")
}

func (lru *LRU[V]) unlink(index int32) {
	slot := &lru.slots[index]
	if slot.newer != lruNone {
		lru.slots[slot.newer].older = slot.older
	} else {
		assert(lru.newest == index, "a slot without a newer neighbor is the newest")
		lru.newest = slot.older
	}
	if slot.older != lruNone {
		lru.slots[slot.older].newer = slot.newer
	} else {
		assert(lru.oldest == index, "a slot without an older neighbor is the oldest")
		lru.oldest = slot.newer
	}
	slot.newer = lruNone
	slot.older = lruNone
}

func (lru *LRU[V]) linkNewest(index int32) {
	slot := &lru.slots[index]
	assert(slot.newer == lruNone, "linked slots are unlinked first")
	assert(slot.older == lruNone, "linked slots are unlinked first")
	slot.older = lru.newest
	if lru.newest != lruNone {
		lru.slots[lru.newest].newer = index
	}
	lru.newest = index
	if lru.oldest == lruNone {
		lru.oldest = index
	}
}

func assert(condition bool, message string) {
	if !condition {
		panic("assertion failed: " + message)
	}
}
