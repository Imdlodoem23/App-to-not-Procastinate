//go:build unix

package platform

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// systemPATH is the PATH UseSystemPATH installs: root-owned directories only.
const systemPATH = "/usr/sbin:/usr/bin:/sbin:/bin"

// IsElevated reports whether the process runs as root.
func IsElevated() bool {
	return os.Geteuid() == 0
}

// UseSystemPATH replaces PATH with fixed system directories, so every binary
// run by name (kardianos/service runs systemctl, service and launchctl that
// way) resolves to a root-owned one whatever environment an elevated caller
// inherited. It is a no-op on Windows.
func UseSystemPATH() {
	_ = os.Setenv("PATH", systemPATH)
}

// secureDir creates dir if needed and takes over the whole tree (see
// takeover.go): an untrusted tree is moved aside and created again; in a
// trusted one links, multi-linked and special files are deleted and every
// entry becomes root-owned with the guardian mode, set through descriptors
// opened with O_NOFOLLOW so a link swapped in after a check is never
// followed.
func secureDir(dir string, private bool, rep *TakeoverReport) error {
	mode := DirMode
	if private {
		mode = PrivateDirMode
	}
	create := func() error {
		if _, err := os.Lstat(dir); err == nil || !errors.Is(err, fs.ErrNotExist) {
			return err // takeOver decides about what is there
		}
		return os.MkdirAll(dir, mode)
	}
	return secureLoop(unixTree{}, dir, private, create, rep)
}

// OpenRegularFile opens path like os.OpenFile, but never follows a symbolic
// link in the last path element (O_NOFOLLOW) and fails unless the result is a
// regular file with exactly one hard link, so a file planted by another user
// cannot redirect an elevated write. O_TRUNC is applied only after those
// checks.
func OpenRegularFile(path string, flag int, perm fs.FileMode) (*os.File, error) {
	trunc := flag&os.O_TRUNC != 0
	f, err := os.OpenFile(path, (flag&^os.O_TRUNC)|syscall.O_NOFOLLOW, perm)
	if err != nil {
		if errors.Is(err, syscall.ELOOP) {
			return nil, &fs.PathError{Op: "open", Path: path, Err: errors.New("is a symbolic link")}
		}
		return nil, err
	}
	if err := checkRegular(f); err != nil {
		_ = f.Close()
		return nil, err
	}
	if trunc {
		if err := f.Truncate(0); err != nil {
			_ = f.Close()
			return nil, err
		}
	}
	return f, nil
}

func checkRegular(f *os.File) error {
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() {
		return &fs.PathError{Op: "open", Path: f.Name(), Err: errors.New("not a regular file")}
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && uint64(st.Nlink) > 1 {
		return &fs.PathError{Op: "open", Path: f.Name(), Err: errors.New("has more than one hard link")}
	}
	return nil
}

// WriteSecretFile atomically replaces path with data, readable only by its
// owner (root when elevated): mode SecretFileMode, written to a temporary file
// in the same directory, fsynced and renamed into place. The directory must
// exist; create it with EnsurePrivateDir.
func WriteSecretFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("platform: write secret: %w", err)
	}
	name := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			_ = tmp.Close()
			_ = os.Remove(name)
		}
	}()
	if err := tmp.Chmod(SecretFileMode); err != nil {
		return fmt.Errorf("platform: write secret: %w", err)
	}
	if elevated() {
		if err := tmp.Chown(0, 0); err != nil {
			return fmt.Errorf("platform: write secret: %w", err)
		}
	}
	if _, err := tmp.Write(data); err != nil {
		return fmt.Errorf("platform: write secret: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("platform: write secret: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("platform: write secret: %w", err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("platform: write secret: %w", err)
	}
	ok = true
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// transientRemoveError reports whether os.RemoveAll may succeed if retried.
// On Unix nothing holds files the way Windows sharing modes do.
func transientRemoveError(error) bool {
	return false
}
