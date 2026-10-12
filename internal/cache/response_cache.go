package cache

import (
	"sync"
	"time"
)

// responseEntryOverheadBytes approximates bookkeeping per entry so tiny
// bodies still count against the byte bound.
const responseEntryOverheadBytes = 256

// ResponseEntry is a final API body, stored gzip-compressed because most
// clients accept gzip and decompressing on demand is cheap.
type ResponseEntry struct {
	GzipBody []byte
	RawBytes int64
}

type timedResponse struct {
	entry     ResponseEntry
	expiresAt time.Time
}

// ResponseCache holds API bodies for a fixed time to live, bounded by entry
// count and total bytes. It is safe for concurrent use.
type ResponseCache struct {
	mutex          sync.Mutex
	lru            *LRU[timedResponse]
	timeToLive     time.Duration
	evictedScratch []string
}

func NewResponseCache(entriesMax int, bytesMax int64, timeToLive time.Duration) *ResponseCache {
	assert(timeToLive > 0, "time to live is positive")
	return &ResponseCache{
		lru:            NewLRU[timedResponse](entriesMax, bytesMax),
		timeToLive:     timeToLive,
		evictedScratch: make([]string, 0, 16),
	}
}

func (cache *ResponseCache) Get(key string, now time.Time) (ResponseEntry, bool) {
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	timed, exists := cache.lru.Get(key)
	if !exists {
		return ResponseEntry{}, false
	}
	if !now.Before(timed.expiresAt) {
		cache.lru.Remove(key)
		return ResponseEntry{}, false
	}
	assert(len(timed.entry.GzipBody) > 0, "cached bodies are not empty")
	return timed.entry, true
}

// Put stores entry until now plus the time to live. Entries larger than
// the whole cache are not stored.
func (cache *ResponseCache) Put(key string, entry ResponseEntry, now time.Time) {
	assert(len(entry.GzipBody) > 0, "cached bodies are not empty")
	assert(entry.RawBytes > 0, "raw size is recorded")
	bytes := int64(len(entry.GzipBody)) + int64(len(key)) + responseEntryOverheadBytes
	if bytes > cache.lru.BytesMax() {
		return
	}
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	timed := timedResponse{entry: entry, expiresAt: now.Add(cache.timeToLive)}
	cache.evictedScratch = cache.lru.Put(key, timed, bytes, cache.evictedScratch[:0])
}
