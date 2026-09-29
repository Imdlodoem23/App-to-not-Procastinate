package logx

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// RotatingFile is an io.WriteCloser that appends to a file and rotates it when
// the next write would push it past maxSize bytes: name -> name.1 -> ... ->
// name.<maxBackups>, dropping the oldest. It is safe for concurrent use.
//
// A single write larger than maxSize is written whole to a fresh file, so log
// lines are never split across files.
type RotatingFile struct {
	mu         sync.Mutex
	path       string
	maxSize    int64
	maxBackups int
	f          *os.File
	size       int64
	closed     bool
}

// OpenRotatingFile opens (or creates) path for appending. maxSize must be
// positive; maxBackups may be zero, in which case the file is truncated on
// rotation instead of renamed. A path that is a symbolic link, a junction or a
// file with several hard links is refused (see platform.OpenRegularFile).
func OpenRotatingFile(path string, maxSize int64, maxBackups int) (*RotatingFile, error) {
	if maxSize <= 0 {
		return nil, fmt.Errorf("logx: maxSize must be positive, got %d", maxSize)
	}
	if maxBackups < 0 {
		return nil, fmt.Errorf("logx: maxBackups must not be negative, got %d", maxBackups)
	}
	r := &RotatingFile{path: path, maxSize: maxSize, maxBackups: maxBackups}
	if err := r.open(false); err != nil {
		return nil, err
	}
	return r, nil
}

// Path returns the path of the active log file.
func (r *RotatingFile) Path() string {
	return r.path
}

// Write appends p, rotating first if needed.
func (r *RotatingFile) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return 0, os.ErrClosed
	}
	if r.f == nil {
		// A previous rotation could not reopen the file; try again.
		if err := r.open(false); err != nil {
			return 0, err
		}
	}
	if r.size > 0 && r.size+int64(len(p)) > r.maxSize {
		if err := r.rotate(); err != nil {
			return 0, err
		}
	}
	n, err := r.f.Write(p)
	r.size += int64(n)
	return n, err
}

// Close closes the active file. Further writes fail with os.ErrClosed.
func (r *RotatingFile) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil
	}
	r.closed = true
	if r.f == nil {
		return nil
	}
	err := r.f.Close()
	r.f = nil
	return err
}

func (r *RotatingFile) open(truncate bool) error {
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if truncate {
		flags |= os.O_TRUNC
	}
	// Never follow a link planted where the log goes: the guardian runs as
	// root/SYSTEM and would append to whatever file it points at.
	f, err := platform.OpenRegularFile(r.path, flags, platform.FileMode)
	if err != nil {
		return fmt.Errorf("logx: open %s: %w", r.path, err)
	}
	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return fmt.Errorf("logx: stat %s: %w", r.path, err)
	}
	r.f, r.size = f, fi.Size()
	return nil
}

func (r *RotatingFile) rotate() error {
	closeErr := r.f.Close()
	r.f = nil
	truncate := r.maxBackups == 0
	if !truncate {
		_ = os.Remove(r.backup(r.maxBackups))
		for i := r.maxBackups - 1; i >= 1; i-- {
			src := r.backup(i)
			if _, err := os.Lstat(src); err == nil {
				_ = os.Rename(src, r.backup(i+1))
			}
		}
		if err := os.Rename(r.path, r.backup(1)); err != nil {
			// Another process may hold the file open without delete sharing
			// (Windows). Truncating keeps the size bounded anyway.
			truncate = true
		}
	}
	if err := r.open(truncate); err != nil {
		return errors.Join(closeErr, err)
	}
	return nil
}

func (r *RotatingFile) backup(i int) string {
	return r.path + "." + strconv.Itoa(i)
}
