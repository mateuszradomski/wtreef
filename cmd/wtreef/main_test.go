package main

import (
	"io"
	"net"
	"strings"
	"testing"
)

func TestParseOptionsDefaults(t *testing.T) {
	parsed, err := parseOptions([]string{"-cache-dir", "/tmp/x"}, "ghp_token")
	if err != nil {
		t.Fatal(err)
	}
	if parsed.listenAddress != "127.0.0.1:8080" || parsed.cacheBytesMax != 2<<30 || parsed.githubConcurrency != 16 ||
		parsed.webDirectory != "" || parsed.clientIPHeader != "" {
		t.Fatalf("defaults = %+v", parsed)
	}
}

func TestParseOptionsRejectsInvalidConfiguration(t *testing.T) {
	testCases := map[string]struct {
		arguments []string
		token     string
		message   string
	}{
		"missing token":       {[]string{"-cache-dir", "/tmp/x"}, "", "GITHUB_TOKEN is required"},
		"token with newline":  {[]string{"-cache-dir", "/tmp/x"}, "ghp_a\n", "whitespace"},
		"missing cache dir":   {nil, "t", "-cache-dir is required"},
		"tiny cache":          {[]string{"-cache-dir", "/tmp/x", "-cache-bytes-max", "10"}, "t", "-cache-bytes-max"},
		"zero concurrency":    {[]string{"-cache-dir", "/tmp/x", "-github-concurrency", "0"}, "t", "-github-concurrency"},
		"huge concurrency":    {[]string{"-cache-dir", "/tmp/x", "-github-concurrency", "1000"}, "t", "-github-concurrency"},
		"bad header name":     {[]string{"-cache-dir", "/tmp/x", "-client-ip-header", "X Forwarded"}, "t", "-client-ip-header"},
		"positional argument": {[]string{"-cache-dir", "/tmp/x", "extra"}, "t", "unexpected arguments"},
	}
	for name, testCase := range testCases {
		t.Run(name, func(t *testing.T) {
			_, err := parseOptions(testCase.arguments, testCase.token)
			if err == nil || !strings.Contains(err.Error(), testCase.message) {
				t.Fatalf("error = %v, want it to mention %q", err, testCase.message)
			}
		})
	}
}

func TestParseLocalOptions(t *testing.T) {
	parsed, err := parseLocalOptions(nil, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.listenAddress != "127.0.0.1:3753" || parsed.listenExplicit || parsed.directory != "." || !parsed.open || parsed.base != "" {
		t.Fatalf("defaults = %+v", parsed)
	}
	parsed, err = parseLocalOptions([]string{"-listen", "127.0.0.1:4000", "-base", "origin/develop", "-open=false", "../repo"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.listenAddress != "127.0.0.1:4000" || !parsed.listenExplicit || parsed.directory != "../repo" || parsed.open || parsed.base != "origin/develop" {
		t.Fatalf("parsed = %+v", parsed)
	}
	if _, err := parseLocalOptions([]string{"a", "b"}, io.Discard); err == nil || !strings.Contains(err.Error(), "at most one directory") {
		t.Fatalf("two directories: error = %v", err)
	}
}

func TestLocalAddresses(t *testing.T) {
	testCases := []struct {
		address string
		url     string
		hosts   string
	}{
		{"127.0.0.1:3753", "http://localhost:3753/", "localhost 127.0.0.1 ::1"},
		{"[::1]:3753", "http://localhost:3753/", "localhost 127.0.0.1 ::1"},
		{"0.0.0.0:3753", "http://localhost:3753/", ""},
		{"192.168.1.5:3753", "http://192.168.1.5:3753/", "192.168.1.5 localhost 127.0.0.1 ::1"},
	}
	for _, testCase := range testCases {
		address, err := net.ResolveTCPAddr("tcp", testCase.address)
		if err != nil {
			t.Fatal(err)
		}
		if url := pageURL(address); url != testCase.url {
			t.Errorf("pageURL(%s) = %s, want %s", testCase.address, url, testCase.url)
		}
		if hosts := strings.Join(allowedHosts(address), " "); hosts != testCase.hosts {
			t.Errorf("allowedHosts(%s) = %q, want %q", testCase.address, hosts, testCase.hosts)
		}
	}
}
