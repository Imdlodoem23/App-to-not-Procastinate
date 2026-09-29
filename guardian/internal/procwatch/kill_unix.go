//go:build linux || darwin

package procwatch

import (
	"errors"
	"fmt"
	"time"

	"golang.org/x/sys/unix"
)

// pidTarget refers to a process by PID only. identity is re-read before every
// decision, which leaves a window of a few milliseconds for PID reuse; Linux
// prefers pidfdTarget.
type pidTarget struct {
	pid    int
	read   func(pid int) (Process, error)
	exited func(pid int) bool
}

func (t *pidTarget) identity() (Process, error) {
	if t.exited(t.pid) {
		return Process{}, ErrNotFound
	}
	return t.read(t.pid)
}

func (t *pidTarget) signal(force bool) error {
	return signalErr(unix.Kill(t.pid, unixSignal(force)))
}

func (t *pidTarget) wait(d time.Duration) bool {
	deadline := time.Now().Add(d)
	for {
		if t.exited(t.pid) {
			return true
		}
		left := time.Until(deadline)
		if left <= 0 {
			return false
		}
		time.Sleep(min(left, exitPoll))
	}
}

func (t *pidTarget) close() {}

func unixSignal(force bool) unix.Signal {
	if force {
		return unix.SIGKILL
	}
	return unix.SIGTERM
}

// signalErr maps ESRCH to ErrNotFound.
func signalErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, unix.ESRCH):
		return ErrNotFound
	default:
		return fmt.Errorf("procwatch: signal process: %w", err)
	}
}

// killGone reports whether kill(pid, 0) says the PID does not exist. EPERM
// means it exists but belongs to another user.
func killGone(pid int) bool { return errors.Is(unix.Kill(pid, 0), unix.ESRCH) }
