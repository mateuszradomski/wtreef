package main

import (
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
