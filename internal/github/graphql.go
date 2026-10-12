package github

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"wtreef/internal/pullrequest"
)

const (
	filesPageSize = 100
	// filesPagesMax matches GitHub's 3000-file cap on the files connection.
	filesPagesMax = 30
	// filesPagesInFlightMax leaves room in the client's shared request slots
	// for other pull requests and trees while one huge pull request loads.
	filesPagesInFlightMax    = 8
	graphqlResponseBytesMax  = 8 << 20
	graphqlErrorsLoggedMax   = 5
	pullRequestURLPrefix     = "https://github.com/"
	graphqlErrorNotFound     = "NOT_FOUND"
	graphqlErrorRateLimited  = "RATE_LIMITED"
	graphqlOperationName     = "graphql"
	pullRequestFilesSelector = `files(first:100, after:$after){ pageInfo{hasNextPage endCursor} nodes{ path additions deletions changeType } }`
)

// Every page selects isPrivate so a repository turning private mid-fetch is
// still rejected. Later pages skip the metadata and pin headRefOid, so files
// from two different head commits are never mixed.
const pullRequestFirstPageQuery = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){
    isPrivate nameWithOwner
    pullRequest(number:$number){
      title url state merged author{login} baseRefName headRefName baseRefOid headRefOid
      additions deletions changedFiles
      ` + pullRequestFilesSelector + `
    }
  }
}`

const pullRequestFilesPageQuery = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){
    isPrivate
    pullRequest(number:$number){
      headRefOid
      ` + pullRequestFilesSelector + `
    }
  }
}`

type graphqlRequest struct {
	Query     string           `json:"query"`
	Variables graphqlVariables `json:"variables"`
}

type graphqlVariables struct {
	Owner  string  `json:"owner"`
	Name   string  `json:"name"`
	Number int32   `json:"number"`
	After  *string `json:"after"`
}

type graphqlResponse struct {
	Data   *graphqlData   `json:"data"`
	Errors []graphqlError `json:"errors"`
}

type graphqlData struct {
	Repository *graphqlRepository `json:"repository"`
}

type graphqlError struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

type graphqlRepository struct {
	// A pointer, so a missing field is an error rather than "public".
	IsPrivate     *bool               `json:"isPrivate"`
	NameWithOwner string              `json:"nameWithOwner"`
	PullRequest   *graphqlPullRequest `json:"pullRequest"`
}

type graphqlPullRequest struct {
	Title        string        `json:"title"`
	URL          string        `json:"url"`
	State        string        `json:"state"`
	Merged       bool          `json:"merged"`
	Author       *graphqlActor `json:"author"`
	BaseRefName  string        `json:"baseRefName"`
	HeadRefName  string        `json:"headRefName"`
	BaseRefOid   string        `json:"baseRefOid"`
	HeadRefOid   string        `json:"headRefOid"`
	Additions    int64         `json:"additions"`
	Deletions    int64         `json:"deletions"`
	ChangedFiles int64         `json:"changedFiles"`
	Files        *graphqlFiles `json:"files"`
}

type graphqlActor struct {
	Login string `json:"login"`
}

type graphqlFiles struct {
	PageInfo graphqlPageInfo `json:"pageInfo"`
	Nodes    []graphqlFile   `json:"nodes"`
}

type graphqlPageInfo struct {
	HasNextPage bool    `json:"hasNextPage"`
	EndCursor   *string `json:"endCursor"`
}

type graphqlFile struct {
	Path       string `json:"path"`
	Additions  int64  `json:"additions"`
	Deletions  int64  `json:"deletions"`
	ChangeType string `json:"changeType"`
}

// FetchPullRequest returns the pull request's metadata and up to 3000 changed
// files. Private repositories yield ErrNotFound, exactly like missing ones.
// progress, which may be nil, follows the files pages as they arrive.
func (client *Client) FetchPullRequest(
	ctx context.Context, id pullrequest.ID, progress *Progress,
) (pullrequest.PullRequest, error) {
	firstPage, err := client.fetchRepositoryPage(ctx, id, pullRequestFirstPageQuery, nil)
	if err != nil {
		return pullrequest.PullRequest{}, err
	}
	pull, err := parsePullRequestMetadata(id, firstPage)
	if err != nil {
		client.logger.Warn("github pull request metadata rejected", "pull_request", id.String(), "error", err)
		return pullrequest.PullRequest{}, err
	}
	firstFiles := firstPage.PullRequest.Files
	progress.startFiles(min(pull.ChangedFiles, filesPagesMax*filesPageSize))
	progress.addFiles(firstFiles)
	pageCount := prefetchPageCount(firstFiles, pull.ChangedFiles)
	// Every reason to skip prefetching a multi-page connection means GitHub
	// paginates unlike measured, which turns big pull requests slow again.
	if pageCount == 0 && firstFiles != nil && firstFiles.PageInfo.HasNextPage {
		client.logger.Warn("github files pagination is not offset-based, fetching sequentially", "pull_request", id.String())
	}
	prefetched, err := client.prefetchFilesPages(ctx, id, pull.HeadSHA, pageCount, progress)
	if err != nil {
		return pullrequest.PullRequest{}, err
	}
	files, err := client.collectFiles(ctx, id, pull.HeadSHA, firstFiles, prefetched, progress)
	if err != nil {
		return pullrequest.PullRequest{}, err
	}
	pull.Files = files
	assert(int64(len(pull.Files)) <= filesPagesMax*filesPageSize, "file count is bounded by the page limit")
	return pull, nil
}

