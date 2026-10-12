# Frontend is bundled by esbuild into web/dist, which the Go binary embeds.
# Build order matters: `server` needs `web` output to embed real assets.

GO_LDFLAGS := -s -w
# The GitHub client speaks HTTP/1.1, so leave out net/http's HTTP/2 (~550 KB).
GO_TAGS := nethttpomithttp2

.PHONY: build web server linux npm npm-publish test check dev dev-local clean

build: web server

# The release bundle has no sourcemap; drop any that `make dev` left behind so it is not embedded.
web:
	npx esbuild web/src/main.ts --bundle --minify --target=es2022 --outfile=web/dist/app.js
	rm -f web/dist/app.js.map
	cp web/static/* web/dist/

server:
	go build -trimpath -tags $(GO_TAGS) -ldflags='$(GO_LDFLAGS)' -o bin/wtreef ./cmd/wtreef

# The server runs linux/amd64; ship a static binary.
linux: web
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -tags $(GO_TAGS) -ldflags='$(GO_LDFLAGS)' -o bin/wtreef-linux-amd64 ./cmd/wtreef

# npm packages for `npx wtreef`: see npm/build.mjs. Publishing is manual.
npm: web
	@test -n "$(VERSION)" || (echo "usage: make npm VERSION=x.y.z" >&2; exit 2)
	node npm/build.mjs $(VERSION)

npm-publish:
	for package in bin/npm/*-*; do npm publish --access public "$$package" || exit 1; done
	npm publish bin/npm/wtreef

test:
	go test ./...
	node --test 'web/src/**/*.test.ts'

check:
	gofmt -l . | (! grep .)
	go vet ./...
	npx tsc -p .

# Serves assets from disk so `esbuild --watch` output is picked up without rebuilding Go.
dev: web
	npx esbuild web/src/main.ts --bundle --sourcemap --target=es2022 --outfile=web/dist/app.js --watch=forever &
	GITHUB_TOKEN=$$(gh auth token) go run ./cmd/wtreef serve -listen 127.0.0.1:8080 -web-dir web/dist -cache-dir /tmp/wtreef-cache

# Local mode on this checkout.
dev-local: web
	npx esbuild web/src/main.ts --bundle --sourcemap --target=es2022 --outfile=web/dist/app.js --watch=forever &
	go run ./cmd/wtreef -web-dir web/dist -open=false .

clean:
	rm -rf bin web/dist/*.js web/dist/*.map web/dist/*.css web/dist/*.html web/dist/*.svg
