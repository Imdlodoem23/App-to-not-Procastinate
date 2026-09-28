//go:build unix

package platform

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"syscall"
)

// unixTree implements treeOps with lstat, O_NOFOLLOW descriptors and
// unlink: no operation follows a symbolic link.
type unixTree struct{}

func (unixTree) inspect(path string) (treeEntry, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return treeEntry{}, err
	}
	return entryOf(fi), nil
}

// entryOf classifies fi (from lstat or fstat).
func entryOf(fi fs.FileInfo) treeEntry {
	e := treeEntry{perm: fi.Mode().Perm(), links: 1}
	switch m := fi.Mode(); {
	case m&fs.ModeSymlink != 0:
		e.kind = entryLink
	case m.IsDir():
		e.kind = entryDir
	case m.IsRegular():
		e.kind = entryFile
	default:
		e.kind = entryOther
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		e.trusted = st.Uid == 0
		e.links = uint64(st.Nlink)
	}
	e.private = e.perm&0o077 == 0
	return e
}

func (unixTree) list(dir string) ([]string, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, len(ents))
	for i, e := range ents {
		names[i] = e.Name()
	}
	return names, nil
}

// remove unlinks the entry; unlink never follows a symbolic link.
func (unixTree) remove(path string) error { return os.Remove(path) }

// secure opens the entry without following links (and without blocking on
// a FIFO swapped in), checks through the descriptor that it is still what
// inspect saw, and sets owner root:root (gid 0 is wheel on macOS) and the
// guardian mode: the exact DirMode/PrivateDirMode for the directory passed to
// EnsureDir; otherwise 0700/0600 when private and, for the rest, the current
// mode limited to DirMode/FileMode (never wider than it was).
func (unixTree) secure(path string, e treeEntry, root, private bool) error {
	flags := os.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_NONBLOCK | syscall.O_NOCTTY
	if e.kind == entryDir {
		flags |= syscall.O_DIRECTORY
	}
	f, err := os.OpenFile(path, flags, 0)
	if err != nil {
		if errors.Is(err, syscall.ELOOP) || errors.Is(err, syscall.ENOTDIR) {
			return fmt.Errorf("%s is not a plain directory or file", path)
		}
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	now := entryOf(fi)
	switch {
	case now.kind != e.kind:
		return fmt.Errorf("%s changed while it was secured", path)
	case now.kind == entryFile && now.links > 1:
		return fmt.Errorf("%s has more than one hard link", path)
	case now.kind != entryDir && now.kind != entryFile:
		return fmt.Errorf("%s is not a plain directory or file", path)
	}
	if err := f.Chown(0, 0); err != nil {
		return err
	}
	return f.Chmod(unixMode(now, root, private))
}

// unixMode is the mode secure sets (see there).
func unixMode(e treeEntry, root, private bool) fs.FileMode {
	switch {
	case e.kind == entryDir && root && private:
		return PrivateDirMode
	case e.kind == entryDir && root:
		return DirMode
	case e.kind == entryDir && private:
		return PrivateDirMode
	case e.kind == entryDir:
		return e.perm & DirMode
	case private:
		return SecretFileMode
	}
	return e.perm & FileMode
}
