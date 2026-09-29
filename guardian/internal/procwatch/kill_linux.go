package procwatch

import (
	"errors"
	"fmt"
	"time"

	"golang.org/x/sys/unix"
)

// usePidfd can be turned off by tests to exercise the PID-only fallback.
var usePidfd = true

func osKillPlan(grace time.Duration) killPlan {
	return killPlan{
		goos:      "linux",
		open:      func(pid int) (procTarget, error) { return openLinux(sysProc, pid) },
		graceful:  true,
		grace:     grace,
		forceWait: forceWait,
	}
}

// openLinux pins the process with a pidfd (Linux 5.3+) and falls back to a
// PID-only target when pidfd_open is unavailable (ENOSYS, or blocked by a
// seccomp filter).
func openLinux(fsys procFS, pid int) (procTarget, error) {
	fallback := &pidTarget{
		pid:    pid,
		read:   fsys.read,
		exited: func(pid int) bool { return killGone(pid) || fsys.exited(pid) },
	}
	if !usePidfd {
		return fallback, nil
	}
	fd, err := unix.PidfdOpen(pid, 0)
	switch {
	case err == nil:
		return &pidfdTarget{fd: fd, pid: pid, fsys: fsys}, nil
	case errors.Is(err, unix.ESRCH):
		return nil, ErrNotFound
	case errors.Is(err, unix.ENOSYS), errors.Is(err, unix.EPERM), errors.Is(err, unix.EINVAL):
		return fallback, nil
	default:
		return nil, fmt.Errorf("procwatch: pidfd_open: %w", err)
	}
}

// pidfdTarget is bound to one process: once it exits, the pidfd becomes
// readable and signals through it fail with ESRCH even if the PID is reused.
type pidfdTarget struct {
	fd   int
	pid  int
	fsys procFS
}

// identity reads /proc/<pid> and then checks that the pinned process had not
// exited yet, so the name read belongs to it and not to a PID successor.
func (t *pidfdTarget) identity() (Process, error) {
	p, err := t.fsys.read(t.pid)
	if t.pollExit(0) {
		return Process{}, ErrNotFound
	}
	if err != nil {
		return Process{}, err
	}
	return p, nil
}

func (t *pidfdTarget) signal(force bool) error {
	return signalErr(unix.PidfdSendSignal(t.fd, unixSignal(force), nil, 0))
}

func (t *pidfdTarget) wait(d time.Duration) bool { return t.pollExit(d) }

// pollExit waits up to d for the pidfd to become readable (process exited).
func (t *pidfdTarget) pollExit(d time.Duration) bool {
	deadline := time.Now().Add(d)
	for {
		left := time.Until(deadline)
		ms := 0
		if left > 0 {
			ms = int((left + time.Millisecond - 1) / time.Millisecond)
		}
		fds := []unix.PollFd{{Fd: int32(t.fd), Events: unix.POLLIN}}
		n, err := unix.Poll(fds, ms)
		switch {
		case errors.Is(err, unix.EINTR) && left > 0:
			continue
		case err != nil:
			// Should not happen; fall back to the PID.
			return killGone(t.pid) || t.fsys.exited(t.pid)
		case n > 0:
			return true
		case time.Until(deadline) <= 0:
			return false
		}
	}
}

func (t *pidfdTarget) close() { _ = unix.Close(t.fd) }