// prefetchedPage is a files page fetched ahead of its predecessor, so it is
// only trusted once the predecessor's endCursor proves it is the next page.
type prefetchedPage struct {
	cursor string
	files  *graphqlFiles
}

// prefetchPageCount returns how many pages, the first included, the files
// connection should span, or 0 when prefetching does not apply. GitHub's
// files cursor is the unpadded base64 offset of the last file returned;
// that is undocumented, so the first page's endCursor must confirm it.
func prefetchPageCount(firstPage *graphqlFiles, changedFiles int64) int {
	if firstPage == nil || !firstPage.PageInfo.HasNextPage {
		return 0
	}
	if len(firstPage.Nodes) != filesPageSize {
		return 0
	}
	cursor := firstPage.PageInfo.EndCursor
	if cursor == nil || *cursor != filesCursor(filesPageSize) {
		return 0
	}
	pageCount := (changedFiles + filesPageSize - 1) / filesPageSize
	if pageCount < 2 {
		return 0
	}
	return int(min(pageCount, filesPagesMax))
}

func filesCursor(offset int) string {
	assert(offset > 0, "the first page has no cursor")
	// Unpadded, as GitHub returns it: the walk compares cursors as strings.
	return base64.RawStdEncoding.EncodeToString([]byte(strconv.Itoa(offset)))
}

// prefetchFilesPages fetches pages 1 through pageCount-1 concurrently,
// bounded by filesPagesInFlightMax. Index 0 stays empty: the first page
// arrived with the metadata. The first failure cancels the rest.
func (client *Client) prefetchFilesPages(
	ctx context.Context, id pullrequest.ID, headSHA pullrequest.CommitSHA, pageCount int, progress *Progress,
) ([]prefetchedPage, error) {
	assert(pageCount >= 0, "page count is not negative")
	assert(pageCount <= filesPagesMax, "page count is bounded by the page limit")
	if pageCount < 2 {
		return nil, nil
	}
	pages := make([]prefetchedPage, pageCount)
	workContext, cancel := context.WithCancel(ctx)
	defer cancel()

	var nextPageIndex atomic.Int32
	var firstErrMutex sync.Mutex
	var firstErr error
	var workers sync.WaitGroup
	for range min(filesPagesInFlightMax, pageCount-1) {
		workers.Go(func() {
			for {
				pageIndex := int(nextPageIndex.Add(1))
				if pageIndex >= pageCount {
					return
				}
				cursor := filesCursor(pageIndex * filesPageSize)
				files, err := client.fetchFilesPage(workContext, id, headSHA, &cursor)
				if err != nil {
					// Recorded before cancelling, so errors the cancellation
					// causes in other workers never mask the original one.
					firstErrMutex.Lock()
					if firstErr == nil {
						firstErr = err
					}
					firstErrMutex.Unlock()
					cancel()
					return
				}
				pages[pageIndex] = prefetchedPage{cursor: cursor, files: files}
				progress.addFiles(files)
			}
		})
	}
	workers.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	return pages, nil
}

