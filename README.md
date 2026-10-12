# wtreef

See where a pull request changes a codebase. Replace `github.com` with
`wtreef.com` in a PR URL:

    https://github.com/l2beat/l2beat/pull/13157
    https://wtreef.com/l2beat/l2beat/pull/13157

and get a treemap of the repository with the changed files highlighted.

## Architecture

- **Server** (`cmd/`, `internal/`): one Go binary, standard library only.
  Fetches PR metadata and changed files (GitHub GraphQL) and the head commit's
  tree (GitHub REST), prunes the tree around the changes, and serves it as
  compact JSON. Trees are keyed by commit SHA and cached on disk forever
  (size-bounded). Concurrent identical requests are coalesced.
- **Client** (`web/`): plain TypeScript, no runtime dependencies. Squarified
  treemap drawn on a canvas; controls and the file list are DOM.
- **Contract**: [`docs/wire-format.md`](docs/wire-format.md).

## Develop

    npm ci            # build-time tools only (esbuild, tsc)
    make dev          # http://127.0.0.1:8080, uses `gh auth token`
    make test check

## Build for the box

    make linux        # bin/wtreef-linux-amd64
