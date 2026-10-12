// Package server routes HTTP requests: the page and asset routes serve the
// embedded frontend, and the API route fetches, prunes, and caches pull
// request trees as described in docs/wire-format.md.
package server

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"wtreef/internal/cache"
	"wtreef/internal/pullrequest"
)

const (
	contentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
		"connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
	apiPrefix            = "/api/"
	apiPullRequestPrefix = "/api/pr/"
	assetsPrefix         = "/assets/"
	healthPath           = "/healthz"

	readHeaderTimeout = 5 * time.Second
	readTimeout       = 10 * time.Second
	// writeTimeout outlasts buildTimeout so a slow GitHub fetch can finish.
	writeTimeout   = buildTimeout + 15*time.Second
	idleTimeout    = 120 * time.Second
	headerBytesMax = 16 << 10
)

// GitHub is the subset of the GitHub client the server needs.
type GitHub interface {
	FetchPullRequest(ctx context.Context, id pullrequest.ID) (pullrequest.PullRequest, error)
	FetchTree(ctx context.Context, repository pullrequest.Repository, sha pullrequest.CommitSHA) (pullrequest.Tree, error)
}

type Config struct {
	GitHub    GitHub
	Trees     *cache.TreeStore
	Responses *cache.ResponseCache
	// Assets is the built frontend directory: index.html plus asset files.
	Assets fs.FS
	// ReloadAssets re-reads Assets on every page load, for development.
	ReloadAssets bool
	// ClientIPHeader names a header set by a trusted proxy that carries the
	// client's IP. Empty means use the connection's remote address.
	ClientIPHeader string
	Limits         RateLimits
	Logger         *slog.Logger
}

type RateLimits struct {
	RequestsPerMinute int
	Burst             int
	ClientsMax        int
}

type Server struct {
	github         GitHub
	trees          *cache.TreeStore
	responses      *cache.ResponseCache
	responseFlight *cache.Group[cache.ResponseEntry]
	treeFlight     *cache.Group[pullrequest.Tree]
	assets         *assetServer
	limiter        *clientLimiter
	clientIPHeader string
	logger         *slog.Logger
}

func New(config Config) (*Server, error) {
	assert(config.GitHub != nil, "GitHub client is required")
	assert(config.Trees != nil, "tree store is required")
	assert(config.Responses != nil, "response cache is required")
	assert(config.Logger != nil, "logger is required")
	assets, err := newAssetServer(config.Assets, config.ReloadAssets, ModeWeb, config.Logger)
	if err != nil {
		return nil, err
	}
	return &Server{
		github:         config.GitHub,
		trees:          config.Trees,
		responses:      config.Responses,
		responseFlight: cache.NewGroup[cache.ResponseEntry](),
		treeFlight:     cache.NewGroup[pullrequest.Tree](),
		assets:         assets,
		limiter:        newClientLimiter(config.Limits),
		clientIPHeader: config.ClientIPHeader,
		logger:         config.Logger,
	}, nil
}

// NewHTTPServer sets every timeout and size limit explicitly instead of
// relying on net/http's unbounded defaults.
func NewHTTPServer(handler http.Handler, logger *slog.Logger) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    headerBytesMax,
		// Route "OPTIONS *" to the handler, which answers 404 like any other
		// unknown request.
		DisableGeneralOptionsHandler: true,
		ErrorLog:                     slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}
}

// ServeHTTP routes on the escaped path, so percent-encoded slashes or dots
// reach the parser as-is and are rejected rather than reinterpreted.
func (server *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	setSecurityHeaders(writer.Header())
	path := request.URL.EscapedPath()
	isAPI := strings.HasPrefix(path, apiPrefix)
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		serveNotFound(writer, isAPI)
		return
	}
	switch {
	case isAPI:
		server.serveAPI(writer, request, path)
	case path == "/":
		server.assets.servePage(writer)
	case path == healthPath:
		serveHealth(writer)
	case strings.HasPrefix(path, assetsPrefix):
		server.assets.serveAsset(writer, request, strings.TrimPrefix(path, assetsPrefix))
	case isPullRequestPagePath(path):
		server.assets.servePage(writer)
	default:
		serveNotFound(writer, false)
	}
}

// isPullRequestPagePath accepts /{owner}/{repo}/pull/{number} and any
// suffix after it, so GitHub sub-tab URLs (/files, /commits) work too.
func isPullRequestPagePath(path string) bool {
	segments := strings.SplitN(strings.TrimPrefix(path, "/"), "/", 5)
	if len(segments) < 4 || segments[2] != "pull" {
		return false
	}
	_, err := pullrequest.ParseID(segments[0], segments[1], segments[3])
	return err == nil
}

func setSecurityHeaders(header http.Header) {
	header.Set("Content-Security-Policy", contentSecurityPolicy)
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Referrer-Policy", "strict-origin-when-cross-origin")
}

func serveHealth(writer http.ResponseWriter) {
	writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	writeBody(writer, http.StatusOK, []byte("ok"))
}

func serveNotFound(writer http.ResponseWriter, isAPI bool) {
	if isAPI {
		writeAPIError(writer, http.StatusNotFound, "not_found", "no such route")
		return
	}
	writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	writeBody(writer, http.StatusNotFound, []byte("404 page not found\n"))
}

// writeBody sets Content-Length and writes. A failed write means the client
// went away; there is nobody left to tell.
func writeBody(writer http.ResponseWriter, status int, body []byte) {
	writer.Header().Set("Content-Length", strconv.Itoa(len(body)))
	writer.WriteHeader(status)
	_, _ = writer.Write(body)
}

func assert(condition bool, message string) {
	if !condition {
		panic("assertion failed: " + message)
	}
}