// collectFiles walks the pages in order, taking each from prefetched when
// the previous page's endCursor matches the cursor it was fetched with and
// fetching it otherwise, so a wrong prefetch costs requests, never files.
func (client *Client) collectFiles(
	ctx context.Context, id pullrequest.ID, headSHA pullrequest.CommitSHA,
	firstPage *graphqlFiles, prefetched []prefetchedPage, progress *Progress,
) ([]pullrequest.ChangedFile, error) {
	files := make([]pullrequest.ChangedFile, 0, filesPageSize)
	seenPaths := make(map[string]struct{}, filesPageSize)
	page := firstPage
	for pageIndex := 0; pageIndex < filesPagesMax; pageIndex++ {
		// GitHub may return a null connection for huge pull requests;
		// truncated.files then tells the client the list is partial.
		if page == nil {
			break
		}
		if len(page.Nodes) > filesPageSize {
			return nil, upstreamError(graphqlOperationName, "page holds more files than requested")
		}
		for _, node := range page.Nodes {
			file, err := parseChangedFile(node)
			if err != nil {
				client.logger.Warn("github changed file rejected", "pull_request", id.String(), "error", err)
				return nil, err
			}
			if _, duplicate := seenPaths[file.Path()]; duplicate {
				return nil, upstreamError(graphqlOperationName, "duplicate changed file path")
			}
			seenPaths[file.Path()] = struct{}{}
			files = append(files, file)
		}
		if !page.PageInfo.HasNextPage || pageIndex+1 == filesPagesMax {
			break
		}
		cursor := page.PageInfo.EndCursor
		if cursor == nil || *cursor == "" {
			return nil, upstreamError(graphqlOperationName, "next page announced without a cursor")
		}
		nextPageIndex := pageIndex + 1
		if nextPageIndex < len(prefetched) && prefetched[nextPageIndex].cursor == *cursor {
			page = prefetched[nextPageIndex].files
			continue
		}
		nextPage, err := client.fetchFilesPage(ctx, id, headSHA, cursor)
		if err != nil {
			return nil, err
		}
		progress.addFiles(nextPage)
		page = nextPage
	}
	return files, nil
}

// fetchFilesPage pins every page to the head commit of the first, so files
// from two different head commits are never mixed.
func (client *Client) fetchFilesPage(
	ctx context.Context, id pullrequest.ID, headSHA pullrequest.CommitSHA, cursor *string,
) (*graphqlFiles, error) {
	assert(cursor != nil, "pages after the first have a cursor")
	repository, err := client.fetchRepositoryPage(ctx, id, pullRequestFilesPageQuery, cursor)
	if err != nil {
		return nil, err
	}
	if repository.PullRequest.HeadRefOid != headSHA.String() {
		return nil, upstreamError(graphqlOperationName, "head commit changed during pagination")
	}
	return repository.PullRequest.Files, nil
}

// fetchRepositoryPage returns a repository whose pullRequest is non-null.
func (client *Client) fetchRepositoryPage(
	ctx context.Context, id pullrequest.ID, query string, after *string,
) (*graphqlRepository, error) {
	request := graphqlRequest{
		Query: query,
		Variables: graphqlVariables{
			Owner:  id.Repository().Owner(),
			Name:   id.Repository().Name(),
			Number: id.Number(),
			After:  after,
		},
	}
	decoded, header, err := client.postGraphQL(ctx, request)
	if err != nil {
		return nil, err
	}
	if decoded.Data == nil && len(decoded.Errors) == 0 {
		return nil, upstreamError(graphqlOperationName, "response has neither data nor errors")
	}
	var repository *graphqlRepository
	if decoded.Data != nil {
		repository = decoded.Data.Repository
	}
	// Checked before errors are classified or logged, so nothing about a
	// private repository leaves this function and its 404 matches a missing one.
	if repository != nil && repository.IsPrivate != nil && *repository.IsPrivate {
		return nil, ErrNotFound
	}
	if err := classifyGraphQLErrors(decoded.Errors, header, time.Now()); err != nil {
		client.logGraphQLErrors(id, decoded.Errors, err)
		return nil, err
	}
	if repository == nil || repository.PullRequest == nil {
		return nil, ErrNotFound
	}
	if repository.IsPrivate == nil {
		return nil, upstreamError(graphqlOperationName, "repository.isPrivate is missing")
	}
	return repository, nil
}

func (client *Client) postGraphQL(ctx context.Context, request graphqlRequest) (graphqlResponse, http.Header, error) {
	body, err := json.Marshal(request)
	assert(err == nil, "GraphQL request types always encode")
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, client.graphqlURL, bytes.NewReader(body))
	if err != nil {
		return graphqlResponse{}, nil, upstreamError(graphqlOperationName, "building request: "+err.Error())
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Accept", "application/json")
	response, err := client.send(httpRequest)
	if err != nil {
		client.logger.Warn("github request failed", "operation", graphqlOperationName, "error", err)
		return graphqlResponse{}, nil, upstreamError(graphqlOperationName, "transport: "+err.Error())
	}
	defer client.finish(response)
	if err := client.checkStatus(response, graphqlOperationName); err != nil {
		return graphqlResponse{}, nil, err
	}
	var decoded graphqlResponse
	decoder := json.NewDecoder(io.LimitReader(response.Body, graphqlResponseBytesMax))
	if err := decoder.Decode(&decoded); err != nil {
		client.logger.Warn("github response malformed", "operation", graphqlOperationName, "error", err)
		return graphqlResponse{}, nil, upstreamError(graphqlOperationName, "malformed response: "+err.Error())
	}
	return decoded, response.Header, nil
}

