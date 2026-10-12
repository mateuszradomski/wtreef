// Package github fetches pull request metadata (GraphQL) and head commit trees
// (REST) and parses them into pullrequest types at the boundary.
package github

import (
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultGraphQLURL  = "https://api.github.com/graphql"
	DefaultRESTBaseURL = "https://api.github.com"

	userAgent                = "wtreef (+https://wtreef.com)"
	restAPIVersion           = "2022-11-28"
	errorBodySnippetBytesMax = 512
	drainBytesMax            = 64 << 10
	retryAfterDefaultSeconds = 60
	retryAfterSecondsMax     = 3600
	dialTimeout              = 10 * time.Second
	tlsHandshakeTimeout      = 10 * time.Second
	idleConnectionTimeout    = 90 * time.Second
	responseHeaderBytesMax   = 1 << 20
)

var (
	// ErrNotFound covers missing repositories, missing pull requests, and
	// private repositories, which must be indistinguishable from missing ones.
	ErrNotFound = errors.New("github: not found")
	// ErrUpstream covers every other failure: transport, status, or a
	// response that does not parse.
	ErrUpstream = errors.New("github: upstream error")
)

// RateLimitError means the server's token is out of budget.
type RateLimitError struct {
	RetryAfterSeconds int
}

func (rateLimit *RateLimitError) Error() string {
	return "github: rate limited, retry after " + strconv.Itoa(rateLimit.RetryAfterSeconds) + "s"
}

type Config struct {
	Token          string
	GraphQLURL     string
	RESTBaseURL    string
	ConcurrencyMax int
	RequestTimeout time.Duration
	Logger         *slog.Logger
}

type Client struct {
	httpClient  *http.Client
	token       string
	graphqlURL  string
	restBaseURL string
	// semaphore caps concurrent outbound requests so a burst of visitors
	// cannot spend the token's budget or open unbounded connections.
	semaphore chan struct{}
	logger    *slog.Logger
}

