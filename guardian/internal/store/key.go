package store

import (
	"crypto/rand"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// keySize is the length of secret/ledger.key (§11.1).
const keySize = 32

// loadKey loads secret/ledger.key or creates it with O_EXCL (§10.12 step 4). A key
// that is not a regular file owned by SYSTEM/Administrators (root), or that does not
// have the right length, is compromised: it is deleted and replaced, and the report
// says so (a new epoch untrusted_key follows unless the directory is fresh). Other
// read errors fail Open rather than replace a good key. When noteTakeover already
// found the key compromised (rep.KeyReplaced), nothing at the path is adopted.
func (s *Store) loadKey(rep *RecoveryReport) error {
	path := s.path(dirSecret, keyFile)
	if rep.KeyReplaced {
		return s.replaceKey(path)
	}
	if _, err := s.fs.Lstat(path); notExist(err) {
		rep.KeyCreated = true
		return s.createKey(path)
	} else if err != nil {
		return fmt.Errorf("store: ledger key: %w", err)
	}
	if err := s.o.trustOwner(path); err != nil {
		rep.KeyProblem = err.Error()
	} else {
		data, err := readFile(s.fs, path)
		if err != nil {
			return fmt.Errorf("store: read ledger key: %w", err)
		}
		if len(data) == keySize {
			s.key = data
			return nil
		}
		rep.KeyProblem = fmt.Sprintf("ledger key has %d bytes, not %d", len(data), keySize)
	}
	rep.KeyReplaced = true
	return s.replaceKey(path)
}

// replaceKey deletes whatever is at path (never following a link) and creates a new key.
func (s *Store) replaceKey(path string) error {
	if err := s.fs.Remove(path); err != nil && !notExist(err) {
		return fmt.Errorf("store: remove untrusted ledger key: %w", err)
	}
	return s.createKey(path)
}

// noteTakeover reports what the §11.1 takeovers (took) moved aside or deleted, and
// marks the key replaced when they took it away before loadKey could see it (see
// takeoverKeyProblem). rep.Fresh must be set.
func (s *Store) noteTakeover(rep *RecoveryReport, took platform.TakeoverReport) {
	for _, a := range took.MovedAside {
		s.warn(rep, "takeover: an untrusted tree was moved aside to %s", a)
	}
	for _, p := range took.Removed {
		s.warn(rep, "takeover: removed %s (a link, a special file or a file with several hard links)", p)
	}
	if p := s.takeoverKeyProblem(took, rep.Fresh); p != "" {
		rep.KeyReplaced, rep.KeyProblem = true, p
	}
}

// takeoverKeyProblem says why the takeovers make the ledger key untrusted, or "".
// The takeover deletes links, multi-linked and special files and renames untrusted
// trees before loadKey runs, so a planted key would otherwise look like a missing one:
//   - secret/ledger.key, or secret/ itself, was deleted: the key was planted (the
//     same verdict loadKey gives a link or a second hard link it sees itself);
//   - the data directory or secret/ was moved aside as untrusted while earlier data
//     exists (not fresh: an anchor, or a log or snapshot left outside secret/): the
//     key that data was signed with lived in a tree that is never adopted. Nothing
//     inside a tree moved aside is looked at. In a fresh directory it is only a
//     pre-created folder, and the new epoch is install anyway.
func (s *Store) takeoverKeyProblem(took platform.TakeoverReport, fresh bool) string {
	keyPath, secretDir := s.path(dirSecret, keyFile), s.path(dirSecret)
	for _, p := range took.Removed {
		switch {
		case samePath(p, keyPath):
			return p + " was a link, a special file or a file with several hard links"
		case samePath(p, secretDir):
			return p + " was a link"
		}
	}
	if fresh {
		return ""
	}
	for _, a := range took.MovedAside {
		i := strings.LastIndex(a, asideMarker)
		if i <= 0 {
			continue
		}
		if orig := a[:i]; samePath(orig, s.dir) || samePath(orig, secretDir) {
			return fmt.Sprintf("%s was not trusted and was moved aside to %s", orig, a)
		}
	}
	return ""
}

// asideMarker is what platform's takeover puts in the name of a tree it moved aside:
// "<dir>.untrusted-<unix time>[-n]".
const asideMarker = ".untrusted-"

// samePath compares two paths as the file system does: case-insensitively on
// Windows and macOS (their default volumes).
func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func (s *Store) createKey(path string) error {
	key := make([]byte, keySize)
	if _, err := rand.Read(key); err != nil {
		return fmt.Errorf("store: generate ledger key: %w", err)
	}
	f, err := s.fs.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, secretPerm)
	if err != nil {
		return fmt.Errorf("store: create ledger key: %w", err)
	}
	n, err := f.Write(key)
	if err == nil && n != keySize {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = s.fs.SyncDir(s.path(dirSecret))
	}
	if err != nil {
		_ = s.fs.Remove(path)
		return fmt.Errorf("store: create ledger key: %w", err)
	}
	s.key = key
	return nil
}
