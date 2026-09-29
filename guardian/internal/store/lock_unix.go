//go:build unix

package store

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// dirLock is the exclusive lock on run/guardian.lock (§10.12 step 1). flock locks
// belong to the open file description, so a second Open in the same process fails too.
//
// The file is private (0600, like run/ itself): flock grants an exclusive lock through
// a read-only descriptor, so a standard user who could open it could wait for the lock
// and take it the moment the guardian exits, keeping every later start out (ErrLocked).
type dirLock struct{ f *os.File }

func acquireLock(path string) (*dirLock, error) {
	f, err := platform.OpenRegularFile(path, os.O_RDWR|os.O_CREATE, secretPerm)
	if err != nil {
		return nil, err
	}
	// A file an older build created keeps its 0644 mode: tighten it.
	if fi, err := f.Stat(); err != nil || fi.Mode().Perm() != secretPerm {
		if err == nil {
			err = f.Chmod(secretPerm)
		}
		if err != nil {
			_ = f.Close()
			return nil, err
		}
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, unix.EWOULDBLOCK) {
			return nil, ErrLocked
		}
		return nil, err
	}
	return &dirLock{f: f}, nil
}

func (l *dirLock) release() error {
	_ = unix.Flock(int(l.f.Fd()), unix.LOCK_UN)
	return l.f.Close()
}
