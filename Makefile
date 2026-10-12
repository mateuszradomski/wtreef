# Frontend is bundled by esbuild into web/dist, which the Go binary embeds.
# Build order matters: `server` needs `web` output to embed real assets.

GO_LDFLAGS := -s -w

.PHONY: build web server linux test check dev clean

build: web server

web:
	npx esbuild web/src/main.ts --bundle --minify --sourcemap --target=es2022 --outfile=web/dist/app.js
	cp web/static/* web/dist/

server:
	go build -trimpath -o bin/wtreef ./cmd/wtreef

# The server runs linux/amd64; ship a static binary.
linux: web
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags='$(GO_LDFLAGS)' -o bin/wtreef-linux-amd64 ./cmd/wtreef

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
	GITHUB_TOKEN=$$(gh auth token) go run ./cmd/wtreef -listen 127.0.0.1:8080 -web-dir web/dist -cache-dir /tmp/wtreef-cache

clean:
	rm -rf bin web/dist/*.js web/dist/*.map web/dist/*.css web/dist/*.html web/dist/*.svg
