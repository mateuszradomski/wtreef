// Command wtreef draws a treemap of a repository with the changes lit up.
// With no subcommand it shows the current branch of a local checkout;
// `wtreef serve` runs the website, which shows GitHub pull requests.
package main

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"wtreef/internal/server"
	"wtreef/web"
)

const shutdownTimeout = 20 * time.Second

const usage = `Usage:
  wtreef [flags] [directory]   show the checkout's current branch against its base (default: .)
  wtreef serve [flags]         run the website, which shows GitHub pull requests

Run 'wtreef -h' or 'wtreef serve -h' for the flags of each.
`

func main() {
	arguments := os.Args[1:]
	if len(arguments) > 0 && arguments[0] == "serve" {
		os.Exit(runServe(arguments[1:], os.Getenv("GITHUB_TOKEN")))
	}
	os.Exit(runLocal(arguments))
}

// openAssets uses os.Root for -web-dir so a symlink in the directory cannot
// lead outside it. The root stays open for the life of the process.
func openAssets(webDirectory string) (fs.FS, error) {
	if webDirectory == "" {
		return fs.Sub(web.Dist, "dist")
	}
	root, err := os.OpenRoot(webDirectory)
	if err != nil {
		return nil, fmt.Errorf("opening -web-dir: %w", err)
	}
	return root.FS(), nil
}

// serveUntilSignal serves until SIGINT or SIGTERM, then drains requests.
func serveUntilSignal(listener net.Listener, handler http.Handler, connectionsMax int, logger *slog.Logger) int {
	httpServer := server.NewHTTPServer(handler, logger)
	signalContext, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- httpServer.Serve(server.LimitListener(listener, connectionsMax)) }()
	select {
	case err := <-serveErrors:
		logger.Error("server stopped", "error", err)
		return 1
	case <-signalContext.Done():
	}
	logger.Info("shutting down", "timeout", shutdownTimeout.String())
	shutdownContext, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := httpServer.Shutdown(shutdownContext); err != nil {
		logger.Error("shutdown incomplete", "error", err)
		return 1
	}
	return 0
}
