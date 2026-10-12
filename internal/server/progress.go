package server

import (
	"encoding/json"
	"net/http"
	"sync"

	"wtreef/internal/github"
)

const (
	progressStageIdle        = "idle"
	progressStagePullRequest = "pullRequest"
	progressStageFiles       = "files"
	progressStageTree        = "tree"
)

// progressResponse is the body of GET /api/progress, see docs/wire-format.md.
type progressResponse struct {
	Stage        string `json:"stage"`
	FilesFetched int64  `json:"filesFetched"`
	FilesTotal   int64  `json:"filesTotal"`
	TreeEntries  int64  `json:"treeEntries"`
}

// buildRegistry maps a pull request's cache key to the progress of its
// build in flight. The response flight runs one build per key at a time, so
// a key holds at most one entry, and entries live only as long as builds.
type buildRegistry struct {
	mutex sync.Mutex
	byKey map[string]*github.Progress
}

func newBuildRegistry() *buildRegistry {
	return &buildRegistry{byKey: make(map[string]*github.Progress)}
}

func (registry *buildRegistry) add(key string, progress *github.Progress) {
	registry.mutex.Lock()
	defer registry.mutex.Unlock()
	_, building := registry.byKey[key]
	assert(!building, "the response flight runs one build per key")
	registry.byKey[key] = progress
}

func (registry *buildRegistry) remove(key string, progress *github.Progress) {
	registry.mutex.Lock()
	defer registry.mutex.Unlock()
	assert(registry.byKey[key] == progress, "only the running build is registered under its key")
	delete(registry.byKey, key)
}

func (registry *buildRegistry) get(key string) (*github.Progress, bool) {
	registry.mutex.Lock()
	defer registry.mutex.Unlock()
	progress, building := registry.byKey[key]
	return progress, building
}

// serveProgress reports how far the build of a pull request has come.
// "idle" means none is running: it has not started, it finished, or the
// response is cached. A private repository's build fails on its first
// page, so its progress never shows more than "pullRequest".
func (server *Server) serveProgress(writer http.ResponseWriter, rest string) {
	id, err := parseAPIPath(rest)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	response := progressResponse{Stage: progressStageIdle}
	if progress, building := server.builds.get(id.CacheKey()); building {
		response = newProgressResponse(progress.Snapshot())
	}
	body, err := json.Marshal(response)
	assert(err == nil, "progress bodies always encode")
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writeBody(writer, http.StatusOK, body)
}

func newProgressResponse(snapshot github.ProgressSnapshot) progressResponse {
	assert(snapshot.FilesFetched <= snapshot.FilesTotal, "fetched files never exceed the total")
	response := progressResponse{
		FilesFetched: snapshot.FilesFetched,
		FilesTotal:   snapshot.FilesTotal,
		TreeEntries:  snapshot.TreeEntries,
	}
	switch snapshot.Stage {
	case github.StagePullRequest:
		response.Stage = progressStagePullRequest
	case github.StageFiles:
		response.Stage = progressStageFiles
	case github.StageTree:
		response.Stage = progressStageTree
	default:
		assert(false, "every stage has a name")
	}
	return response
}