func NewClient(config Config) *Client {
	assert(config.Token != "", "token is required")
	assert(config.GraphQLURL != "", "GraphQL URL is required")
	assert(config.RESTBaseURL != "", "REST base URL is required")
	assert(config.ConcurrencyMax >= 1, "concurrency is at least 1")
	assert(config.RequestTimeout > 0, "request timeout is positive")
	assert(config.Logger != nil, "logger is required")

	transport := &http.Transport{
		// No proxy: the server talks to GitHub directly and predictably.
		Proxy:                  nil,
		DialContext:            (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout:    tlsHandshakeTimeout,
		ResponseHeaderTimeout:  config.RequestTimeout,
		ExpectContinueTimeout:  time.Second,
		IdleConnTimeout:        idleConnectionTimeout,
		MaxIdleConns:           config.ConcurrencyMax,
		MaxIdleConnsPerHost:    config.ConcurrencyMax,
		MaxConnsPerHost:        config.ConcurrencyMax,
		MaxResponseHeaderBytes: responseHeaderBytesMax,
		// HTTP/1.1 only: one connection per concurrent request is what the
		// limits above allow anyway, and release builds omit HTTP/2 to save size.
		ForceAttemptHTTP2: false,
		// Transparent gzip shrinks a 4 MB tree listing roughly tenfold.
		DisableCompression: false,
	}
	return &Client{
		httpClient: &http.Client{
			Transport: transport,
			Timeout:   config.RequestTimeout,
			// Redirects would mean a renamed resource; treat them as unexpected.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		token:       config.Token,
		graphqlURL:  config.GraphQLURL,
		restBaseURL: strings.TrimSuffix(config.RESTBaseURL, "/"),
		semaphore:   make(chan struct{}, config.ConcurrencyMax),
		logger:      config.Logger,
	}
}

// send holds a semaphore slot until finish is called on the response.
func (client *Client) send(request *http.Request) (*http.Response, error) {
	select {
	case client.semaphore <- struct{}{}:
	case <-request.Context().Done():
		return nil, request.Context().Err()
	}
	request.Header.Set("Authorization", "Bearer "+client.token)
	request.Header.Set("User-Agent", userAgent)
	response, err := client.httpClient.Do(request)
	if err != nil {
		<-client.semaphore
		return nil, err
	}
	return response, nil
}

// finish drains a bounded amount so the connection can be reused, then
// releases the semaphore slot taken by send.
func (client *Client) finish(response *http.Response) {
	_, drainErr := io.Copy(io.Discard, io.LimitReader(response.Body, drainBytesMax))
	closeErr := response.Body.Close()
	<-client.semaphore
	if drainErr != nil || closeErr != nil {
		client.logger.Debug("github response body cleanup failed", "drain_error", drainErr, "close_error", closeErr)
	}
}

// checkStatus maps a non-200 status to RateLimitError or ErrUpstream.
func (client *Client) checkStatus(response *http.Response, operation string) error {
	if response.StatusCode == http.StatusOK {
		return nil
	}
	retryAfterSeconds, limited := rateLimitRetryAfterSeconds(response.StatusCode, response.Header, time.Now())
	if limited {
		client.logger.Warn("github rate limited", "operation", operation,
			"status", response.StatusCode, "retry_after_seconds", retryAfterSeconds)
		return &RateLimitError{RetryAfterSeconds: retryAfterSeconds}
	}
	client.logger.Warn("github unexpected status", "operation", operation,
		"status", response.StatusCode, "body", readSnippet(response.Body))
	return upstreamError(operation, "HTTP status "+strconv.Itoa(response.StatusCode))
}

func upstreamError(operation string, reason string) error {
	return fmt.Errorf("%w: %s: %s", ErrUpstream, operation, reason)
}

// rateLimitRetryAfterSeconds recognizes both the primary limit (remaining
// is 0) and secondary limits (403/429 with Retry-After).
func rateLimitRetryAfterSeconds(statusCode int, header http.Header, now time.Time) (int, bool) {
	if statusCode != http.StatusForbidden && statusCode != http.StatusTooManyRequests {
		return 0, false
	}
	if statusCode == http.StatusForbidden {
		exhausted := header.Get("X-RateLimit-Remaining") == "0"
		hasRetryAfter := header.Get("Retry-After") != ""
		if !exhausted && !hasRetryAfter {
			return 0, false
		}
	}
	return retryAfterSeconds(header, now), true
}

func retryAfterSeconds(header http.Header, now time.Time) int {
	if seconds, ok := parseSeconds(header.Get("Retry-After")); ok {
		return clampRetryAfterSeconds(seconds)
	}
	if resetUnixSeconds, ok := parseSeconds(header.Get("X-RateLimit-Reset")); ok {
		return clampRetryAfterSeconds(resetUnixSeconds - now.Unix())
	}
	return retryAfterDefaultSeconds
}

func clampRetryAfterSeconds(seconds int64) int {
	if seconds < 1 {
		return 1
	}
	if seconds > retryAfterSecondsMax {
		return retryAfterSecondsMax
	}
	return int(seconds)
}

func parseSeconds(value string) (int64, bool) {
	if value == "" {
		return 0, false
	}
	seconds, err := strconv.ParseInt(value, 10, 64)
	if err != nil || seconds < 0 {
		return 0, false
	}
	return seconds, true
}

// readSnippet returns a short prefix of an error body for logs. A short or
// failing read still yields whatever arrived, which is all a log needs.
func readSnippet(body io.Reader) string {
	buffer := make([]byte, errorBodySnippetBytesMax)
	count, err := io.ReadFull(body, buffer)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return "(unreadable body: " + err.Error() + ")"
	}
	return strings.ToValidUTF8(string(buffer[:count]), "?")
}

func assert(condition bool, message string) {
	if !condition {
		panic("assertion failed: " + message)
	}
}
