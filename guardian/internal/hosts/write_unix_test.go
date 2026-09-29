//go:build unix

package hosts

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestApplyKeepsModeAndOwner(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	mustApply(t, m, "a.com")
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if after.Mode().Perm() != 0o640 {
		t.Fatalf("mode %v, want 0640", after.Mode().Perm())
	}
	b, a := before.Sys().(*syscall.Stat_t), after.Sys().(*syscall.Stat_t)
	if b.Uid != a.Uid || b.Gid != a.Gid {
		t.Fatalf("owner %d:%d, want %d:%d", a.Uid, a.Gid, b.Uid, b.Gid)
	}
	if os.SameFile(before, after) {
		t.Fatal("the file was not replaced atomically (same inode)")
	}
}

func TestApplyNewFileMode(t *testing.T) {
	m, path := newManager(t, nil)
	mustApply(t, m, "a.com")
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o644 {
		t.Fatalf("new hosts file mode %v, want 0644", fi.Mode().Perm())
	}
}

func TestApplyFollowsSymlink(t *testing.T) {
	dir := t.TempDir()
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(realDir, "hosts")
	if err := os.WriteFile(target, []byte(linuxHosts), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "hosts")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	m := &Manager{Path: link, BackupDir: filepath.Join(dir, "backup")}
	mustApply(t, m, "a.com")
	fi, err := os.Lstat(link)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the symlink was replaced by a regular file")
	}
	if got := readString(t, target); got != linuxHosts+"\n"+section("\n", "a.com") {
		t.Fatalf("target content %q", got)
	}
}

func TestBusyRenameWritesInPlaceAtOnce(t *testing.T) {
	// /etc/hosts is a bind mount in Docker: rename(2) over it fails with EBUSY.
	m, path := newManager(t, []byte(linuxHosts))
	m.sleep = func(time.Duration) { t.Fatal("EBUSY must not be retried") }
	m.rename = func(src, dst string) error {
		return &os.LinkError{Op: "rename", Old: src, New: dst, Err: syscall.EBUSY}
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	mustApply(t, m, "a.com")
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) {
		t.Fatal("expected an in-place write (same inode)")
	}
	if got := readString(t, path); got != linuxHosts+"\n"+section("\n", "a.com") {
		t.Fatalf("got %q", got)
	}
}

func TestReadOnlyDirWritesInPlace(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	dir := t.TempDir()
	hostsDir := filepath.Join(dir, "etc")
	if err := os.Mkdir(hostsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(hostsDir, "hosts")
	if err := os.WriteFile(path, []byte(linuxHosts), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(hostsDir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(hostsDir, 0o755) })
	m := &Manager{Path: path, BackupDir: filepath.Join(dir, "backup")}
	mustApply(t, m, "a.com")
	if got := readString(t, path); got != linuxHosts+"\n"+section("\n", "a.com") {
		t.Fatalf("got %q", got)
	}
}

func TestReplaceUnsupported(t *testing.T) {
	for _, err := range []error{syscall.EBUSY, syscall.EXDEV, &os.LinkError{Err: syscall.EBUSY}} {
		if !replaceUnsupported(err) || !canWriteInPlace(err) {
			t.Errorf("%v should fall back to an in-place write", err)
		}
	}
	for _, err := range []error{syscall.EACCES, syscall.EROFS, errors.New("x")} {
		if canWriteInPlace(err) {
			t.Errorf("%v should not fall back", err)
		}
	}
	if !canWriteInPlace(&tempCreateError{&os.PathError{Err: syscall.EACCES}}) {
		t.Error("a permission error creating the temporary file should fall back")
	}
	if canWriteInPlace(&tempCreateError{&os.PathError{Err: syscall.EROFS}}) {
		t.Error("a read-only file system should not fall back")
	}
}
