//go:build unix

package store

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// A planted key reachable through a symlink or a second hard link is compromised.
func TestPlantedKeyIsReplaced(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink"} {
		t.Run(kind, func(t *testing.T) {
			e := newEnv(t)
			s := e.started()
			e.closeClean(s)
			keyPath := filepath.Join(e.dir, dirSecret, keyFile)
			planted := filepath.Join(t.TempDir(), "known.key")
			known := bytes.Repeat([]byte{7}, keySize)
			writeFileT(t, planted, known)
			if err := os.Remove(keyPath); err != nil {
				t.Fatal(err)
			}
			var err error
			if kind == "symlink" {
				err = os.Symlink(planted, keyPath)
			} else {
				err = os.Link(planted, keyPath)
			}
			if err != nil {
				t.Fatal(err)
			}
			_, rep := e.open()
			if !rep.KeyReplaced || rep.NeedEpoch != EpochUntrustedKey {
				t.Fatalf("report %+v", rep)
			}
			if fi, err := os.Lstat(keyPath); err != nil || !fi.Mode().IsRegular() || bytes.Equal(e.key(), known) {
				t.Fatalf("key not replaced by a plain file: %v", err)
			}
			if got := readFileT(t, planted); !bytes.Equal(got, known) {
				t.Fatal("the planted file was modified")
			}
		})
	}
}

func TestTrustedOwner(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	writeFileT(t, p, []byte("x"))
	if err := trustedOwner(p); err != nil {
		t.Fatalf("own file: %v", err)
	}
	if err := trustedOwner(dir); err == nil {
		t.Fatal("a directory is not a trusted file")
	}
	if err := trustedOwner(filepath.Join(dir, "missing")); err == nil {
		t.Fatal("missing file")
	}
}
