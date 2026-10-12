package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io/fs"
	"maps"
	"net/http"
	"path"
	"slices"
	"strings"
)

const (
	indexName          = "index.html"
	versionPlaceholder = "{{VERSION}}"
	versionHexLength   = 12
	assetFilesMax      = 256
	assetBytesMax      = 64 << 20
	// Below this size gzip framing overhead outweighs the savings.
	assetGzipBytesMin = 1024
	assetCacheControl = "public, max-age=31536000, immutable"
	pageCacheControl  = "no-cache"
)

var ErrIndexMissing = errors.New("assets lack index.html; build the frontend with `make web`")

// assetSnapshot is the whole frontend, read once and served from memory.
type assetSnapshot struct {
	indexHTML []byte
	files     map[string]asset
	version   string
}

type asset struct {
	content []byte
	// gzipContent is nil when compression would not shrink the file.
	gzipContent []byte
	contentType string
}

// contentTypeByExtension is explicit because mime.TypeByExtension consults
// the host's mime tables, which differ between machines.
var contentTypeByExtension = map[string]string{
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".map":   "application/json; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".html":  "text/html; charset=utf-8",
	".txt":   "text/plain; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".ico":   "image/x-icon",
	".webp":  "image/webp",
	".woff2": "font/woff2",
}

var compressibleExtensions = []string{".js", ".mjs", ".css", ".map", ".json", ".html", ".txt", ".svg"}

func (server *Server) servePage(writer http.ResponseWriter) {
	if server.reloadAssets {
		server.reloadAssetSnapshot()
	}
	snapshot := server.assets.Load()
	writer.Header().Set("Content-Type", "text/html; charset=utf-8")
	writer.Header().Set("Cache-Control", pageCacheControl)
	writeBody(writer, http.StatusOK, snapshot.indexHTML)
}

// serveAsset looks names up in the snapshot map only, so a request can
// never reach the file system or traverse out of the asset directory.
func (server *Server) serveAsset(writer http.ResponseWriter, request *http.Request, name string) {
	snapshot := server.assets.Load()
	file, exists := snapshot.files[name]
	if !exists {
		serveNotFound(writer, false)
		return
	}
	writer.Header().Set("Content-Type", file.contentType)
	writer.Header().Set("Cache-Control", assetCacheControl)
	body := file.content
	if file.gzipContent != nil {
		writer.Header().Set("Vary", "Accept-Encoding")
		if acceptsGzip(request.Header.Values("Accept-Encoding")) {
			writer.Header().Set("Content-Encoding", "gzip")
			body = file.gzipContent
		}
	}
	writeBody(writer, http.StatusOK, body)
}

// reloadAssetSnapshot keeps serving the previous snapshot when the new one
// cannot be read, e.g. halfway through a frontend rebuild.
func (server *Server) reloadAssetSnapshot() {
	snapshot, err := loadAssetSnapshot(server.assetFiles)
	if err != nil {
		server.logger.Warn("asset reload failed, serving previous assets", "error", err)
		return
	}
	server.assets.Store(snapshot)
}

// loadAssetSnapshot reads the top level of files. Dotfiles, directories,
// and symlinks are skipped.
func loadAssetSnapshot(files fs.FS) (*assetSnapshot, error) {
	entries, err := fs.ReadDir(files, ".")
	if err != nil {
		return nil, err
	}
	if len(entries) > assetFilesMax {
		return nil, errors.New("asset directory has too many entries")
	}
	snapshot := &assetSnapshot{files: make(map[string]asset, len(entries))}
	var indexTemplate []byte
	bytesTotal := int64(0)
	for _, entry := range entries {
		name := entry.Name()
		if !entry.Type().IsRegular() || strings.HasPrefix(name, ".") {
			continue
		}
		content, err := readAsset(files, entry, assetBytesMax-bytesTotal)
		if err != nil {
			return nil, err
		}
		bytesTotal += int64(len(content))
		if name == indexName {
			indexTemplate = content
			continue
		}
		snapshot.files[name] = newAsset(name, content)
	}
	if indexTemplate == nil {
		return nil, ErrIndexMissing
	}
	snapshot.version = assetVersion(snapshot.files)
	snapshot.indexHTML = bytes.ReplaceAll(indexTemplate, []byte(versionPlaceholder), []byte(snapshot.version))
	assert(len(snapshot.version) == versionHexLength, "version is a short hash")
	assert(!bytes.Contains(snapshot.indexHTML, []byte(versionPlaceholder)), "every placeholder is replaced")
	return snapshot, nil
}

func readAsset(files fs.FS, entry fs.DirEntry, bytesRemaining int64) ([]byte, error) {
	info, err := entry.Info()
	if err != nil {
		return nil, err
	}
	if info.Size() > bytesRemaining {
		return nil, errors.New("assets exceed the size limit")
	}
	content, err := fs.ReadFile(files, entry.Name())
	if err != nil {
		return nil, err
	}
	if int64(len(content)) > bytesRemaining {
		return nil, errors.New("assets exceed the size limit")
	}
	return content, nil
}

func newAsset(name string, content []byte) asset {
	extension := path.Ext(name)
	contentType, known := contentTypeByExtension[extension]
	if !known {
		contentType = "application/octet-stream"
	}
	result := asset{content: content, contentType: contentType}
	if slices.Contains(compressibleExtensions, extension) && len(content) >= assetGzipBytesMin {
		compressed := compress(content)
		if len(compressed) < len(content) {
			result.gzipContent = compressed
		}
	}
	return result
}

// assetVersion hashes names and contents in name order; lengths are
// included so no two different asset sets can produce the same stream.
func assetVersion(files map[string]asset) string {
	hash := sha256.New()
	lengthBytes := make([]byte, 8)
	for _, name := range slices.Sorted(maps.Keys(files)) {
		content := files[name].content
		binary.BigEndian.PutUint64(lengthBytes, uint64(len(name)))
		hash.Write(lengthBytes)
		hash.Write([]byte(name))
		binary.BigEndian.PutUint64(lengthBytes, uint64(len(content)))
		hash.Write(lengthBytes)
		hash.Write(content)
	}
	return hex.EncodeToString(hash.Sum(nil))[:versionHexLength]
}
