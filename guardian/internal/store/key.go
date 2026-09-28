package store

import (
	"crypto/rand"
	"fmt"
	"io"
	"os"
)

// keySize is the length of secret/ledger.key (§11.1).
const keySize = 32

// loadKey loads secret/ledger.key or creates it with O_EXCL (§10.12 step 4). A key
// that is not a regular file owned by SYSTEM/Administrators (root), or that does not
// have the right length, is compromised: it is deleted and replaced, and the report
// says so (a new epoch untrusted_key follows unless the directory is fresh). Other
// read errors fail Open rather than replace a good key.
func (s *Store) loadKey(rep *RecoveryReport) error {
	path := s.path(dirSecret, keyFile)
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
	if err := s.fs.Remove(path); err != nil && !notExist(err) {
		return fmt.Errorf("store: remove untrusted ledger key: %w", err)
	}
	return s.createKey(path)
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
