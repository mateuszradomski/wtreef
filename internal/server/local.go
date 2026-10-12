package server

import (
	"context"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"wtreef/internal/cache"
	"wtreef/internal/localgit"
	"wtreef/internal/prune"
)

const (
	localAPIPath = "/api/local"
	// localBuildTimeout bounds one read of the checkout; git on a large
	// repository takes seconds, not minutes.
	localBuildTimeout = 60 * time.Second
	localFlightKey    = "branch"
)

// LocalBranch is the subset of localgit.Repository the local server needs.
type LocalBranch interface {
	Snapshot(ctx context.Context) (localgit.Snapshot, error)
}

type LocalConfig struct {
	Branch       LocalBranch
	Assets       fs.FS
	ReloadAssets bool
	// AllowedHosts are the host names (no port) the server answers to.
	// Empty allows any host.
	AllowedHosts []string
	Logger       *slog.Logger
}

// LocalServer serves one checkout's current branch to a browser on the
// same machine. There is no cache: every page load reads the working tree.
type LocalServer struct {
	branch       LocalBranch
	assets       *assetServer
	flight       *cache.Group[[]byte]
	allowedHosts []string
	logger       *slog.Logger
}

func NewLocal(config LocalConfig) (*LocalServer, error) {
	assert(config.Branch != nil, "branch is required")
	assert(config.Logger != nil, "logger is required")
	assets, err := newAssetServer(config.Assets, config.ReloadAssets, ModeLocal, config.Logger)
	if err != nil {
		return nil, err
	}
	return &LocalServer{
		branch:       config.Branch,
		assets:       assets,
		flight:       cache.NewGroup[[]byte](),
		allowedHosts: config.AllowedHosts,
		logger:       config.Logger,
	}, nil
}

func (server *LocalServer) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	setSecurityHeaders(writer.Header())
	path := request.URL.EscapedPath()
	isAPI := strings.HasPrefix(path, apiPrefix)
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		serveNotFound(writer, isAPI)
		return
	}
	// A web page can point its own host name at 127.0.0.1 (DNS rebinding)
	// and then read this server as same-origin. It cannot change the Host
	// header the browser sends, so only local names are answered.
	if !server.isAllowedHost(request.Host) {
		writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
		writer.Header().Set("Cache-Control", "no-store")
		writeBody(writer, http.StatusForbidden, []byte("wtreef answers only to localhost\n"))
		return
	}
	switch {
	case path == localAPIPath:
		server.serveBranch(writer, request)
	case path == "/":
		server.assets.servePage(writer)
	case path == healthPath:
		serveHealth(writer)
	case strings.HasPrefix(path, assetsPrefix):
		server.assets.serveAsset(writer, request, strings.TrimPrefix(path, assetsPrefix))
	default:
		serveNotFound(writer, isAPI)
	}
}

func (server *LocalServer) isAllowedHost(hostHeader string) bool {
	if len(server.allowedHosts) == 0 {
		return true
	}
	host, _, err := net.SplitHostPort(hostHeader)
	if err != nil {
		host = strings.TrimSuffix(strings.TrimPrefix(hostHeader, "["), "]")
	}
	for _, allowed := range server.allowedHosts {
		if strings.EqualFold(host, allowed) {
			return true
		}
	}
	return false
}

// serveBranch coalesces concurrent loads, e.g. several open tabs reloading
// at once, into one read of the checkout.
func (server *LocalServer) serveBranch(writer http.ResponseWriter, request *http.Request) {
	body, err := server.flight.Do(request.Context(), localFlightKey, func() ([]byte, error) {
		workContext, cancel := context.WithTimeout(context.Background(), localBuildTimeout)
		defer cancel()
		return server.buildBranch(workContext)
	})
	if err != nil {
		if request.Context().Err() == nil {
			server.logger.Warn("reading the branch failed", "error", err)
		}
		writeAPIError(writer, http.StatusInternalServerError, "local_error", err.Error())
		return
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writeBody(writer, http.StatusOK, body)
}

func (server *LocalServer) buildBranch(ctx context.Context) ([]byte, error) {
	started := time.Now()
	snapshot, err := server.branch.Snapshot(ctx)
	if err != nil {
		return nil, err
	}
	response := prune.NewBranchResponse(prune.ResponseBranch{
		Repo:        snapshot.Name,
		HeadRef:     snapshot.HeadRef,
		BaseRef:     snapshot.BaseRef,
		BaseSHA:     snapshot.BaseSHA,
		HeadSHA:     snapshot.HeadSHA,
		Uncommitted: snapshot.Uncommitted,
		Additions:   snapshot.Additions,
		Deletions:   snapshot.Deletions,
	}, snapshot.Tree, snapshot.Files, time.Now())
	body := prune.MarshalBranch(response)
	server.logger.Debug("branch built", "head", snapshot.HeadRef, "base", snapshot.BaseRef,
		"files", len(snapshot.Files), "tree_entries", snapshot.Tree.Len(), "nodes", len(response.Tree.Names),
		"body_bytes", len(body), "duration_ms", time.Since(started).Milliseconds())
	return body, nil
}
