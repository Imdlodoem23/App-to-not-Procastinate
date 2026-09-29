package hosts

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	// FlushTimeout bounds each DNS flush command.
	FlushTimeout = 5 * time.Second
	// maxCmdOutput caps the output kept from a command (for error messages).
	maxCmdOutput = 4 << 10
)

// runFunc runs a fixed binary (absolute path) with fixed arguments and returns
// its combined, truncated output.
type runFunc func(ctx context.Context, path string, args ...string) ([]byte, error)

// FlushDNS flushes the operating system's DNS cache so hosts changes apply at
// once. Every command is a fixed absolute path with fixed arguments (no shell,
// no external data) and gets FlushTimeout:
//
//	Windows  %SystemRoot%\System32\ipconfig.exe /flushdns (no console window)
//	macOS    /usr/bin/dscacheutil -flushcache; /usr/bin/killall -HUP mDNSResponder
//	Linux    resolvectl flush-caches, else systemd-resolve --flush-caches
//
// On Linux a missing binary or a "not found" reply (systemd-resolved not
// installed or not running, so there is no cache to flush) is not an error.
// Failures are logged as warnings and returned for information only: callers
// must never treat them as fatal. A nil logger discards the log.
func FlushDNS(ctx context.Context, logger *slog.Logger) error {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	err := flushDNS(ctx, withTimeout(runCommand))
	if err != nil {
		logger.Warn("hosts: DNS cache flush failed", "err", err)
		return err
	}
	logger.Debug("hosts: DNS cache flushed")
	return nil
}

// withTimeout gives every command its own FlushTimeout.
func withTimeout(run runFunc) runFunc {
	return func(ctx context.Context, path string, args ...string) ([]byte, error) {
		ctx, cancel := context.WithTimeout(ctx, FlushTimeout)
		defer cancel()
		return run(ctx, path, args...)
	}
}

// runCommand executes path with args (argv, never through a shell).
func runCommand(ctx context.Context, path string, args ...string) ([]byte, error) {
	cmd := newCommand(ctx, path, args...)
	var out capBuffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return out.Bytes(), err
}

// newCommand builds the exec.Cmd; the platform part lives in configureCmd.
func newCommand(ctx context.Context, path string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.WaitDelay = time.Second // do not hang on a grandchild keeping the pipes open
	configureCmd(cmd)
	return cmd
}

// cmdError describes a failed command with the start of its output.
func cmdError(path string, args []string, out []byte, err error) error {
	msg := strings.TrimSpace(string(out))
	if len(msg) > 200 {
		msg = msg[:200] + "…"
	}
	name := filepath.Base(path)
	if msg == "" {
		return fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, msg)
}

// capBuffer keeps the first maxCmdOutput bytes written to it.
type capBuffer struct{ buf bytes.Buffer }

func (b *capBuffer) Write(p []byte) (int, error) {
	if room := maxCmdOutput - b.buf.Len(); room > 0 {
		b.buf.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

func (b *capBuffer) Bytes() []byte { return b.buf.Bytes() }
