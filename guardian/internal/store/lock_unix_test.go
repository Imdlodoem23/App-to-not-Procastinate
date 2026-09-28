//go:build unix

package store

import (
	"os"
	"path/filepath"
	"testing"
)

// guardian.lock and run/ are private: a local account that could open the lock file,
// even read-only, could flock it once the guardian exits and keep it out (ErrLocked).
func TestLockFileIsPrivate(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	lock := filepath.Join(e.dir, dirRun, lockName)
	for _, c := range []struct {
		path string
		want os.FileMode
	}{{lock, secretPerm}, {filepath.Join(e.dir, dirRun), 0o700}, {filepath.Join(e.dir, dirEvents), 0o700}} {
		fi, err := os.Stat(c.path)
		if err != nil || fi.Mode().Perm() != c.want {
			t.Fatalf("%s: %v %v, want %v", c.path, fi.Mode().Perm(), err, c.want)
		}
	}
	e.closeClean(s)

	// A lock file an older build left readable is tightened on the next Open.
	if err := os.Chmod(lock, filePerm); err != nil {
		t.Fatal(err)
	}
	s, _ = e.open()
	if fi, err := os.Stat(lock); err != nil || fi.Mode().Perm() != secretPerm {
		t.Fatalf("old lock file: %v %v", fi.Mode().Perm(), err)
	}
	e.closeClean(s)
}
