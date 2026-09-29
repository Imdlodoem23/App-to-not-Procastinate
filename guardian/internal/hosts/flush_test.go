package hosts

import (
	"bytes"
	"context"
	"log/slog"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestWithTimeoutBoundsEachCommand(t *testing.T) {
	var deadlines []time.Duration
	run := withTimeout(func(ctx context.Context, path string, args ...string) ([]byte, error) {
		d, ok := ctx.Deadline()
		if !ok {
			t.Fatal("no deadline")
		}
		deadlines = append(deadlines, time.Until(d))
		return nil, nil
	})
	for range 2 {
		if _, err := run(context.Background(), "/bin/true"); err != nil {
			t.Fatal(err)
		}
	}
	for _, d := range deadlines {
		if d <= 0 || d > FlushTimeout {
			t.Fatalf("deadline in %v, want within %v", d, FlushTimeout)
		}
	}
}

func TestCapBuffer(t *testing.T) {
	var b capBuffer
	chunk := bytes.Repeat([]byte("x"), 1000)
	for range 10 {
		if n, err := b.Write(chunk); n != len(chunk) || err != nil {
			t.Fatalf("Write = %d, %v", n, err)
		}
	}
	if len(b.Bytes()) != maxCmdOutput {
		t.Fatalf("kept %d bytes, want %d", len(b.Bytes()), maxCmdOutput)
	}
}

func TestCmdErrorTruncatesOutput(t *testing.T) {
	err := cmdError("/usr/bin/tool", []string{"-x"}, bytes.Repeat([]byte("e"), 1000), context.DeadlineExceeded)
	if len(err.Error()) > 300 || !strings.HasPrefix(err.Error(), "tool -x: ") {
		t.Fatalf("error %q", err)
	}
}

func TestNewCommandUsesArgv(t *testing.T) {
	cmd := newCommand(context.Background(), "/fixed/binary", "--flag", "a b;c")
	if !slices.Equal(cmd.Args, []string{"/fixed/binary", "--flag", "a b;c"}) {
		t.Fatalf("Args = %q", cmd.Args)
	}
	if cmd.WaitDelay <= 0 {
		t.Fatal("no WaitDelay")
	}
	if runtime.GOOS != "windows" && !slices.Contains(cmd.Env, "LC_ALL=C") {
		t.Fatal("LC_ALL=C not set")
	}
}

func TestFlushDNSCancelledRunsNothing(t *testing.T) {
	// A cancelled context stops exec before any process starts, so this runs
	// no system command; it checks FlushDNS returns promptly and only logs.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var log bytes.Buffer
	start := time.Now()
	err := FlushDNS(ctx, slog.New(slog.NewTextHandler(&log, nil)))
	if time.Since(start) > 2*time.Second {
		t.Fatal("FlushDNS did not return promptly")
	}
	if err != nil && !strings.Contains(log.String(), "DNS cache flush failed") {
		t.Fatalf("error %v not logged: %q", err, log.String())
	}
}

func TestManagerFlushDNSUsesHook(t *testing.T) {
	m := &Manager{Path: "/unused"}
	called := false
	m.flush = func(context.Context) error { called = true; return nil }
	if err := m.FlushDNS(context.Background()); err != nil || !called {
		t.Fatalf("FlushDNS = %v, called %v", err, called)
	}
}
