package hosts

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// tempPrefix and tempSuffix name the temporary files written next to the
	// hosts file (and in BackupDir). Leftovers from a crash are removed on the
	// first write of the next process.
	tempPrefix = ".centrate-hosts-"
	tempSuffix = ".tmp"

	// lockRetryBudget is how long a replace blocked by another process (an
	// antivirus scanning the file, typically) is retried before falling back
	// to an in-place write.
	lockRetryBudget = 5 * time.Second
	firstBackoff    = 50 * time.Millisecond
	maxBackoff      = time.Second

	// inPlaceAttempts is how many times the in-place fallback is tried.
	inPlaceAttempts = 3
	inPlaceBackoff  = 200 * time.Millisecond
)

// errLocked simulates a file locked by another process in tests (and any
// platform-independent code that wants to report one).
var errLocked = errors.New("hosts: file locked by another process")

// tempCreateError marks a failure to create the temporary file.
type tempCreateError struct{ err error }

func (e *tempCreateError) Error() string { return "hosts: create temporary file: " + e.err.Error() }
func (e *tempCreateError) Unwrap() error { return e.err }

// write replaces the hosts file with data, preserving its permissions,
// ownership and ACL where possible:
//
//  1. data goes to a temporary file in the same directory, which receives the
//     original's metadata (Unix: mode, owner, SELinux label and POSIX ACL;
//     Windows: owner, group, DACL and attributes) and is fsynced;
//  2. the temporary file replaces the original atomically (rename(2) plus a
//     directory fsync on Unix; MoveFileEx with MOVEFILE_REPLACE_EXISTING |
//     MOVEFILE_WRITE_THROUGH on Windows). A replace refused because another
//     process holds the file open is retried with exponential backoff for
//     about 5 s;
//  3. if the replace still fails for that reason, or cannot work at all (the
//     file is a bind mount, as /etc/hosts is in Docker containers, or the
//     directory is not writable), the file is rewritten in place: write from
//     offset 0, truncate to the new size, fsync. That is not atomic, which is
//     why Damaged and RestoreFromBackup exist.
//
// Callers hold m.mu.
func (m *Manager) write(data []byte) error {
	if m.beforeWrite != nil {
		m.beforeWrite()
	}
	target := m.Path
	if resolved, err := filepath.EvalSymlinks(m.Path); err == nil {
		target = resolved
	}
	dir := filepath.Dir(target)
	if !m.cleaned {
		removeStaleTemps(dir)
		m.cleaned = true
	}
	meta := captureMeta(target)
	err := m.writeAtomic(dir, target, data, meta)
	if err == nil {
		return nil
	}
	if !canWriteInPlace(err) {
		return fmt.Errorf("hosts: replace: %w", err)
	}
	m.logger().Warn("hosts: atomic replace failed, rewriting in place", "err", err)
	if err := m.writeInPlaceRetry(target, data, meta); err != nil {
		return fmt.Errorf("hosts: write in place: %w", err)
	}
	return nil
}

func (m *Manager) writeAtomic(dir, target string, data []byte, meta fileMeta) error {
	tmp, err := os.CreateTemp(dir, tempPrefix+"*"+tempSuffix)
	if err != nil {
		return &tempCreateError{err}
	}
	name := tmp.Name()
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(name)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	meta.applyOpen(tmp)
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	meta.applyClosed(name)

	restore := meta.prepare(target)
	if err := m.replaceWithRetry(name, target); err != nil {
		restore()
		return err
	}
	committed = true
	meta.finish(target)
	syncDir(dir)
	return nil
}

// replaceWithRetry retries a replace refused by a transient lock with
// exponential backoff (50 ms doubling up to 1 s) for about lockRetryBudget.
func (m *Manager) replaceWithRetry(src, dst string) error {
	rename := m.rename
	if rename == nil {
		rename = replaceFile
	}
	sleep := m.sleepFn()
	var slept time.Duration
	delay := firstBackoff
	for {
		err := rename(src, dst)
		if err == nil || !isTransientLock(err) || slept >= lockRetryBudget {
			return err
		}
		m.logger().Debug("hosts: file locked, retrying", "after", delay)
		sleep(delay)
		slept += delay
		delay = min(2*delay, maxBackoff)
	}
}

func (m *Manager) writeInPlaceRetry(target string, data []byte, meta fileMeta) error {
	write := m.inPlace
	if write == nil {
		write = writeInPlace
	}
	restore := meta.prepare(target)
	var err error
	for attempt := range inPlaceAttempts {
		if attempt > 0 {
			m.sleepFn()(inPlaceBackoff)
		}
		if err = write(target, data); err == nil || !isTransientLock(err) {
			break
		}
	}
	if err != nil {
		restore()
		return err
	}
	meta.finish(target)
	return nil
}

func (m *Manager) sleepFn() func(time.Duration) {
	if m.sleep != nil {
		return m.sleep
	}
	return time.Sleep
}

// canWriteInPlace reports whether a failed atomic replace should fall back to
// rewriting the file in place.
func canWriteInPlace(err error) bool {
	var tce *tempCreateError
	if errors.As(err, &tce) {
		return errors.Is(err, fs.ErrPermission)
	}
	return isTransientLock(err) || replaceUnsupported(err)
}

// writeInPlace overwrites path from offset 0 and then truncates it, so the
// file is never empty while the new content is written (it would be if it
// were truncated first), and fsyncs it.
func writeInPlace(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.WriteAt(data, 0); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Truncate(int64(len(data))); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// removeStaleTemps deletes temporary files left in dir by a crashed write.
// Only regular files with our exact prefix and suffix are touched.
func removeStaleTemps(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		n := e.Name()
		if e.Type().IsRegular() && strings.HasPrefix(n, tempPrefix) && strings.HasSuffix(n, tempSuffix) {
			_ = os.Remove(filepath.Join(dir, n))
		}
	}
}
