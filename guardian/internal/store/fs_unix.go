//go:build unix

package store

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"syscall"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// setMode gives a newly created file exactly perm (the umask filtered it at creation).
func setMode(f *os.File, perm fs.FileMode) error { return f.Chmod(perm) }

func renameReplace(oldpath, newpath string) error { return os.Rename(oldpath, newpath) }

// syncDir fsyncs a directory so the entries created, renamed or removed in it survive
// a power loss. File systems that cannot sync a directory are not an error.
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	err = d.Sync()
	cerr := d.Close()
	if err != nil && !errors.Is(err, syscall.EINVAL) && !errors.Is(err, syscall.ENOTSUP) &&
		!errors.Is(err, syscall.ENOTTY) {
		return err
	}
	return cerr
}

func isDiskFull(err error) bool {
	return errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT)
}

// trustedOwner checks that path is a regular file owned by root (§10.12 step 4). A
// process without administrator rights (development, unit tests) trusts its own
// effective uid instead, since it cannot create root-owned files.
func trustedOwner(path string) error {
	fi, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", path)
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("%s: no owner information", path)
	}
	want := uint32(0)
	if !platform.IsElevated() {
		want = uint32(os.Geteuid())
	}
	if st.Uid != want {
		return fmt.Errorf("%s is owned by uid %d, not %d", path, st.Uid, want)
	}
	if st.Nlink != 1 {
		return fmt.Errorf("%s has %d hard links", path, st.Nlink)
	}
	return nil
}
