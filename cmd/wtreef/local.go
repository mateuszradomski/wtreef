package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"time"

	"wtreef/internal/localgit"
	"wtreef/internal/server"
)

const (
	defaultLocalListenAddress = "127.0.0.1:3753"
	// fallbackLocalListenAddress lets the OS pick a port when the default
	// one is taken, e.g. by wtreef running for another checkout.
	fallbackLocalListenAddress = "127.0.0.1:0"
	localConnectionsMax        = 64
	startupTimeout             = 60 * time.Second
)

// loopbackHosts are the names a browser on this machine uses for us.
var loopbackHosts = []string{"localhost", "127.0.0.1", "::1"}

type localOptions struct {
	listenAddress string
	// listenExplicit is set when -listen was given; then a taken port is
	// an error instead of a reason to pick another.
	listenExplicit bool
	directory      string
	base           string
	open           bool
	webDirectory   string
}

// runLocal shows the current branch of the checkout in a browser.
func runLocal(arguments []string) int {
	parsed, err := parseLocalOptions(arguments, os.Stderr)
	if errors.Is(err, flag.ErrHelp) {
		return 0
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "wtreef:", err)
		return 2
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	startupContext, cancel := context.WithTimeout(context.Background(), startupTimeout)
	defer cancel()
	repository, err := localgit.Open(startupContext, parsed.directory, parsed.base)
	if err != nil {
		fmt.Fprintln(os.Stderr, "wtreef:", err)
		return 1
	}
	// Read once up front so a missing base branch is reported here, in the
	// terminal, rather than on a page.
	snapshot, err := repository.Snapshot(startupContext)
	if err != nil {
		fmt.Fprintln(os.Stderr, "wtreef:", err)
		return 1
	}
	assets, err := openAssets(parsed.webDirectory)
	if err != nil {
		fmt.Fprintln(os.Stderr, "wtreef:", err)
		return 1
	}
	listener, err := listenLocal(parsed)
	if err != nil {
		fmt.Fprintln(os.Stderr, "wtreef:", err)
		return 1
	}
	handler, err := server.NewLocal(server.LocalConfig{
		Branch:       repository,
		Assets:       assets,
		ReloadAssets: parsed.webDirectory != "",
		AllowedHosts: allowedHosts(listener.Addr()),
		Logger:       logger,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "wtreef:", err)
		return 1
	}
	url := pageURL(listener.Addr())
	fmt.Fprintf(os.Stdout, "wtreef: %s, %s\n  %s\n", describeBranch(snapshot), plural(len(snapshot.Files), "file", "files"), url)
	if parsed.open {
		openBrowser(url)
	}
	return serveUntilSignal(listener, handler, localConnectionsMax, logger)
}

func parseLocalOptions(arguments []string, output io.Writer) (localOptions, error) {
	flags := flag.NewFlagSet("wtreef", flag.ContinueOnError)
	flags.SetOutput(output)
	flags.Usage = func() {
		fmt.Fprint(output, usage, "\nFlags of 'wtreef [flags] [directory]':\n")
		flags.PrintDefaults()
	}
	parsed := localOptions{}
	flags.StringVar(&parsed.listenAddress, "listen", defaultLocalListenAddress, "address to listen on; if the default port is taken, another is picked")
	flags.StringVar(&parsed.base, "base", "", "branch or commit to compare against (default: origin/HEAD, then origin/main, origin/master, main, master)")
	flags.BoolVar(&parsed.open, "open", true, "open the page in the browser")
	flags.StringVar(&parsed.webDirectory, "web-dir", "", "serve the frontend from this directory instead of the embedded build")
	if err := flags.Parse(arguments); err != nil {
		return localOptions{}, err
	}
	flags.Visit(func(defined *flag.Flag) {
		if defined.Name == "listen" {
			parsed.listenExplicit = true
		}
	})
	switch flags.NArg() {
	case 0:
		parsed.directory = "."
	case 1:
		parsed.directory = flags.Arg(0)
	default:
		return localOptions{}, fmt.Errorf("expected at most one directory, got %v", flags.Args())
	}
	if parsed.listenAddress == "" {
		return localOptions{}, errors.New("-listen must not be empty")
	}
	return parsed, nil
}

func listenLocal(parsed localOptions) (net.Listener, error) {
	listener, err := net.Listen("tcp", parsed.listenAddress)
	if err == nil || parsed.listenExplicit {
		return listener, err
	}
	return net.Listen("tcp", fallbackLocalListenAddress)
}

// allowedHosts limits the Host header to loopback names unless the server
// was deliberately exposed on every interface, where any name can be right.
func allowedHosts(address net.Addr) []string {
	tcpAddress, isTCP := address.(*net.TCPAddr)
	if !isTCP {
		return loopbackHosts
	}
	if tcpAddress.IP.IsUnspecified() {
		return nil
	}
	if tcpAddress.IP.IsLoopback() {
		return loopbackHosts
	}
	return append([]string{tcpAddress.IP.String()}, loopbackHosts...)
}

func pageURL(address net.Addr) string {
	tcpAddress, isTCP := address.(*net.TCPAddr)
	if !isTCP {
		return "http://" + address.String() + "/"
	}
	host := "localhost"
	if !tcpAddress.IP.IsLoopback() && !tcpAddress.IP.IsUnspecified() {
		host = tcpAddress.IP.String()
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(tcpAddress.Port)) + "/"
}

func describeBranch(snapshot localgit.Snapshot) string {
	head := snapshot.HeadRef
	if head == "" {
		head = "detached HEAD " + snapshot.HeadSHA[:12]
	}
	description := head + " against " + snapshot.BaseRef
	if snapshot.Uncommitted {
		description += ", with uncommitted changes"
	}
	return description
}

func plural(count int, singular string, pluralForm string) string {
	if count == 1 {
		return "1 " + singular
	}
	return strconv.Itoa(count) + " " + pluralForm
}

// openBrowser is best effort: the URL is printed either way.
func openBrowser(url string) {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("open", url)
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		command = exec.Command("xdg-open", url)
	}
	if err := command.Start(); err != nil {
		return
	}
	go func() { _ = command.Wait() }()
}
