package store

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// FS is the file-system layer every store write goes through. The default, [OSFS],
// opens files with platform.OpenRegularFile (never through a link, never a file with
// several hard links), renames with MoveFileEx(REPLACE_EXISTING|WRITE_THROUGH) on
// Windows and fsyncs directories on POSIX. Tests wrap it to inject failures and
// crashes at every step.
type FS interface {
	// OpenFile opens name like os.OpenFile. A file created with O_CREATE|O_EXCL gets
	// perm exactly (not filtered by the umask) on POSIX.
	OpenFile(name string, flag int, perm fs.FileMode) (File, error)
	ReadDir(name string) ([]fs.DirEntry, error)
	Lstat(name string) (fs.FileInfo, error)
	// Rename atomically replaces newpath with oldpath.
	Rename(oldpath, newpath string) error
	Remove(name string) error
	RemoveAll(name string) error
	// SyncDir makes the creations, renames and removals in dir durable (a no-op on
	// Windows, where MoveFileEx WRITE_THROUGH already is).
	SyncDir(dir string) error
}

// File is an open file of an FS.
type File interface {
	io.Reader
	io.ReaderAt
	io.Writer
	Stat() (fs.FileInfo, error)
	Sync() error
	Truncate(size int64) error
	Close() error
}

// OSFS returns the real file system.
func OSFS() FS { return osFS{} }

type osFS struct{}

func (osFS) OpenFile(name string, flag int, perm fs.FileMode) (File, error) {
	f, err := platform.OpenRegularFile(name, flag, perm)
	if err != nil {
		return nil, err
	}
	if flag&(os.O_CREATE|os.O_EXCL) == os.O_CREATE|os.O_EXCL {
		if err := setMode(f, perm); err != nil {
			_ = f.Close()
			_ = os.Remove(name)
			return nil, err
		}
	}
	return f, nil
}

func (osFS) ReadDir(name string) ([]fs.DirEntry, error) { return os.ReadDir(name) }
func (osFS) Lstat(name string) (fs.FileInfo, error)     { return os.Lstat(name) }
func (osFS) Rename(oldpath, newpath string) error       { return renameReplace(oldpath, newpath) }
func (osFS) Remove(name string) error                   { return os.Remove(name) }
func (osFS) RemoveAll(name string) error                { return os.RemoveAll(name) }
func (osFS) SyncDir(dir string) error                   { return syncDir(dir) }

// File modes (POSIX; Windows files inherit the directory's protected DACL).
const (
	filePerm   = platform.FileMode       // 0644: readable by every local account
	secretPerm = platform.SecretFileMode // 0600: root only
)

// tmpInfix marks temporary files: "<name>.tmp-<pid>-<rand>" (§11.2). Open removes
// every leftover one in the directories the store owns.
const tmpInfix = ".tmp-"

func tempName(path string) string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return path + tmpInfix + strconv.Itoa(os.Getpid()) + "-" + hex.EncodeToString(b[:])
}

func isTemp(name string) bool { return strings.Contains(name, tmpInfix) }

// readFile reads a whole file through fsys.
func readFile(fsys FS, name string) ([]byte, error) {
	f, err := fsys.OpenFile(name, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(f)
	cerr := f.Close()
	if err == nil {
		err = cerr
	}
	return data, err
}

func notExist(err error) bool { return errors.Is(err, fs.ErrNotExist) }

// writeAtomic replaces path with data (§11.2): a temporary file in the same directory
// created with O_EXCL and perm, written, fsynced and closed, renamed over path, then
// the directory is fsynced. On failure before the rename the temporary file is
// removed and path is untouched. A failure after the rename (the directory fsync)
// leaves the new content in place and still returns the error.
func writeAtomic(fsys FS, path string, data []byte, perm fs.FileMode) error {
	tmp := tempName(path)
	f, err := fsys.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return err
	}
	closed, renamed := false, false
	defer func() {
		if renamed {
			return
		}
		if !closed {
			_ = f.Close()
		}
		_ = fsys.Remove(tmp)
	}()
	n, err := f.Write(data)
	if err == nil && n != len(data) {
		err = io.ErrShortWrite
	}
	if err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	closed = true
	if err := f.Close(); err != nil {
		return err
	}
	if err := fsys.Rename(tmp, path); err != nil {
		return err
	}
	renamed = true
	return fsys.SyncDir(filepath.Dir(path))
}

// WriteAtomic replaces path with data using the atomic procedure of §11.2 on the real
// file system, for the guardian's other files (client.json, backups…). perm is the
// POSIX mode of the new file (Windows: the directory's inherited DACL applies).
func WriteAtomic(path string, data []byte, perm fs.FileMode) error {
	return writeErr("write "+filepath.Base(path), writeAtomic(OSFS(), path, data, perm))
}
