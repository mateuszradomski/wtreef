package github

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"wtreef/internal/pullrequest"
)

const (
	// treeResponseBytesMax caps the decompressed listing; GitHub truncates
	// recursive trees at 100k entries / 7 MB, so 64 MiB is generous.
	treeResponseBytesMax  = 64 << 20
	treeTopLevelFieldsMax = 16
	treeEntriesCapacity   = 4096
	treeOperationName     = "tree"
)

type treeEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
	// A pointer, so a blob without a size is an error rather than 0 bytes.
	Size *int64 `json:"size"`
}

type treeListing struct {
	truncated bool
	paths     []string
	sizes     []int64
}

// FetchTree lists the blobs and submodules of a commit. Fork heads resolve
// in the base repository because GitHub keeps refs/pull/N/head there.
func (client *Client) FetchTree(
	ctx context.Context, repository pullrequest.Repository, sha pullrequest.CommitSHA,
) (pullrequest.Tree, error) {
	url := client.restBaseURL + "/repos/" + repository.Owner() + "/" + repository.Name() +
		"/git/trees/" + sha.String() + "?recursive=1"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return pullrequest.Tree{}, upstreamError(treeOperationName, "building request: "+err.Error())
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", restAPIVersion)
	response, err := client.send(request)
	if err != nil {
		client.logger.Warn("github request failed", "operation", treeOperationName, "error", err)
		return pullrequest.Tree{}, upstreamError(treeOperationName, "transport: "+err.Error())
	}
	defer client.finish(response)
	if err := client.checkStatus(response, treeOperationName); err != nil {
		return pullrequest.Tree{}, err
	}
	listing, err := decodeTreeListing(io.LimitReader(response.Body, treeResponseBytesMax))
	if err != nil {
		client.logger.Warn("github tree malformed", "repository", repository.String(), "sha", sha.String(), "error", err)
		return pullrequest.Tree{}, upstreamError(treeOperationName, err.Error())
	}
	tree, err := pullrequest.ParseTree(listing.truncated, listing.paths, listing.sizes)
	if err != nil {
		client.logger.Warn("github tree rejected", "repository", repository.String(), "sha", sha.String(), "error", err)
		return pullrequest.Tree{}, upstreamError(treeOperationName, err.Error())
	}
	return tree, nil
}

// decodeTreeListing walks the top-level object token by token so entries are
// decoded one at a time instead of materializing the whole document.
func decodeTreeListing(reader io.Reader) (treeListing, error) {
	decoder := json.NewDecoder(reader)
	if err := expectDelimiter(decoder, '{'); err != nil {
		return treeListing{}, err
	}
	listing := treeListing{}
	sawTree := false
	sawTruncated := false
	for fieldIndex := 0; decoder.More(); fieldIndex++ {
		if fieldIndex == treeTopLevelFieldsMax {
			return treeListing{}, errors.New("tree response has too many fields")
		}
		key, err := decoder.Token()
		if err != nil {
			return treeListing{}, err
		}
		switch key {
		case "tree":
			listing.paths, listing.sizes, err = decodeTreeEntries(decoder)
			sawTree = true
		case "truncated":
			err = decoder.Decode(&listing.truncated)
			sawTruncated = true
		default:
			var skipped json.RawMessage
			err = decoder.Decode(&skipped)
		}
		if err != nil {
			return treeListing{}, err
		}
	}
	if err := expectDelimiter(decoder, '}'); err != nil {
		return treeListing{}, err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return treeListing{}, errors.New("tree response has trailing data")
	}
	if !sawTree || !sawTruncated {
		return treeListing{}, errors.New("tree response lacks tree or truncated")
	}
	return listing, nil
}

func decodeTreeEntries(decoder *json.Decoder) ([]string, []int64, error) {
	if err := expectDelimiter(decoder, '['); err != nil {
		return nil, nil, err
	}
	paths := make([]string, 0, treeEntriesCapacity)
	sizes := make([]int64, 0, treeEntriesCapacity)
	for entryIndex := 0; decoder.More(); entryIndex++ {
		if entryIndex == pullrequest.TreeEntriesMax {
			return nil, nil, errors.New("tree response has too many entries")
		}
		// Declared per iteration: Decode leaves absent fields untouched, so a
		// reused value would leak the previous entry's size.
		var entry treeEntry
		if err := decoder.Decode(&entry); err != nil {
			return nil, nil, err
		}
		size, keep, err := parseTreeEntry(entry)
		if err != nil {
			return nil, nil, err
		}
		if keep {
			paths = append(paths, entry.Path)
			sizes = append(sizes, size)
		}
	}
	if err := expectDelimiter(decoder, ']'); err != nil {
		return nil, nil, err
	}
	assert(len(paths) == len(sizes), "paths and sizes grow together")
	return paths, sizes, nil
}

// parseTreeEntry keeps blobs and submodules (type "commit", size 0).
// Directories are implied by paths, so "tree" entries are dropped.
func parseTreeEntry(entry treeEntry) (int64, bool, error) {
	switch entry.Type {
	case "blob":
		if entry.Size == nil || *entry.Size < 0 {
			return 0, false, errors.New("tree blob lacks a valid size")
		}
		return *entry.Size, true, nil
	case "commit":
		return 0, true, nil
	case "tree":
		return 0, false, nil
	}
	return 0, false, errors.New("tree entry has unknown type")
}

func expectDelimiter(decoder *json.Decoder, expected json.Delim) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != expected {
		return errors.New("tree response has unexpected structure, want " + expected.String())
	}
	return nil
}
