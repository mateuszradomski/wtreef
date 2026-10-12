# wtreef

See where a change lands in a codebase: a treemap of the repository with the
changed files highlighted. Two ways to use it:

**Your branch, locally.** In any git checkout:

    npx wtreef@latest

opens http://localhost:3753 with your current branch: everything since it
left the default branch (`origin/HEAD`), uncommitted and untracked files
included. Reload the page to see new edits. Needs `git`; nothing leaves your
machine. `npx wtreef -h` lists the flags (`-base`, `-listen`, `-open`).

**A pull request, on the web.** Replace `github.com` with `wtreef.com` in a
PR URL:

    https://github.com/l2beat/l2beat/pull/13157
    https://wtreef.com/l2beat/l2beat/pull/13157

## Architecture

- **Server** (`cmd/`, `internal/`): one Go binary, standard library only.
  - `wtreef [directory]` (local): reads the branch with `git`
    (`internal/localgit`) on every page load and serves it on 127.0.0.1.
  - `wtreef serve` (website): fetches PR metadata and changed files (GitHub
    GraphQL) and the head commit's tree (GitHub REST). Trees are keyed by
    commit SHA and cached on disk forever (size-bounded). Concurrent
    identical requests are coalesced.

  Both prune the tree around the changes (`internal/prune`) and serve it as
  compact JSON.
- **Client** (`web/`): plain TypeScript, no runtime dependencies. Squarified
  treemap drawn on a canvas; controls and the file list are DOM. The server
  tells the page which mode it is in through `<meta name="wtreef-mode">`.
- **Contract**: [`docs/wire-format.md`](docs/wire-format.md).
- **npm package** (`npm/`): a launcher plus one optional package per
  platform holding the prebuilt binary, as esbuild does it. npm skips an
  optional package it cannot fetch, so the launcher downloads a missing one
  from the registry and checks it against the SHA-256 recorded at build time.

## Develop

    npm ci            # build-time tools only (esbuild, tsc)
    make dev          # website on http://127.0.0.1:8080, uses `gh auth token`
    make dev-local    # this checkout on http://localhost:3753
    make test check

## Build for the box

    make linux        # bin/wtreef-linux-amd64

## Publish to npm

    make npm VERSION=0.1.0     # stages bin/npm/*: wtreef and @wtreef/<platform>
    make npm-publish           # platform packages first, then wtreef

Publish exactly what one `make npm` staged: wtreef's checksums.json pins the
platform binaries of that build, and a rebuild differs (Go embeds the commit).
