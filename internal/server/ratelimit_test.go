package server

import (
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newDiscardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestTakeToken(t *testing.T) {
	const ratePerSecond, burst = 0.5, 10.0
	start := time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	bucket := tokenBucket{tokens: burst, updatedAt: start}
	for request := range 10 {
		var allowed bool
		bucket, allowed, _ = takeToken(bucket, start, ratePerSecond, burst)
		if !allowed {
			t.Fatalf("request %d within the burst was refused", request)
		}
	}
	bucket, allowed, retryAfterSeconds := takeToken(bucket, start, ratePerSecond, burst)
	if allowed || retryAfterSeconds != 2 {
		t.Fatalf("past the burst: allowed %v retry after %d, want refused after 2s", allowed, retryAfterSeconds)
	}
	if _, allowed, _ := takeToken(bucket, start.Add(2*time.Second), ratePerSecond, burst); !allowed {
		t.Fatal("a token must be available after 2s at 30/min")
	}
	idle, _, _ := takeToken(bucket, start.Add(24*time.Hour), ratePerSecond, burst)
	if idle.tokens != burst-1 {
		t.Fatalf("tokens after a long idle = %v, want the burst minus one", idle.tokens)
	}
	backwards, allowed, _ := takeToken(bucket, start.Add(-time.Hour), ratePerSecond, burst)
	if allowed || backwards.tokens != bucket.tokens {
		t.Fatal("a clock step backwards must not mint tokens")
	}
}

func TestAPIRateLimitPerClient(t *testing.T) {
	server := newTestServer(t, testServerOptions{
		github: newFakeGitHub(t),
		limits: RateLimits{RequestsPerMinute: 30, Burst: 10, ClientsMax: 100},
	})
	request := func(remoteAddress string, target string) *httptest.ResponseRecorder {
		httpRequest := httptest.NewRequest("GET", target, nil)
		httpRequest.RemoteAddr = remoteAddress
		recorder := httptest.NewRecorder()
		server.ServeHTTP(recorder, httpRequest)
		return recorder
	}
	for attempt := range 10 {
		if response := request("192.0.2.7:1000", "/api/pr/x/y/0"); response.Code != http.StatusBadRequest {
			t.Fatalf("request %d: status %d", attempt, response.Code)
		}
	}
	limited := request("192.0.2.7:2000", "/api/pr/x/y/0")
	if limited.Code != http.StatusTooManyRequests || limited.Header().Get("Retry-After") != "2" ||
		!jsonHasCode(t, limited.Body.Bytes(), "too_many_requests") {
		t.Fatalf("11th request: %d %v %s", limited.Code, limited.Header(), limited.Body)
	}
	checkSecurityHeaders(t, "429", limited.Header())
	if response := request("192.0.2.8:1000", "/api/pr/x/y/0"); response.Code != http.StatusBadRequest {
		t.Fatal("another client must have its own bucket")
	}
	for range 20 {
		if response := request("192.0.2.7:1000", "/"); response.Code != http.StatusOK {
			t.Fatal("page routes are not rate limited")
		}
	}
}

func TestClientKey(t *testing.T) {
	withHeader := newTestServer(t, testServerOptions{github: newFakeGitHub(t), clientIPHeader: "CF-Connecting-IP"})
	direct := newTestServer(t, testServerOptions{github: newFakeGitHub(t)})
	type testCase struct {
		server     *Server
		remoteAddr string
		headerIP   string
		want       string
	}
	testCases := []testCase{
		{direct, "192.0.2.1:5000", "203.0.113.9", "192.0.2.1"},
		{withHeader, "192.0.2.1:5000", "203.0.113.9", "203.0.113.9"},
		{withHeader, "192.0.2.1:5000", " 203.0.113.9 ", "203.0.113.9"},
		{withHeader, "192.0.2.1:5000", "not-an-ip", "192.0.2.1"},
		{withHeader, "192.0.2.1:5000", "203.0.113.9, 198.51.100.1", "192.0.2.1"},
		{withHeader, "192.0.2.1:5000", "", "192.0.2.1"},
		{withHeader, "192.0.2.1:5000", "2001:db8:1:2:aaaa::1", "2001:db8:1:2::/64"},
		{withHeader, "192.0.2.1:5000", "2001:db8:1:2:bbbb::9", "2001:db8:1:2::/64"},
		{direct, "[::ffff:192.0.2.5]:80", "", "192.0.2.5"},
		{direct, "[2001:db8::1]:80", "", "2001:db8::/64"},
	}
	for _, testCase := range testCases {
		request := httptest.NewRequest("GET", "/api/pr/a/b/1", nil)
		request.RemoteAddr = testCase.remoteAddr
		if testCase.headerIP != "" {
			request.Header.Set("CF-Connecting-IP", testCase.headerIP)
		}
		if got := testCase.server.clientKey(request); got != testCase.want {
			t.Errorf("clientKey(%s, %q) = %q, want %q", testCase.remoteAddr, testCase.headerIP, got, testCase.want)
		}
	}
}

func jsonHasCode(t *testing.T, body []byte, code string) bool {
	t.Helper()
	return string(body) == `{"error":"`+code+`","message":"too many requests, retry later"}`
}

// Methodology: with one slot, a second Accept must wait until the first
// connection closes, and Close must release an Accept stuck waiting.
func TestLimitListener(t *testing.T) {
	base, err := net.Listen("tcp", "127.0.0.1:0")
	check(t, err)
	listener := LimitListener(base, 1)
	for range 2 {
		client, err := net.Dial("tcp", base.Addr().String())
		check(t, err)
		defer client.Close()
	}
	first, err := listener.Accept()
	check(t, err)
	accepted := make(chan net.Conn, 1)
	go func() {
		connection, err := listener.Accept()
		if err == nil {
			accepted <- connection
		}
	}()
	select {
	case <-accepted:
		t.Fatal("second connection accepted while the only slot was taken")
	case <-time.After(50 * time.Millisecond):
	}
	check(t, first.Close())
	// A second Close fails like any closed connection and must not free a
	// second slot; the pending Accept below would otherwise see two.
	if err := first.Close(); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("second Close = %v, want net.ErrClosed", err)
	}
	second := <-accepted
	check(t, second.Close())

	blocked := make(chan error, 1)
	holder, err := net.Dial("tcp", base.Addr().String())
	check(t, err)
	defer holder.Close()
	held, err := listener.Accept()
	check(t, err)
	defer held.Close()
	go func() {
		_, err := listener.Accept()
		blocked <- err
	}()
	check(t, listener.Close())
	select {
	case err := <-blocked:
		if err == nil {
			t.Fatal("Accept after Close must fail")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not release a waiting Accept")
	}
}
