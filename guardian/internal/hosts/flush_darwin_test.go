package hosts

import (
	"context"
	"errors"
	"slices"
	"testing"
)

func TestFlushDarwinRunsBothCommands(t *testing.T) {
	var calls [][]string
	run := func(_ context.Context, path string, args ...string) ([]byte, error) {
		calls = append(calls, append([]string{path}, args...))
		if path == "/usr/bin/dscacheutil" {
			return []byte("boom"), errors.New("exit status 1")
		}
		return nil, nil
	}
	err := flushDNS(context.Background(), run)
	if err == nil {
		t.Fatal("the dscacheutil failure was not reported")
	}
	want := [][]string{
		{"/usr/bin/dscacheutil", "-flushcache"},
		{"/usr/bin/killall", "-HUP", "mDNSResponder"},
	}
	if !slices.EqualFunc(calls, want, slices.Equal) {
		t.Fatalf("calls = %q, want %q", calls, want)
	}
}
