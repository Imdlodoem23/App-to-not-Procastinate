//go:build unix

package platform

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func mustWrite(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte("x"), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func mustMkdir(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.Mkdir(path, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func statOwner(t *testing.T, path string) (uint32, uint32, os.FileMode) {
	t.Helper()
	fi, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	st := fi.Sys().(*syscall.Stat_t)
	return st.Uid, st.Gid, fi.Mode().Perm()
}

// The real POSIX takeover on a trusted tree: links, hard links and FIFOs are
// deleted without touching what they point to, everything else becomes
// root:root with the guardian modes, never wider than before, and secret/
// stays private.
func TestEnsureDirTakesOverTheWholeTree(t *testing.T) {
	needRoot(t)
	base := t.TempDir()
	root := filepath.Join(base, "Centrate")
	outside := filepath.Join(base, "outside")
	mustWrite(t, outside, 0o777)
	mustMkdir(t, root, 0o777)
	mustWrite(t, filepath.Join(root, "state.json"), 0o666)
	if err := os.Chown(filepath.Join(root, "state.json"), 0, 1234); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(root, "exec.bin"), 0o4755)
	mustWrite(t, filepath.Join(root, "config.json"), 0o600)
	mustMkdir(t, filepath.Join(root, "secret"), 0o700)
	mustWrite(t, filepath.Join(root, "secret", "ledger.key"), 0o644)
	mustMkdir(t, filepath.Join(root, "secret", "sub"), 0o755)
	mustMkdir(t, filepath.Join(root, "logs"), 0o777)
	mustWrite(t, filepath.Join(root, "logs", "guardian.log"), 0o664)
	if err := os.Symlink(outside, filepath.Join(root, "logs", "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(outside, filepath.Join(root, "hard")); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(root, "fifo"), 0o666); err != nil {
		t.Fatal(err)
	}
	aside := filepath.Join(root, "run.untrusted-1700000000")
	mustMkdir(t, aside, 0o777)
	mustWrite(t, filepath.Join(aside, "planted"), 0o666)
	if err := os.Chown(aside, 1234, 1234); err != nil {
		t.Fatal(err)
	}

	forceElevated(t, true)
	rep, err := EnsureDirReport(root, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Removed) != 3 || len(rep.MovedAside) != 0 {
		t.Fatalf("report = %+v", rep)
	}
	want := map[string]os.FileMode{
		root:                                        DirMode,
		filepath.Join(root, "state.json"):           0o644,
		filepath.Join(root, "exec.bin"):             0o644,
		filepath.Join(root, "config.json"):          0o600,
		filepath.Join(root, "secret"):               PrivateDirMode,
		filepath.Join(root, "secret", "ledger.key"): SecretFileMode,
		filepath.Join(root, "secret", "sub"):        PrivateDirMode,
		filepath.Join(root, "logs"):                 DirMode,
		filepath.Join(root, "logs", "guardian.log"): 0o644,
	}
	for p, mode := range want {
		uid, gid, got := statOwner(t, p)
		if uid != 0 || gid != 0 || got != mode {
			t.Errorf("%s: %d:%d %v, want 0:0 %v", p, uid, gid, got, mode)
		}
	}
	for _, gone := range []string{"hard", "fifo", filepath.Join("logs", "link")} {
		if _, err := os.Lstat(filepath.Join(root, gone)); !os.IsNotExist(err) {
			t.Errorf("%s not removed: %v", gone, err)
		}
	}
	if _, _, mode := statOwner(t, outside); mode != 0o777 {
		t.Fatalf("link target changed to %v", mode)
	}
	if uid, _, mode := statOwner(t, aside); uid != 1234 || mode != 0o777 {
		t.Fatalf("a tree moved aside earlier must be left alone: %d %v", uid, mode)
	}
	if len(asideOf(t, root)) != 0 {
		t.Fatal("a trusted tree must not be moved aside")
	}
	// EnsurePrivateDir on the secret folder keeps its content private.
	if err := EnsurePrivateDir(filepath.Join(root, "secret")); err != nil {
		t.Fatal(err)
	}
	if _, _, mode := statOwner(t, filepath.Join(root, "secret", "ledger.key")); mode != SecretFileMode {
		t.Fatalf("ledger.key mode %v", mode)
	}
}

// A file owned by another account anywhere in the tree condemns it: the
// whole tree is moved aside unchanged and a fresh directory is created.
func TestEnsureDirMovesAsideTreeWithForeignFile(t *testing.T) {
	needRoot(t)
	root := filepath.Join(t.TempDir(), "Centrate")
	mustMkdir(t, root, 0o755)
	mustMkdir(t, filepath.Join(root, "secret"), 0o777)
	planted := filepath.Join(root, "secret", "ledger.key")
	mustWrite(t, planted, 0o644)
	if err := os.Chown(planted, 1234, 1234); err != nil {
		t.Fatal(err)
	}
	forceElevated(t, true)
	if err := EnsureDir(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(root, "secret")); !os.IsNotExist(err) {
		t.Fatalf("the untrusted content is still inside: %v", err)
	}
	checkOwnerMode(t, root, DirMode)
	aside := asideOf(t, root)
	if len(aside) != 1 {
		t.Fatalf("aside = %v", aside)
	}
	if uid, _, mode := statOwner(t, filepath.Join(aside[0], "secret", "ledger.key")); uid != 1234 || mode != 0o644 {
		t.Fatalf("the planted file must be moved aside unchanged: %d %v", uid, mode)
	}
	if _, _, mode := statOwner(t, filepath.Join(aside[0], "secret")); mode != 0o777 {
		t.Fatalf("nothing inside an untrusted tree is changed: %v", mode)
	}
}

func TestEnsureDirReplacesAPlantedFile(t *testing.T) {
	needRoot(t)
	root := filepath.Join(t.TempDir(), "Centrate")
	mustWrite(t, root, 0o644)
	forceElevated(t, true)
	if err := EnsureDir(root); err != nil {
		t.Fatal(err)
	}
	checkOwnerMode(t, root, DirMode)
	if len(asideOf(t, root)) != 1 {
		t.Fatal("the planted file must be moved aside")
	}
}

func TestUnixMode(t *testing.T) {
	dir := treeEntry{kind: entryDir, perm: 0o777}
	file := treeEntry{kind: entryFile, perm: 0o777}
	cases := []struct {
		e             treeEntry
		root, private bool
		want          os.FileMode
	}{
		{dir, true, false, DirMode},
		{treeEntry{kind: entryDir, perm: 0o700}, true, false, DirMode},
		{dir, true, true, PrivateDirMode},
		{dir, false, true, PrivateDirMode},
		{dir, false, false, 0o755},
		{treeEntry{kind: entryDir, perm: 0o750}, false, false, 0o750},
		{file, false, false, 0o644},
		{treeEntry{kind: entryFile, perm: 0o600}, false, false, 0o600},
		{file, false, true, SecretFileMode},
	}
	for _, c := range cases {
		if got := unixMode(c.e, c.root, c.private); got != c.want {
			t.Errorf("unixMode(%v, root=%v, private=%v) = %v, want %v", c.e.perm, c.root, c.private, got, c.want)
		}
	}
}
