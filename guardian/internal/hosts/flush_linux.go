package hosts

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
)

// linuxBinDirs are the only places the flush binaries are looked for: PATH is
// not consulted.
var linuxBinDirs = []string{"/usr/bin", "/bin", "/usr/sbin", "/sbin"}

func flushDNS(ctx context.Context, run runFunc) error {
	return flushLinux(ctx, run, findBinary)
}

// flushLinux tries resolvectl and falls back to systemd-resolve (systemd older
// than 239). A missing binary or a "not found" reply means there is no
// systemd-resolved cache, which is fine.
func flushLinux(ctx context.Context, run runFunc, find func(name string) string) error {
	var errs []error
	for _, c := range [][]string{
		{"resolvectl", "flush-caches"},
		{"systemd-resolve", "--flush-caches"},
	} {
		path := find(c[0])
		if path == "" {
			continue
		}
		out, err := run(ctx, path, c[1:]...)
		switch {
		case err == nil:
			return nil
		case errors.Is(err, exec.ErrNotFound), errors.Is(err, fs.ErrNotExist):
			continue
		case resolvedAbsent(out):
			return nil
		}
		errs = append(errs, cmdError(path, c[1:], out, err))
	}
	return errors.Join(errs...)
}

// resolvedAbsent recognises the replies of resolvectl when systemd-resolved
// is not installed or not running, e.g. "Failed to flush caches: Unit
// dbus-org.freedesktop.resolve1.service not found." The commands run with
// LC_ALL=C, so the messages are in English.
func resolvedAbsent(out []byte) bool {
	o := bytes.ToLower(out)
	return bytes.Contains(o, []byte("not found")) ||
		bytes.Contains(o, []byte("was not provided by any"))
}

func findBinary(name string) string {
	for _, dir := range linuxBinDirs {
		p := filepath.Join(dir, name)
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0 {
			return p
		}
	}
	return ""
}
