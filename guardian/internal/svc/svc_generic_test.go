//go:build unix && !darwin

package svc

import (
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTrustedInPlace(t *testing.T) {
	fakeTree(t, systemTree())
	cases := map[string]bool{
		"/opt/Céntrate/g":         true,  // .deb install
		"/home/u/squashfs-root/g": false, // extracted AppImage
		"/usr/local/g":            false, // group-writable /usr/local
		"/opt/100%/g":             false, // root-only but not quotable in a unit
		"/opt/Céntrate":           false, // not a regular file
		"/opt/missing":            false,
	}
	for in, want := range cases {
		if got := trustedInPlace(in); got != want {
			t.Errorf("trustedInPlace(%q) = %v, want %v", in, got, want)
		}
	}
	if got := registeredExecutable("/opt/Céntrate/g"); got != "/opt/Céntrate/g" {
		t.Errorf("registeredExecutable(trusted) = %q", got)
	}
	if got := registeredExecutable("/home/u/squashfs-root/g"); got != LinuxStablePath {
		t.Errorf("registeredExecutable(home) = %q, want %q", got, LinuxStablePath)
	}
}

// fakeOwnership reports every real path as root-owned without group/other
// write, except those for which untrusted returns true (owned by uid 1000).
func fakeOwnership(t *testing.T, untrusted func(string) bool) {
	t.Helper()
	prev := lstat
	lstat = func(p string) (fs.FileInfo, error) {
		fi, err := os.Lstat(p)
		if err != nil {
			return nil, err
		}
		info := fakeInfo{name: fi.Name(), mode: fi.Mode() &^ 0o022}
		if untrusted(p) {
			info.uid = 1000
		}
		return info, nil
	}
	t.Cleanup(func() { lstat = prev })
}

func useTargets(t *testing.T, targets ...string) {
	t.Helper()
	prev := protectedTargets
	protectedTargets = targets
	t.Cleanup(func() { protectedTargets = prev })
}

func TestCopyToProtectedFallsBack(t *testing.T) {
	base := t.TempDir()
	src := filepath.Join(base, "src", "centrate-guardian")
	if err := os.MkdirAll(filepath.Dir(src), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, []byte("guardian"), 0o755); err != nil {
		t.Fatal(err)
	}
	// /usr/local chowned to a user: the first target fails the check.
	userOwned := filepath.Join(base, "usrlocal")
	first := filepath.Join(userOwned, "lib", "centrate", "centrate-guardian")
	second := filepath.Join(base, "varlib", "centrate-guardian", "centrate-guardian")
	useTargets(t, first, second)
	fakeOwnership(t, func(p string) bool { return strings.HasPrefix(p, userOwned) })

	m := &Manager{logger: slog.New(slog.DiscardHandler), sourceExe: src}
	got, err := m.copyToProtected()
	if err != nil {
		t.Fatal(err)
	}
	if !sameFile(got, second) {
		t.Fatalf("registered %q, want %q", got, second)
	}
	if b, _ := os.ReadFile(got); string(b) != "guardian" {
		t.Fatalf("copy = %q", b)
	}
	if _, err := os.Lstat(first); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("copy in the untrusted location left behind: %v", err)
	}
}

func TestCopyToProtectedFailsWithoutSafeLocation(t *testing.T) {
	base := t.TempDir()
	src := filepath.Join(base, "centrate-guardian")
	if err := os.WriteFile(src, []byte("guardian"), 0o755); err != nil {
		t.Fatal(err)
	}
	useTargets(t, filepath.Join(base, "a", "g"), filepath.Join(base, "b", "g"))
	fakeOwnership(t, func(string) bool { return true })
	m := &Manager{logger: slog.New(slog.DiscardHandler), sourceExe: src}
	if _, err := m.copyToProtected(); !errors.Is(err, ErrUntrustedExecutable) {
		t.Fatalf("copyToProtected = %v, want ErrUntrustedExecutable", err)
	}
}

func TestSystemBinaryUsesFixedDirs(t *testing.T) {
	prev := systemBinDirs
	t.Cleanup(func() { systemBinDirs = prev })
	dir := t.TempDir()
	systemBinDirs = []string{filepath.Join(dir, "missing"), dir}
	if got := systemBinary("systemctl"); got != "" {
		t.Fatalf("found %q in an empty dir", got)
	}
	tool := filepath.Join(dir, "systemctl")
	if err := os.WriteFile(tool, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", t.TempDir())
	if got := systemBinary("systemctl"); got != tool {
		t.Fatalf("systemBinary = %q, want %q", got, tool)
	}
}
