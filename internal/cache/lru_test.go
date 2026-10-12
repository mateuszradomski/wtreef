package cache

import (
	"math/rand/v2"
	"slices"
	"strconv"
	"testing"
	"time"
)

func TestLRUEvictsLeastRecentlyUsedByCount(t *testing.T) {
	lru := NewLRU[int](2, 1000)
	lru.Put("a", 1, 1, nil)
	lru.Put("b", 2, 1, nil)
	if _, ok := lru.Get("a"); !ok {
		t.Fatal("a missing")
	}
	evicted := lru.Put("c", 3, 1, nil)
	if !slices.Equal(evicted, []string{"b"}) {
		t.Fatalf("evicted %v, want [b]: a was used more recently", evicted)
	}
	if _, ok := lru.Get("b"); ok || lru.Len() != 2 {
		t.Fatalf("b present = %v, len = %d", ok, lru.Len())
	}
}

func TestLRUEvictsByBytes(t *testing.T) {
	lru := NewLRU[string](10, 100)
	lru.Put("a", "a", 40, nil)
	lru.Put("b", "b", 40, nil)
	evicted := lru.Put("c", "c", 50, nil)
	if !slices.Equal(evicted, []string{"a"}) || lru.BytesTotal() != 90 {
		t.Fatalf("evicted %v bytes %d", evicted, lru.BytesTotal())
	}
	// Growing an existing entry evicts others, never itself.
	evicted = lru.Put("c", "c", 100, nil)
	if !slices.Equal(evicted, []string{"b"}) || lru.BytesTotal() != 100 || lru.Len() != 1 {
		t.Fatalf("evicted %v bytes %d len %d", evicted, lru.BytesTotal(), lru.Len())
	}
}

func TestLRURejectsOversizedEntry(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("oversized entry did not assert")
		}
	}()
	NewLRU[int](4, 10).Put("a", 1, 11, nil)
}

// Methodology: random operations run against the LRU and against a naive
// slice model (front = oldest); both must agree on contents, totals, and
// the exact keys evicted after every step. Slot reuse via the free list is
// exercised because removals and evictions interleave with inserts.
func TestLRUMatchesReferenceModel(t *testing.T) {
	random := rand.New(rand.NewPCG(7, 11))
	const entriesMax, bytesMax = 8, 300
	lru := NewLRU[int64](entriesMax, bytesMax)
	model := []modelEntry{}
	find := func(key string) int {
		return slices.IndexFunc(model, func(entry modelEntry) bool { return entry.key == key })
	}
	for step := range 20_000 {
		key := "k" + strconv.Itoa(random.IntN(20))
		switch random.IntN(3) {
		case 0:
			bytes := int64(random.IntN(bytesMax + 1))
			evicted := lru.Put(key, bytes, bytes, nil)
			if position := find(key); position >= 0 {
				model = slices.Delete(model, position, position+1)
			}
			model = append(model, modelEntry{key, bytes})
			modelEvicted := []string{}
			for len(model) > entriesMax || modelBytes(model) > bytesMax {
				modelEvicted = append(modelEvicted, model[0].key)
				model = model[1:]
			}
			if !slices.Equal(evicted, modelEvicted) {
				t.Fatalf("step %d: evicted %v, model %v", step, evicted, modelEvicted)
			}
		case 1:
			value, ok := lru.Get(key)
			position := find(key)
			if ok != (position >= 0) {
				t.Fatalf("step %d: Get(%s) = %v, model has %v", step, key, ok, position >= 0)
			}
			if ok {
				if value != model[position].bytes {
					t.Fatalf("step %d: value %d, model %d", step, value, model[position].bytes)
				}
				entry := model[position]
				model = append(slices.Delete(model, position, position+1), entry)
			}
		case 2:
			removed := lru.Remove(key)
			position := find(key)
			if removed != (position >= 0) {
				t.Fatalf("step %d: Remove(%s) = %v", step, key, removed)
			}
			if removed {
				model = slices.Delete(model, position, position+1)
			}
		}
		if lru.Len() != len(model) || lru.BytesTotal() != modelBytes(model) {
			t.Fatalf("step %d: len %d bytes %d, model %d %d", step, lru.Len(), lru.BytesTotal(), len(model), modelBytes(model))
		}
	}
}

type modelEntry struct {
	key   string
	bytes int64
}

func modelBytes(model []modelEntry) int64 {
	total := int64(0)
	for _, entry := range model {
		total += entry.bytes
	}
	return total
}

func TestResponseCacheExpiresAfterTimeToLive(t *testing.T) {
	cache := NewResponseCache(4, 1<<20, time.Minute)
	start := time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	entry := ResponseEntry{GzipBody: []byte{1, 2, 3}, RawBytes: 10}
	cache.Put("o/r#1", entry, start)
	if got, ok := cache.Get("o/r#1", start.Add(59*time.Second)); !ok || got.RawBytes != 10 {
		t.Fatalf("fresh entry missing: %v %v", got, ok)
	}
	if _, ok := cache.Get("o/r#1", start.Add(time.Minute)); ok {
		t.Fatal("entry served at its expiry time")
	}
	if _, ok := cache.Get("o/r#1", start); ok {
		t.Fatal("expired entry must be removed, not resurrected")
	}
}

func TestResponseCacheSkipsEntriesLargerThanTheCache(t *testing.T) {
	cache := NewResponseCache(4, 1024, time.Minute)
	now := time.Now()
	cache.Put("big", ResponseEntry{GzipBody: make([]byte, 2048), RawBytes: 4096}, now)
	if _, ok := cache.Get("big", now); ok {
		t.Fatal("oversized entry was cached")
	}
}
