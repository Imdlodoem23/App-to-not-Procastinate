//go:build unix

package platform

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func needRoot(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("needs root")
	}
}

func checkOwnerMode(t *testing.T, dir string, want os.FileMode) {
	t.Helper()
	fi, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != want {
		t.Fatalf("mode = %v, want %v", fi.Mode().Perm(), want)
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		t.Skip("no Stat_t")
	}
	if st.Uid != 0 || st.Gid != 0 {
		t.Fatalf("owner = %d:%d, want 0:0", st.Uid, st.Gid)
	}
}

func TestEnsureDirSecuresWhenRoot(t *testing.T) {
	needRoot(t)
	dir := filepath.Join(t.TempDir(), "Centrate")
	if err := os.Mkdir(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	forceElevated(t, true)
	if err := EnsureDir(dir); err != nil {
		t.Fatal(err)
	}
	checkOwnerMode(t, dir, DirMode)
}

func TestEnsurePrivateDirWhenRoot(t *testing.T) {
	needRoot(t)
	dir := filepath.Join(t.TempDir(), "Centrate", "secret")
	forceElevated(t, true)
	if err := EnsurePrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	checkOwnerMode(t, dir, PrivateDirMode)
}

func TestSecureDirNeverFollowsSymlinks(t *testing.T) {
	needRoot(t)
	base := t.TempDir()
	target := filepath.Join(base, "target")
	if err := os.Mkdir(target, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(target, 0o777); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "Centrate")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	forceElevated(t, true)
	if err := EnsureDir(link); err == nil {
		t.Fatal("EnsureDir through a symlink must fail")
	}
	fi, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o777 {
		t.Fatalf("symlink target changed to %v", fi.Mode().Perm())
	}
}

func TestWriteSecretFileOwnedByRoot(t *testing.T) {
	needRoot(t)
	forceElevated(t, true)
	p := filepath.Join(t.TempDir(), "ledger.key")
	if err := WriteSecretFile(p, []byte("k")); err != nil {
		t.Fatal(err)
	}
	checkOwnerMode(t, p, SecretFileMode)
}

func TestUseSystemPATH(t *testing.T) {
	t.Setenv("PATH", "/home/me/bin:/usr/bin")
	UseSystemPATH()
	if got := os.Getenv("PATH"); got != systemPATH {
		t.Fatalf("PATH = %q", got)
	}
}
