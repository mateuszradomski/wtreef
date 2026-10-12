package main

import (
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strings"
	"time"

	"wtreef/internal/cache"
	"wtreef/internal/github"
	"wtreef/internal/server"
)

const (
	defaultListenAddress     = "127.0.0.1:8080"
	defaultCacheBytesMax     = 2 << 30
	cacheBytesMaxMin         = 1 << 20
	defaultGitHubConcurrency = 16
	githubConcurrencyMax     = 64
	githubRequestTimeout     = 30 * time.Second
	responseCacheEntriesMax  = 512
	responseCacheBytesMax    = 256 << 20
	responseCacheTimeToLive  = 60 * time.Second
	apiRequestsPerMinute     = 30
	apiBurst                 = 10
	rateLimitedClientsMax    = 16384
	connectionsMax           = 1024
)

type options struct {
	listenAddress     string
	cacheDirectory    string
	cacheBytesMax     int64
	webDirectory      string
	clientIPHeader    string
	githubConcurrency int
	token             string
}

// runServe runs the website: the API fetches pull requests from GitHub.
func runServe(arguments []string, token string) int {
	parsed, err := parseOptions(arguments, token)
	if errors.Is(err, flag.ErrHelp) {
		return 0
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "wtreef:", err)
		return 2
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	handler, err := newHandler(parsed, logger)
	if err != nil {
		logger.Error("startup failed", "error", err)
		return 1
	}
	return serve(parsed, handler, logger)
}

func parseOptions(arguments []string, token string) (options, error) {
	flags := flag.NewFlagSet("wtreef serve", flag.ContinueOnError)
	parsed := options{token: token}
	flags.StringVar(&parsed.listenAddress, "listen", defaultListenAddress, "address to listen on")
	flags.StringVar(&parsed.cacheDirectory, "cache-dir", "", "directory for the on-disk tree cache (required)")
	flags.Int64Var(&parsed.cacheBytesMax, "cache-bytes-max", defaultCacheBytesMax, "size bound of the tree cache in bytes")
	flags.StringVar(&parsed.webDirectory, "web-dir", "", "serve the frontend from this directory instead of the embedded build")
	flags.StringVar(&parsed.clientIPHeader, "client-ip-header", "", "trusted proxy header holding the client IP, e.g. CF-Connecting-IP")
	flags.IntVar(&parsed.githubConcurrency, "github-concurrency", defaultGitHubConcurrency, "maximum concurrent requests to GitHub")
	if err := flags.Parse(arguments); err != nil {
		return options{}, err
	}
	if flags.NArg() != 0 {
		return options{}, fmt.Errorf("unexpected arguments: %v", flags.Args())
	}
	return parsed, validateOptions(parsed)
}

func validateOptions(parsed options) error {
	if parsed.token == "" {
		return errors.New("GITHUB_TOKEN is required, e.g. GITHUB_TOKEN=$(gh auth token) wtreef serve ...")
	}
	if strings.ContainsFunc(parsed.token, isInvalidTokenCharacter) {
		return errors.New("GITHUB_TOKEN contains whitespace or control characters")
	}
	if parsed.listenAddress == "" {
		return errors.New("-listen must not be empty")
	}
	if parsed.cacheDirectory == "" {
		return errors.New("-cache-dir is required")
	}
	if parsed.cacheBytesMax < cacheBytesMaxMin {
		return fmt.Errorf("-cache-bytes-max must be at least %d", cacheBytesMaxMin)
	}
	if parsed.githubConcurrency < 1 || parsed.githubConcurrency > githubConcurrencyMax {
		return fmt.Errorf("-github-concurrency must be between 1 and %d", githubConcurrencyMax)
	}
	if strings.ContainsFunc(parsed.clientIPHeader, isInvalidHeaderNameCharacter) {
		return errors.New("-client-ip-header must be a header name of [A-Za-z0-9-]")
	}
	return nil
}

func isInvalidTokenCharacter(character rune) bool {
	return character <= ' ' || character == 0x7f
}

func isInvalidHeaderNameCharacter(character rune) bool {
	isLetter := (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')
	isDigit := character >= '0' && character <= '9'
	return !isLetter && !isDigit && character != '-'
}

func newHandler(parsed options, logger *slog.Logger) (*server.Server, error) {
	assets, err := openAssets(parsed.webDirectory)
	if err != nil {
		return nil, err
	}
	trees, err := cache.OpenTreeStore(parsed.cacheDirectory, parsed.cacheBytesMax, logger)
	if err != nil {
		return nil, fmt.Errorf("opening tree cache: %w", err)
	}
	githubClient := github.NewClient(github.Config{
		Token:          parsed.token,
		GraphQLURL:     github.DefaultGraphQLURL,
		RESTBaseURL:    github.DefaultRESTBaseURL,
		ConcurrencyMax: parsed.githubConcurrency,
		RequestTimeout: githubRequestTimeout,
		Logger:         logger,
	})
	return server.New(server.Config{
		GitHub:         githubClient,
		Trees:          trees,
		Responses:      cache.NewResponseCache(responseCacheEntriesMax, responseCacheBytesMax, responseCacheTimeToLive),
		Assets:         assets,
		ReloadAssets:   parsed.webDirectory != "",
		ClientIPHeader: parsed.clientIPHeader,
		Limits: server.RateLimits{
			RequestsPerMinute: apiRequestsPerMinute,
			Burst:             apiBurst,
			ClientsMax:        rateLimitedClientsMax,
		},
		Logger: logger,
	})
}

func serve(parsed options, handler *server.Server, logger *slog.Logger) int {
	listener, err := net.Listen("tcp", parsed.listenAddress)
	if err != nil {
		logger.Error("listen failed", "address", parsed.listenAddress, "error", err)
		return 1
	}
	logger.Info("listening", "address", listener.Addr().String(), "web_dir", parsed.webDirectory,
		"cache_dir", parsed.cacheDirectory, "github_concurrency", parsed.githubConcurrency)
	return serveUntilSignal(listener, handler, connectionsMax, logger)
}
