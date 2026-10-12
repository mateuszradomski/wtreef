package prune

import (
	"bytes"
	"encoding/json"
	"time"

	"wtreef/internal/pullrequest"
)

const WireFormatVersion = 1

// Response is the 200 body of GET /api/pr/{owner}/{repo}/{number}.
type Response struct {
	Version     int                 `json:"version"`
	PullRequest ResponsePullRequest `json:"pullRequest"`
	Tree        Nodes               `json:"tree"`
	Truncated   ResponseTruncated   `json:"truncated"`
	FetchedAt   string              `json:"fetchedAt"`
}

type ResponsePullRequest struct {
	Owner        string `json:"owner"`
	Repo         string `json:"repo"`
	Number       int32  `json:"number"`
	Title        string `json:"title"`
	URL          string `json:"url"`
	Author       string `json:"author"`
	State        string `json:"state"`
	BaseRef      string `json:"baseRef"`
	HeadRef      string `json:"headRef"`
	BaseSHA      string `json:"baseSha"`
	HeadSHA      string `json:"headSha"`
	Additions    int64  `json:"additions"`
	Deletions    int64  `json:"deletions"`
	ChangedFiles int64  `json:"changedFiles"`
}

type ResponseTruncated struct {
	Files bool `json:"files"`
	Tree  bool `json:"tree"`
}

func NewResponse(pull pullrequest.PullRequest, tree pullrequest.Tree, fetchedAt time.Time) Response {
	assert(!fetchedAt.IsZero(), "fetch time is set")
	return Response{
		Version: WireFormatVersion,
		PullRequest: ResponsePullRequest{
			Owner:        pull.Repository.Owner(),
			Repo:         pull.Repository.Name(),
			Number:       pull.Number,
			Title:        pull.Title,
			URL:          pull.URL,
			Author:       pull.Author,
			State:        pull.State.String(),
			BaseRef:      pull.BaseRef,
			HeadRef:      pull.HeadRef,
			BaseSHA:      pull.BaseSHA.String(),
			HeadSHA:      pull.HeadSHA.String(),
			Additions:    pull.Additions,
			Deletions:    pull.Deletions,
			ChangedFiles: pull.ChangedFiles,
		},
		Tree:      Build(tree, pull.Files),
		Truncated: ResponseTruncated{Files: pull.FilesTruncated(), Tree: tree.Truncated()},
		FetchedAt: fetchedAt.UTC().Truncate(time.Second).Format(time.RFC3339),
	}
}

// BranchResponse is the 200 body of GET /api/local: the same tree, around
// a local branch instead of a pull request.
type BranchResponse struct {
	Version   int               `json:"version"`
	Branch    ResponseBranch    `json:"branch"`
	Tree      Nodes             `json:"tree"`
	Truncated ResponseTruncated `json:"truncated"`
	FetchedAt string            `json:"fetchedAt"`
}

type ResponseBranch struct {
	Repo        string `json:"repo"`
	HeadRef     string `json:"headRef"`
	BaseRef     string `json:"baseRef"`
	BaseSHA     string `json:"baseSha"`
	HeadSHA     string `json:"headSha"`
	Uncommitted bool   `json:"uncommitted"`
	Additions   int64  `json:"additions"`
	Deletions   int64  `json:"deletions"`
	// ChangedFiles is filled in by NewBranchResponse.
	ChangedFiles int64 `json:"changedFiles"`
}

// NewBranchResponse never truncates: git lists everything.
func NewBranchResponse(
	branch ResponseBranch, tree pullrequest.Tree, files []pullrequest.ChangedFile, fetchedAt time.Time,
) BranchResponse {
	assert(!fetchedAt.IsZero(), "fetch time is set")
	assert(!tree.Truncated(), "local trees are complete")
	branch.ChangedFiles = int64(len(files))
	return BranchResponse{
		Version:   WireFormatVersion,
		Branch:    branch,
		Tree:      Build(tree, files),
		FetchedAt: fetchedAt.UTC().Truncate(time.Second).Format(time.RFC3339),
	}
}

// Marshal encodes the response as JSON.
func Marshal(response Response) []byte {
	assert(response.Version == WireFormatVersion, "response comes from NewResponse")
	assert(len(response.Tree.Names) >= 1, "tree has a root")
	return encode(response)
}

func MarshalBranch(response BranchResponse) []byte {
	assert(response.Version == WireFormatVersion, "response comes from NewBranchResponse")
	assert(len(response.Tree.Names) >= 1, "tree has a root")
	return encode(response)
}

// encode requests HTML escaping explicitly so the body stays inert if
// anything ever renders it as HTML.
func encode(response any) []byte {
	buffer := bytes.Buffer{}
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(true)
	err := encoder.Encode(response)
	assert(err == nil, "response types always encode")
	return buffer.Bytes()
}
