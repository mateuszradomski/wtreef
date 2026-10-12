package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"wtreef/internal/cache"
	"wtreef/internal/github"
	"wtreef/internal/prune"
	"wtreef/internal/pullrequest"
)

const (
	// buildTimeout bounds one response build: up to 30 GraphQL pages plus
	// the tree. It is detached from visitors, who may give up earlier.
	buildTimeout         = 90 * time.Second
	gzipLevel            = 6
	responseCacheControl = "public, max-age=60"
)

type apiError struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

func (server *Server) serveAPI(writer http.ResponseWriter, request *http.Request, path string) {
	// Progress is a map lookup polled several times a second while a pull
	// request loads, so it does not spend the client's rate limit.
	if rest, isProgressRoute := strings.CutPrefix(path, apiProgressPrefix); isProgressRoute {
		server.serveProgress(writer, rest)
		return
	}
	allowed, retryAfterSeconds := server.limiter.allow(server.clientKey(request), time.Now())
	if !allowed {
		writer.Header().Set("Retry-After", strconv.Itoa(retryAfterSeconds))
		writeAPIError(writer, http.StatusTooManyRequests, "too_many_requests", "too many requests, retry later")
		return
	}
	rest, isPullRequestRoute := strings.CutPrefix(path, apiPullRequestPrefix)
	if !isPullRequestRoute {
		writeAPIError(writer, http.StatusNotFound, "not_found", "no such route")
		return
	}
	id, err := parseAPIPath(rest)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	entry, err := server.loadResponse(request.Context(), id)
	if err != nil {
		server.writeLoadError(writer, request, id, err)
		return
	}
	if err := writeResponseEntry(writer, request, entry); err != nil {
		server.logger.Debug("response write failed", "pull_request", id.String(), "error", err)
	}
}

func parseAPIPath(rest string) (pullrequest.ID, error) {
	segments := strings.SplitN(rest, "/", 4)
	if len(segments) != 3 {
		return pullrequest.ID{}, errors.New("path must be /api/pr/{owner}/{repo}/{number}")
	}
	return pullrequest.ParseID(segments[0], segments[1], segments[2])
}

// loadResponse serves from the response cache or coalesces concurrent
// requests for the same pull request into one build.
func (server *Server) loadResponse(ctx context.Context, id pullrequest.ID) (cache.ResponseEntry, error) {
	key := id.CacheKey()
	if entry, hit := server.responses.Get(key, time.Now()); hit {
		return entry, nil
	}
	return server.responseFlight.Do(ctx, key, func() (cache.ResponseEntry, error) {
		// A flight that finished between the lookup above and this one
		// joining may already have filled the cache.
		if entry, hit := server.responses.Get(key, time.Now()); hit {
			return entry, nil
		}
		progress := &github.Progress{}
		server.builds.add(key, progress)
		defer server.builds.remove(key, progress)
		workContext, cancel := context.WithTimeout(context.Background(), buildTimeout)
		defer cancel()
		entry, err := server.buildResponse(workContext, id, progress)
		if err != nil {
			return cache.ResponseEntry{}, err
		}
		server.responses.Put(key, entry, time.Now())
		return entry, nil
	})
}

func (server *Server) buildResponse(
	ctx context.Context, id pullrequest.ID, progress *github.Progress,
) (cache.ResponseEntry, error) {
	started := time.Now()
	pull, err := server.github.FetchPullRequest(ctx, id, progress)
	if err != nil {
		return cache.ResponseEntry{}, err
	}
	tree, err := server.loadTree(ctx, pull.Repository, pull.HeadSHA, progress)
	if err != nil {
		return cache.ResponseEntry{}, err
	}
	response := prune.NewResponse(pull, tree, time.Now())
	body := prune.Marshal(response)
	gzipBody := compress(body)
	server.logger.Info("pull request built", "pull_request", id.String(),
		"files", len(pull.Files), "tree_entries", tree.Len(), "nodes", len(response.Tree.Names),
		"body_bytes", len(body), "gzip_bytes", len(gzipBody), "duration_ms", time.Since(started).Milliseconds())
	return cache.ResponseEntry{GzipBody: gzipBody, RawBytes: int64(len(body))}, nil
}

// loadTree serves from the disk store or coalesces fetches of the same
// commit. A failed store write only costs a refetch later, so it is logged.
// Tree entries are counted into the progress of the load that started the
// fetch; a load that joins it only learns that the tree is underway.
func (server *Server) loadTree(
	ctx context.Context, repository pullrequest.Repository, sha pullrequest.CommitSHA, progress *github.Progress,
) (pullrequest.Tree, error) {
	if tree, hit := server.trees.Get(sha); hit {
		return tree, nil
	}
	progress.StartTree()
	return server.treeFlight.Do(ctx, sha.String(), func() (pullrequest.Tree, error) {
		workContext, cancel := context.WithTimeout(context.Background(), buildTimeout)
		defer cancel()
		tree, err := server.github.FetchTree(workContext, repository, sha, progress)
		if err != nil {
			return pullrequest.Tree{}, err
		}
		if err := server.trees.Put(sha, tree); err != nil {
			server.logger.Warn("tree store write failed", "sha", sha.String(), "error", err)
		}
		return tree, nil
	})
}

