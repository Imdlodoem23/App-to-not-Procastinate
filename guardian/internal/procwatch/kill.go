package procwatch

import (
	"errors"
	"time"
)

// procTarget is an open reference to one process. Where the OS allows it
// (a Windows process handle, a Linux pidfd) it stays bound to that process even
// if it exits and its PID is reused; otherwise identity is re-read by PID.
type procTarget interface {
	// identity returns what List would report for the process now, or
	// ErrNotFound when it has exited (zombies included).
	identity() (Process, error)
	// signal asks the process to exit (force=false: SIGTERM) or kills it
	// (force=true: SIGKILL, TerminateProcess). ErrNotFound when it is gone.
	signal(force bool) error
	// wait reports whether the process exited within d.
	wait(d time.Duration) bool
	close()
}

// killPlan is the OS-independent termination sequence behind Kill.
type killPlan struct {
	goos      string
	open      func(pid int) (procTarget, error)
	graceful  bool          // send a graceful signal first and wait grace
	grace     time.Duration // time to exit after the graceful signal
	forceWait time.Duration // time to exit after the forced termination
}

func (kp killPlan) kill(pid int, name string) error {
	if pid <= 0 || name == "" {
		return ErrInvalid
	}
	if protectedPID(kp.goos, pid) || IsProtected(name) {
		return ErrProtected
	}
	t, err := kp.open(pid)
	if err != nil {
		return err
	}
	defer t.close()

	cur, err := t.identity()
	if err != nil {
		return err
	}
	if !sameName(kp.goos, cur.Name, name) {
		return ErrNameMismatch
	}
	if processProtected(kp.goos, cur) {
		return ErrProtected
	}

	signalled := false
	if kp.graceful && kp.grace > 0 {
		if err := t.signal(false); err != nil {
			return err
		}
		signalled = true
		if t.wait(kp.grace) {
			return nil
		}
		// Still there: make sure it is still the same executable before
		// forcing (a PID can only be reused after the process exited).
		cur, err := t.identity()
		switch {
		case errors.Is(err, ErrNotFound):
			return nil
		case err != nil:
			return err
		case !sameName(kp.goos, cur.Name, name):
			return nil
		}
	}

	if err := t.signal(true); err != nil {
		if signalled && errors.Is(err, ErrNotFound) {
			return nil
		}
		return err
	}
	if t.wait(kp.forceWait) {
		return nil
	}
	return ErrStillRunning
}
