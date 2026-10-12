# wtreef

See where your branch lands: a treemap of the repository with the changed
files lit up.

```sh
npx wtreef@latest
```

Run it in any git checkout. It opens http://localhost:3753 with everything
your branch changed since it left the default branch: commits, staged and
unstaged edits, untracked files. Reload the page to see new edits. Nothing
leaves your machine.

![A branch of l2beat in wtreef: a treemap of the repository with the changed files colored by added and deleted lines](https://raw.githubusercontent.com/mateuszradomski/wtreef/main/docs/screenshot.png)

## The map

Each file is a tile inside its folders. Color is added versus deleted lines;
brightness is how many. Tile size is one of:

- **Churn**: lines added and removed. Where the branch does the most work.
- **Context**: file size, unchanged files included. The changes in proportion
  to the code around them.

Click a folder to zoom in, `Esc` to zoom out. `/` filters paths by regex.
`H` hides the file or folder under the cursor. Right-click for more.

## Flags

```
npx wtreef@latest [flags] [directory]

-base REF      compare against REF (default: origin/HEAD, then origin/main,
               origin/master, main, master)
-listen ADDR   address to serve on (default 127.0.0.1:3753; if the port is
               taken, another is picked)
-open=false    don't open the browser
```

Needs `git` and Node 18+. The binary itself is native: Linux, macOS and
Windows, x64 and arm64.

## Pull requests

The same binary can serve GitHub pull requests as a website. Host it
yourself:

```sh
GITHUB_TOKEN=$(gh auth token) npx wtreef@latest serve -cache-dir /var/cache/wtreef
```

Then open `/owner/repo/pull/123` on it. It shows public repositories only;
a fine-grained token with read access to public repositories is enough.
`npx wtreef@latest serve -h` lists the flags.

## Contributing

- **Server** (`cmd/`, `internal/`): one Go binary, standard library only.
  Local mode reads the branch with `git` on every page load. `wtreef serve`
  runs the website: pull request metadata and changed files from GitHub
  GraphQL, the head commit's tree from GitHub REST, trees cached on disk by
  commit SHA. Both prune the tree around the changes (`internal/prune`) and
  serve it as compact JSON ([`docs/wire-format.md`](docs/wire-format.md)).
- **Client** (`web/`): plain TypeScript, no runtime dependencies. A squarified
  treemap on a canvas; the rest is DOM.
- **npm** (`npm/`): a launcher plus one optional package per platform holding
  the binary, as esbuild does it.

```sh
npm ci            # build-time tools only (esbuild, tsc)
make dev          # website on http://127.0.0.1:8080, uses `gh auth token`
make dev-local    # this checkout on http://localhost:3753
make test check
```

To release, `make npm VERSION=x.y.z` stages the packages in `bin/npm` and
`make npm-publish` publishes them. Publish exactly what one `make npm`
staged: wtreef's `checksums.json` pins that build's binaries.

## License

MIT