// writeLoadError maps GitHub failures onto the contract's error codes. Not
// found and private repositories share one code path, so their responses
// are byte-for-byte identical.
func (server *Server) writeLoadError(writer http.ResponseWriter, request *http.Request, id pullrequest.ID, err error) {
	var rateLimit *github.RateLimitError
	switch {
	case errors.Is(err, github.ErrNotFound):
		writeAPIError(writer, http.StatusNotFound, "not_found", "pull request not found")
	case errors.As(err, &rateLimit):
		writer.Header().Set("Retry-After", strconv.Itoa(rateLimit.RetryAfterSeconds))
		writeAPIError(writer, http.StatusServiceUnavailable, "github_rate_limited",
			"the server's GitHub API budget is exhausted, retry later")
	default:
		if request.Context().Err() == nil {
			server.logger.Warn("pull request load failed", "pull_request", id.String(), "error", err)
		}
		writeAPIError(writer, http.StatusBadGateway, "upstream_error", "GitHub request failed")
	}
}

func writeAPIError(writer http.ResponseWriter, status int, code string, message string) {
	assert(status >= 400, "errors use error statuses")
	assert(code != "", "errors carry a code")
	body, err := json.Marshal(apiError{Error: code, Message: message})
	assert(err == nil, "error bodies always encode")
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writeBody(writer, status, body)
}

// writeResponseEntry sends the cached gzip bytes as-is when the client
// accepts gzip, and decompresses on the fly otherwise.
func writeResponseEntry(writer http.ResponseWriter, request *http.Request, entry cache.ResponseEntry) error {
	header := writer.Header()
	header.Set("Content-Type", "application/json")
	header.Set("Cache-Control", responseCacheControl)
	header.Set("Vary", "Accept-Encoding")
	if acceptsGzip(request.Header.Values("Accept-Encoding")) {
		header.Set("Content-Encoding", "gzip")
		header.Set("Content-Length", strconv.Itoa(len(entry.GzipBody)))
		writer.WriteHeader(http.StatusOK)
		_, err := writer.Write(entry.GzipBody)
		return err
	}
	header.Set("Content-Length", strconv.FormatInt(entry.RawBytes, 10))
	writer.WriteHeader(http.StatusOK)
	decompressor, err := gzip.NewReader(bytes.NewReader(entry.GzipBody))
	assert(err == nil, "cached bodies are gzip streams this process wrote")
	written, err := io.Copy(writer, decompressor)
	if err != nil {
		return err
	}
	assert(written == entry.RawBytes, "decompressed size matches the recorded raw size")
	return nil
}

func compress(body []byte) []byte {
	buffer := bytes.Buffer{}
	buffer.Grow(len(body)/4 + 64)
	compressor, err := gzip.NewWriterLevel(&buffer, gzipLevel)
	assert(err == nil, "gzip level is valid")
	_, err = compressor.Write(body)
	assert(err == nil, "writes to memory do not fail")
	err = compressor.Close()
	assert(err == nil, "closing a gzip writer over memory does not fail")
	return buffer.Bytes()
}

// acceptsGzip follows RFC 9110 content negotiation for the one coding the
// server offers: an explicit gzip entry decides, otherwise "*" does.
func acceptsGzip(headerValues []string) bool {
	gzipQuality := -1.0
	wildcardQuality := -1.0
	for _, value := range headerValues {
		for _, part := range strings.Split(value, ",") {
			coding, quality := parseCoding(part)
			switch coding {
			case "gzip", "x-gzip":
				gzipQuality = quality
			case "*":
				wildcardQuality = quality
			}
		}
	}
	if gzipQuality >= 0 {
		return gzipQuality > 0
	}
	return wildcardQuality > 0
}

// parseCoding returns a lowercased coding and its q value; a malformed q
// value counts as 0 so it can never enable a coding by accident.
func parseCoding(part string) (string, float64) {
	coding, parameters, _ := strings.Cut(part, ";")
	coding = strings.ToLower(strings.TrimSpace(coding))
	quality := 1.0
	for _, parameter := range strings.Split(parameters, ";") {
		name, value, found := strings.Cut(parameter, "=")
		if !found || !strings.EqualFold(strings.TrimSpace(name), "q") {
			continue
		}
		parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		if err != nil || parsed < 0 || parsed > 1 {
			return coding, 0
		}
		quality = parsed
	}
	return coding, quality
}
