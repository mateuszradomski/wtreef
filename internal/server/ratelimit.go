package server

import (
	"math"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"wtreef/internal/cache"
)

// ipv6ClientPrefixBits groups IPv6 clients by /64, the block a single
// customer usually controls, so rotating addresses does not reset a limit.
const ipv6ClientPrefixBits = 64

// clientLimiter is a per-client token bucket. Buckets live in an LRU, so
// the client map is bounded and idle clients are the ones evicted; an
// evicted idle client loses nothing because its bucket had refilled.
type clientLimiter struct {
	mutex          sync.Mutex
	buckets        *cache.LRU[tokenBucket]
	ratePerSecond  float64
	burst          float64
	evictedScratch []string
}

type tokenBucket struct {
	tokens    float64
	updatedAt time.Time
}

func newClientLimiter(limits RateLimits) *clientLimiter {
	assert(limits.RequestsPerMinute >= 1, "rate is positive")
	assert(limits.Burst >= 1, "burst allows at least one request")
	assert(limits.ClientsMax >= 1, "at least one client is tracked")
	return &clientLimiter{
		// Every bucket counts as one byte, so the entry bound is the binding one.
		buckets:        cache.NewLRU[tokenBucket](limits.ClientsMax, int64(limits.ClientsMax)),
		ratePerSecond:  float64(limits.RequestsPerMinute) / 60,
		burst:          float64(limits.Burst),
		evictedScratch: make([]string, 0, 1),
	}
}

// allow takes a token for clientKey, or reports how many seconds until one
// is available.
func (limiter *clientLimiter) allow(clientKey string, now time.Time) (bool, int) {
	limiter.mutex.Lock()
	defer limiter.mutex.Unlock()
	bucket, exists := limiter.buckets.Get(clientKey)
	if !exists {
		bucket = tokenBucket{tokens: limiter.burst, updatedAt: now}
	}
	next, allowed, retryAfterSeconds := takeToken(bucket, now, limiter.ratePerSecond, limiter.burst)
	limiter.evictedScratch = limiter.buckets.Put(clientKey, next, 1, limiter.evictedScratch[:0])
	return allowed, retryAfterSeconds
}

func takeToken(bucket tokenBucket, now time.Time, ratePerSecond float64, burst float64) (tokenBucket, bool, int) {
	assert(ratePerSecond > 0, "rate is positive")
	assert(burst >= 1, "burst allows at least one request")
	assert(bucket.tokens >= 0, "tokens never go negative")
	assert(bucket.tokens <= burst, "tokens never exceed the burst")
	// A clock step backwards must not mint tokens.
	elapsedSeconds := max(0, now.Sub(bucket.updatedAt).Seconds())
	tokens := min(burst, bucket.tokens+elapsedSeconds*ratePerSecond)
	if tokens >= 1 {
		return tokenBucket{tokens: tokens - 1, updatedAt: now}, true, 0
	}
	retryAfterSeconds := int(math.Ceil((1 - tokens) / ratePerSecond))
	return tokenBucket{tokens: tokens, updatedAt: now}, false, max(1, retryAfterSeconds)
}

// clientKey trusts the configured proxy header when it holds one valid IP,
// and falls back to the connection's address otherwise (e.g. a request that
// bypassed the proxy).
func (server *Server) clientKey(request *http.Request) string {
	if server.clientIPHeader != "" {
		address, err := netip.ParseAddr(strings.TrimSpace(request.Header.Get(server.clientIPHeader)))
		if err == nil {
			return clientKeyOf(address)
		}
	}
	addressPort, err := netip.ParseAddrPort(request.RemoteAddr)
	if err != nil {
		return request.RemoteAddr
	}
	return clientKeyOf(addressPort.Addr())
}

func clientKeyOf(address netip.Addr) string {
	address = address.Unmap()
	if address.Is4() {
		return address.String()
	}
	prefix, err := address.Prefix(ipv6ClientPrefixBits)
	assert(err == nil, "an IPv6 address has a /64 prefix")
	return prefix.String()
}
