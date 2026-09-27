package svc

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// cmdTimeout bounds every external command (launchctl, systemctl).
const cmdTimeout = 30 * time.Second

// runCmd runs a fixed system binary with fixed arguments and returns its
// combined output. It is a variable so tests can fake it.
var runCmd = func(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("%s %s: %w: %s", filepath.Base(name), strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// currentExecutable returns the running binary with symlinks resolved.
func currentExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("svc: locate executable: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Abs(exe)
}

// isEphemeralPath reports whether exe lives somewhere that does not survive
// a reboot or an app quit: an AppImage mount (/tmp/.mount_XXXX) or /tmp.
func isEphemeralPath(exe string) bool {
	p := filepath.ToSlash(filepath.Clean(exe))
	return strings.Contains(p, "/.mount_") || strings.HasPrefix(p, "/tmp/") || strings.HasPrefix(p, "/var/tmp/")
}

// installExecutable copies src to dst atomically (temp file in the same
// directory, then rename), mode 0755. The rename replaces a running binary
// safely on Unix: the old process keeps its inode. Copying a file onto itself
// only fixes the mode.
func installExecutable(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	srcInfo, err := os.Stat(src)
	if err != nil {
		return err
	}
	if !srcInfo.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", src)
	}
	if dstInfo, err := os.Stat(dst); err == nil && os.SameFile(srcInfo, dstInfo) {
		return os.Chmod(dst, 0o755)
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp, err := os.CreateTemp(filepath.Dir(dst), "."+filepath.Base(dst)+".*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := io.Copy(tmp, in); err != nil {
		return err
	}
	if err := tmp.Chmod(0o755); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, dst); err != nil {
		return err
	}
	ok = true
	return nil
}

// removeFile deletes path; a missing file is not an error.
func removeFile(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func fileExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}
