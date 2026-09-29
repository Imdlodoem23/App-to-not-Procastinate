//go:build linux || darwin

package procwatch

import (
	"errors"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// killSignal returns the signal that ended a reaped helper.
func killSignal(t *testing.T, cmd *exec.Cmd) syscall.Signal {
	t.Helper()
	err := cmd.Wait()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("helper Wait = %v, want it killed by a signal", err)
	}
	ws, ok := exitErr.Sys().(syscall.WaitStatus)
	if !ok || !ws.Signaled() {
		t.Fatalf("helper was not killed by a signal: %v", err)
	}
	return ws.Signal()
}

func TestKillSendsSIGTERMFirst(t *testing.T) {
	cmd := startHelper(t, "sleep")
	if err := (OSKiller{Grace: 10 * time.Second}).Kill(cmd.Process.Pid, helperName()); err != nil {
		t.Fatalf("Kill = %v", err)
	}
	if sig := killSignal(t, cmd); sig != syscall.SIGTERM {
		t.Errorf("helper ended by %v, want SIGTERM", sig)
	}
}

func TestKillEscalatesToSIGKILL(t *testing.T) {
	cmd := startHelper(t, "ignore-term")
	const grace = 300 * time.Millisecond
	start := time.Now()
	if err := (OSKiller{Grace: grace}).Kill(cmd.Process.Pid, helperName()); err != nil {
		t.Fatalf("Kill = %v", err)
	}
	if d := time.Since(start); d < grace {
		t.Errorf("Kill returned after %v, before the %v grace period", d, grace)
	}
	if sig := killSignal(t, cmd); sig != syscall.SIGKILL {
		t.Errorf("helper ended by %v, want SIGKILL", sig)
	}
}
