//go:build unix

package hosts

import (
	"errors"
	"io/fs"
	"os"
	"syscall"
)

// fileMeta is what the replacement file inherits from the original.
type fileMeta struct {
	exists   bool
	mode     fs.FileMode
	uid, gid int
	xattrs   []xattr
}

// xattr is one extended attribute (see copiedXattrs).
type xattr struct {
	name  string
	value []byte
}

func captureMeta(path string) fileMeta {
	fi, err := os.Stat(path)
	if err != nil {
		return fileMeta{mode: 0o644, uid: -1, gid: -1}
	}
	fm := fileMeta{exists: true, mode: fi.Mode().Perm(), uid: -1, gid: -1}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		fm.uid, fm.gid = int(st.Uid), int(st.Gid)
	}
	fm.xattrs = readXattrs(path)
	return fm
}

// applyOpen gives the temporary file the original's owner, mode and security
// extended attributes. Every step is best effort: changing the owner needs
// root, and the file is still usable (only less faithful) when one fails.
func (fm fileMeta) applyOpen(f *os.File) {
	if fm.exists && fm.uid >= 0 {
		_ = f.Chown(fm.uid, fm.gid)
	}
	_ = f.Chmod(fm.mode)
	writeXattrs(f.Name(), fm.xattrs)
}

func (fileMeta) applyClosed(string)           {}
func (fileMeta) prepare(string) (undo func()) { return func() {} }
func (fileMeta) finish(string)                {}

// replaceFile atomically replaces dst with src.
func replaceFile(src, dst string) error {
	return os.Rename(src, dst)
}

// isTransientLock reports errors worth retrying. Unix has no mandatory file
// locks, so only the test sentinel qualifies.
func isTransientLock(err error) bool {
	return errors.Is(err, errLocked)
}

// replaceUnsupported reports rename failures that an in-place write avoids:
// EBUSY when the file is a mount point (bind-mounted /etc/hosts in
// containers) and EXDEV when it lives on a different file system.
func replaceUnsupported(err error) bool {
	return errors.Is(err, syscall.EBUSY) || errors.Is(err, syscall.EXDEV)
}

// syncDir makes a rename in dir durable.
func syncDir(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	_ = d.Sync()
	_ = d.Close()
}
