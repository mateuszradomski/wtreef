# Wire format and HTTP contract

This is the contract between the Go server and the browser client. Both sides
assert the invariants listed here; a violation is a bug, not a recoverable error.

## Routes

| Route                                   | Response                                   |
|-----------------------------------------|--------------------------------------------|
| `GET /`                                 | `index.html` (landing page)                |
| `GET /{owner}/{repo}/pull/{number}`     | `index.html` (treemap view)                |
| `GET /{owner}/{repo}/pull/{number}/...` | same as above; GitHub sub-tabs (`/files`, `/commits`) are accepted so a pasted URL always works |
| `GET /assets/{name}`                    | files from `web/dist` except `index.html`  |
| `GET /api/pr/{owner}/{repo}/{number}`   | JSON, see below                            |
| `GET /healthz`                          | `200 ok`                                   |
| anything else                           | `404`                                      |

`index.html` references assets as `/assets/app.js?v={{VERSION}}` and
`/assets/style.css?v={{VERSION}}`. The server replaces every `{{VERSION}}` at
startup with a short content hash of the assets, so assets are served with
`Cache-Control: public, max-age=31536000, immutable` and `index.html` with
`Cache-Control: no-cache`.

Content-Security-Policy is strict (`script-src 'self'; style-src 'self'`).
The client must never use inline `<script>`, inline `style="..."` attributes,
or `setAttribute("style", ...)`. Setting `element.style.foo` (CSSOM) is fine.

### Path parsing

- `owner`: 1–39 chars, `[A-Za-z0-9-]`, must not start or end with `-`.
- `repo`: 1–100 chars, `[A-Za-z0-9._-]`, must not be `.` or `..`.
- `number`: decimal, no sign, no leading zero, `1 ≤ n ≤ 2147483647`.

Anything else is `400 bad_request` on the API and `404` on page routes.

## `GET /api/pr/{owner}/{repo}/{number}`

### 200 response

```jsonc
{
  "version": 1,
  "pullRequest": {
    "owner": "l2beat",              // canonical casing as returned by GitHub
    "repo": "l2beat",
    "number": 13157,
    "title": "Blobs page: ...",
    "url": "https://github.com/l2beat/l2beat/pull/13157",
    "author": "someone",            // "" when the account was deleted
    "state": "open",                // "open" | "closed" | "merged"
    "baseRef": "main",
    "headRef": "blobs-page",
    "baseSha": "9da73dfae06746bd429870df0e9ac7099ae248a0",
    "headSha": "81f6d0e53bf3b57632075b9e37590b3b37e50be3",
    "additions": 10859,
    "deletions": 109,
    "changedFiles": 95
  },
  "tree": {
    "names":      ["", "packages", "frontend", "index.ts", ...],
    "parents":    [-1, 0, 1, 2, ...],
    "kinds":      [0, 0, 0, 1, ...],
    "statuses":   [0, 0, 0, 2, ...],
    "bytes":      [0, 0, 0, 1820, ...],
    "additions":  [0, 0, 0, 40, ...],
    "deletions":  [0, 0, 0, 3, ...],
    "fileCounts": [0, 0, 0, 1, ...]
  },
  "truncated": {
    "files": false,   // GitHub returned fewer changed files than changedFiles
    "tree": false     // GitHub truncated the recursive tree; context is partial
  },
  "fetchedAt": "2026-10-12T13:00:00Z"
}
```

### The tree

Nodes are stored as parallel arrays (struct of arrays). All eight arrays have
the same length `N ≥ 1`. Node `i` is described by the `i`-th element of each.

**Kinds**

| kind | name                 | meaning                                                         |
|------|----------------------|-----------------------------------------------------------------|
| 0    | directory            | expanded directory: it contains at least one changed file (root excepted) |
| 1    | file                 | a single file, changed or unchanged                             |
| 2    | collapsed directory  | an unchanged directory shown as a single leaf                   |
| 3    | rest                 | aggregate of the remaining unchanged entries of its parent      |

**Statuses**: `0` unchanged, `1` added, `2` modified, `3` deleted, `4` renamed.
GitHub's `COPIED` maps to `1`, `CHANGED` (mode change) maps to `2`.

**Invariants**

- Node 0 is the root: `names[0] == ""`, `parents[0] == -1`, `kinds[0] == 0`.
- For `i ≥ 1`: `0 ≤ parents[i] < i`, and `kinds[parents[i]] == 0`.
  Parents always come first, so a single reverse pass aggregates leaf values
  into directories with no recursion.
- Directories (kind 0) carry no values: `bytes`, `additions`, `deletions`,
  `fileCounts`, `statuses` are all `0`. The client aggregates.
- Files (kind 1): `fileCounts == 1`. `statuses` in `0..4`. Unchanged files have
  `additions == deletions == 0`.
- Collapsed directories (kind 2) and rest nodes (kind 3): `statuses == 0`,
  `additions == deletions == 0`, `fileCounts ≥ 1`, `bytes` is the sum of the
  files they represent.
- Rest nodes have `names == ""`. At most one rest node per directory.
- Every other node has a non-empty name without `/`, unique among its siblings.
- `bytes` of a file is its blob size in the head commit. It is `0` for deleted
  files, submodules, and changed files missing from a truncated tree.
- The full path of a node is its ancestors' names joined with `/`, excluding
  the root. Rest nodes have no path.

**Pruning** (server side, deterministic)

1. Every changed file becomes a file node; all of its ancestors become
   expanded directories.
2. Each expanded directory additionally gets up to 32 of its unchanged
   children (files as kind 1, subdirectories as kind 2), chosen by largest
   `bytes`, ties broken by name ascending.
3. Remaining unchanged children of that directory, if any, are merged into one
   rest node.

So the node count is bounded by `changedFiles + expandedDirectories × 34`.

### Error responses

All errors are JSON: `{ "error": "<code>", "message": "<human readable>" }`.

| status | code                  | when                                                         |
|--------|-----------------------|--------------------------------------------------------------|
| 400    | `bad_request`         | path does not parse                                          |
| 404    | `not_found`           | repo or PR does not exist, **or the repo is private**        |
| 429    | `too_many_requests`   | per-client rate limit hit; `Retry-After` header is set       |
| 502    | `upstream_error`      | GitHub failed or returned something unexpected               |
| 503    | `github_rate_limited` | the server's GitHub token is out of budget; `Retry-After` set |