// classifyGraphQLErrors gives rate limiting precedence over not-found so a
// throttled token is never reported as a missing pull request.
func classifyGraphQLErrors(graphqlErrors []graphqlError, header http.Header, now time.Time) error {
	if len(graphqlErrors) == 0 {
		return nil
	}
	for _, graphqlErr := range graphqlErrors {
		if graphqlErr.Type == graphqlErrorRateLimited {
			return &RateLimitError{RetryAfterSeconds: retryAfterSeconds(header, now)}
		}
	}
	for _, graphqlErr := range graphqlErrors {
		if graphqlErr.Type == graphqlErrorNotFound {
			return ErrNotFound
		}
	}
	return upstreamError(graphqlOperationName, "response carries errors")
}

func (client *Client) logGraphQLErrors(id pullrequest.ID, graphqlErrors []graphqlError, classified error) {
	if errors.Is(classified, ErrNotFound) {
		return
	}
	for index, graphqlErr := range graphqlErrors {
		if index == graphqlErrorsLoggedMax {
			break
		}
		client.logger.Warn("github GraphQL error", "pull_request", id.String(),
			"type", graphqlErr.Type, "message", graphqlErr.Message)
	}
}

func parsePullRequestMetadata(id pullrequest.ID, repository *graphqlRepository) (pullrequest.PullRequest, error) {
	pull := repository.PullRequest
	assert(pull != nil, "fetchRepositoryPage guarantees a pull request")
	canonical, err := pullrequest.ParseNameWithOwner(repository.NameWithOwner)
	if err != nil {
		return pullrequest.PullRequest{}, upstreamError(graphqlOperationName, "nameWithOwner: "+err.Error())
	}
	state, ok := parseState(pull.State, pull.Merged)
	if !ok {
		return pullrequest.PullRequest{}, upstreamError(graphqlOperationName, "unknown state "+pull.State)
	}
	baseSHA, err := pullrequest.ParseCommitSHA(pull.BaseRefOid)
	if err != nil {
		return pullrequest.PullRequest{}, upstreamError(graphqlOperationName, "baseRefOid: "+err.Error())
	}
	headSHA, err := pullrequest.ParseCommitSHA(pull.HeadRefOid)
	if err != nil {
		return pullrequest.PullRequest{}, upstreamError(graphqlOperationName, "headRefOid: "+err.Error())
	}
	if !strings.HasPrefix(pull.URL, pullRequestURLPrefix) {
		return pullrequest.PullRequest{}, upstreamError(graphqlOperationName, "url is not on github.com")
	}
	if pull.Additions < 0 || pull.Deletions < 0 || pull.ChangedFiles < 0 {
		return pullrequest.PullRequest{}, upstreamError(graphqlOperationName, "negative counts")
	}
	author := ""
	if pull.Author != nil {
		author = pull.Author.Login
	}
	return pullrequest.PullRequest{
		Repository:   canonical,
		Number:       id.Number(),
		Title:        pull.Title,
		URL:          pull.URL,
		Author:       author,
		State:        state,
		BaseRef:      pull.BaseRefName,
		HeadRef:      pull.HeadRefName,
		BaseSHA:      baseSHA,
		HeadSHA:      headSHA,
		Additions:    pull.Additions,
		Deletions:    pull.Deletions,
		ChangedFiles: pull.ChangedFiles,
	}, nil
}

func parseState(state string, merged bool) (pullrequest.State, bool) {
	switch state {
	case "OPEN":
		return pullrequest.StateOpen, true
	case "CLOSED":
		if merged {
			return pullrequest.StateMerged, true
		}
		return pullrequest.StateClosed, true
	case "MERGED":
		return pullrequest.StateMerged, true
	}
	return 0, false
}

func parseChangedFile(node graphqlFile) (pullrequest.ChangedFile, error) {
	status, ok := parseChangeType(node.ChangeType)
	if !ok {
		return pullrequest.ChangedFile{}, upstreamError(graphqlOperationName, "unknown changeType "+node.ChangeType)
	}
	file, err := pullrequest.NewChangedFile(node.Path, status, node.Additions, node.Deletions)
	if err != nil {
		return pullrequest.ChangedFile{}, upstreamError(graphqlOperationName, "changed file: "+err.Error())
	}
	return file, nil
}

// parseChangeType maps GitHub's PatchStatus onto the wire statuses. A copy
// is a new file at its path; a mode change is a modification.
func parseChangeType(changeType string) (pullrequest.Status, bool) {
	switch changeType {
	case "ADDED", "COPIED":
		return pullrequest.StatusAdded, true
	case "MODIFIED", "CHANGED":
		return pullrequest.StatusModified, true
	case "DELETED":
		return pullrequest.StatusDeleted, true
	case "RENAMED":
		return pullrequest.StatusRenamed, true
	}
	return pullrequest.StatusUnchanged, false
}
