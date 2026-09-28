package store

import (
	"errors"
	"fmt"
	"syscall"
)

var (
	// ErrLocked means another process holds run/guardian.lock.
	ErrLocked = errors.New("store: the data directory is locked by another guardian process")
	// ErrClosed is returned by every method after Close.
	ErrClosed = errors.New("store: closed")
	// ErrFrozen is returned by writes in frozen mode (a newer schema or envelope
	// version was found: §11.5). Reads keep working.
	ErrFrozen = errors.New("store: frozen: the data was written by a newer guardian (read-only)")
	// ErrNoEpoch is returned while there is no current epoch (RecoveryReport.NeedEpoch):
	// start one with NewEpoch first.
	ErrNoEpoch = errors.New("store: no current epoch (start one with NewEpoch)")
	// ErrNoState means Open found no usable state snapshot: rebuild from the log.
	ErrNoState = errors.New("store: no usable state snapshot")
	// ErrBroken is returned by writes after a failed append could not be undone.
	// Reopening the store recovers (the torn tail is truncated).
	ErrBroken = errors.New("store: a failed append could not be undone; reopen the store to recover")
	// ErrInvalid wraps every validation error of the caller's input.
	ErrInvalid = errors.New("store: invalid input")
	// ErrCorrupt means a log line failed verification when read back.
	ErrCorrupt = errors.New("store: log line failed verification")
	// ErrTampered means a sealed file (run/clock.json) failed MAC verification.
	ErrTampered = errors.New("store: MAC verification failed")
	// ErrCleanup wraps the cleanup failures of NewEpoch. The epoch was started anyway
	// and the returned events are valid.
	ErrCleanup = errors.New("store: new epoch started but cleanup failed")
)

// Read-only reasons (details.reason of 503 read_only, §8.1).
const (
	ReasonDiskFull = "disk_full"
	ReasonIOError  = "io_error"
)

// WriteError is returned when a durable write (append, fsync, rename) fails. Nothing
// was applied: the log and the files are as before the call.
type WriteError struct {
	Op  string
	Err error
}

func (e *WriteError) Error() string { return "store: " + e.Op + ": " + e.Err.Error() }

func (e *WriteError) Unwrap() error { return e.Err }

// Reason is ReasonDiskFull when the file system is full, ReasonIOError otherwise.
func (e *WriteError) Reason() string {
	if isDiskFull(e.Err) {
		return ReasonDiskFull
	}
	return ReasonIOError
}

// ReadOnlyReason maps an error of a Store write method to the details.reason of the
// 503 read_only answer ("disk_full" or "io_error"), or "" when err is not a write
// failure (validation errors, ErrFrozen, ErrNoEpoch…).
func ReadOnlyReason(err error) string {
	var we *WriteError
	switch {
	case errors.As(err, &we):
		return we.Reason()
	case errors.Is(err, ErrBroken):
		return ReasonIOError
	}
	return ""
}

// isDiskFull reports whether err, however wrapped, says the file system has no
// room for a write: syscall.ENOSPC, which Go defines on every OS, or one of the
// current OS's own codes (diskFullErrnos). On Windows the two differ: the OS
// reports a full disk as ERROR_DISK_FULL or ERROR_HANDLE_DISK_FULL, never as ENOSPC.
func isDiskFull(err error) bool {
	if errors.Is(err, syscall.ENOSPC) {
		return true
	}
	for _, e := range diskFullErrnos {
		if errors.Is(err, e) {
			return true
		}
	}
	return false
}

func writeErr(op string, err error) error {
	if err == nil {
		return nil
	}
	var we *WriteError
	if errors.As(err, &we) {
		return err
	}
	return &WriteError{Op: op, Err: err}
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}
