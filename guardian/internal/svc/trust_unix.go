//go:build unix

package svc

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// lstat is os.Lstat, replaceable in tests.
var lstat = os.Lstat

// checkRootOnly returns why a non-root user could replace path, or nil: path
// and every folder above it must be owned by root, not writable by group or
// others (a sticky /tmp is refused too) and not a symbolic link.
func checkRootOnly(path string) error {
	cur := filepath.Clean(path)
	for {
		fi, err := lstat(cur)
		if err != nil {
			return err
		}
		if fi.Mode()&fs.ModeSymlink != 0 {
			return fmt.Errorf("%s is a symbolic link", cur)
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		if !ok {
			return fmt.Errorf("cannot read the owner of %s", cur)
		}
		if st.Uid != 0 {
			return fmt.Errorf("%s is owned by uid %d, not root", cur, st.Uid)
		}
		if perm := fi.Mode().Perm(); perm&0o022 != 0 {
			return fmt.Errorf("%s is writable by group or others (mode %v)", cur, perm)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return nil
		}
		cur = parent
	}
}
