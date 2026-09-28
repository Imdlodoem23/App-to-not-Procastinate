package store

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// dirLock is the exclusive lock on run/guardian.lock (§10.12 step 1), taken with
// LockFileEx on the first byte.
type dirLock struct {
	f  *os.File
	ol windows.Overlapped
}

func acquireLock(path string) (*dirLock, error) {
	f, err := platform.OpenRegularFile(path, os.O_RDWR|os.O_CREATE, filePerm)
	if err != nil {
		return nil, err
	}
	l := &dirLock{f: f}
	err = windows.LockFileEx(windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &l.ol)
	if err != nil {
		_ = f.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_IO_PENDING) {
			return nil, ErrLocked
		}
		return nil, err
	}
	return l, nil
}

func (l *dirLock) release() error {
	_ = windows.UnlockFileEx(windows.Handle(l.f.Fd()), 0, 1, 0, &l.ol)
	return l.f.Close()
}
