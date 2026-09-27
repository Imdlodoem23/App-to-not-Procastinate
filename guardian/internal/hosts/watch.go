package hosts

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"io/fs"
	"os"
	"time"
)

const (
	// DefaultPollInterval is how often Watch checks the hosts file.
	DefaultPollInterval = 2 * time.Second
	// fullHashEvery forces a content hash every n polls even when size and
	// modification time look unchanged (a tool can restore the old mtime).
	fullHashEvery = 5
)

// statKey is the cheap part of the check.
type statKey struct {
	exists  bool
	size    int64
	modTime int64 // UnixNano
}

// Watch polls the hosts file every PollInterval (2 s by default; polling works
// the same on every OS and file system, unlike change notifications) and calls
// onChange when its content changes for a reason other than this Manager's own
// Apply, Remove or RestoreFromBackup: someone deleted our lines, edited the
// file, or removed it. The engine then calls Verify and re-applies.
//
// Each poll compares size and modification time and, when they changed (or
// at least every fifth poll), the SHA-256 of the content. Our own writes are
// debounced by fingerprint: the content they leave behind becomes the new
// baseline, so they never trigger onChange, while any different content
// seen afterwards does. If this Manager already wrote the file, a change made
// before Watch started is reported on the first poll.
//
// onChange runs on the watching goroutine and may call Apply. Watch blocks
// until ctx is done and returns ctx.Err().
func (m *Manager) Watch(ctx context.Context, onChange func()) error {
	if err := m.checkPath(); err != nil {
		return err
	}
	interval := m.PollInterval
	if interval <= 0 {
		interval = DefaultPollInterval
	}
	newTicker := m.newTicker
	if newTicker == nil {
		newTicker = realTicker
	}
	ticks, stop := newTicker(interval)
	defer stop()

	w := &watcher{m: m, sinceHash: fullHashEvery} // hash on the first poll
	w.init()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticks:
			if w.poll() && onChange != nil {
				onChange()
			}
		}
	}
}

func realTicker(d time.Duration) (<-chan time.Time, func()) {
	t := time.NewTicker(d)
	return t.C, t.Stop
}

type watcher struct {
	m         *Manager
	seq       uint64      // m.seq when base was last taken from m.known
	base      fingerprint // content we consider current
	stat      statKey     // stat at the last hash (zero forces a hash)
	sinceHash int         // polls since the last hash
}

func (w *watcher) init() {
	m := w.m
	m.mu.Lock()
	defer m.mu.Unlock()
	w.seq = m.seq
	if m.seq > 0 {
		w.base = m.known
		return
	}
	if fp, _, err := m.fingerprintNow(); err == nil {
		w.base = fp
	}
}

// poll reports whether the content changed since the last poll, ignoring our
// own writes. It holds m.mu while reading so it never sees one of our
// in-place writes half done.
func (w *watcher) poll() bool {
	m := w.m
	m.mu.Lock()
	seq, known := m.seq, m.known
	st := m.statNow()
	needHash := seq != w.seq || st != w.stat || w.sinceHash+1 >= fullHashEvery
	var fp fingerprint
	var err error
	if needHash {
		fp, st, err = m.fingerprintNow()
	}
	m.mu.Unlock()

	if seq != w.seq {
		w.seq, w.base = seq, known
	}
	if !needHash {
		w.sinceHash++
		return false
	}
	if err != nil {
		// Unreadable right now (an antivirus holding it, say): try next time.
		w.sinceHash = fullHashEvery
		return false
	}
	w.sinceHash, w.stat = 0, st
	if fp == w.base {
		return false
	}
	w.base = fp
	return true
}

func (m *Manager) statNow() statKey {
	fi, err := os.Stat(m.Path)
	if err != nil {
		return statKey{}
	}
	return statOf(fi)
}

func statOf(fi os.FileInfo) statKey {
	return statKey{exists: true, size: fi.Size(), modTime: fi.ModTime().UnixNano()}
}

// fingerprintNow hashes the file without loading it whole and returns the
// stat taken on the open file.
func (m *Manager) fingerprintNow() (fingerprint, statKey, error) {
	f, err := os.Open(m.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return fingerprint{}, statKey{}, nil
	}
	if err != nil {
		return fingerprint{}, statKey{}, err
	}
	defer func() { _ = f.Close() }()
	fi, err := f.Stat()
	if err != nil {
		return fingerprint{}, statKey{}, err
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return fingerprint{}, statKey{}, err
	}
	fp := fingerprint{exists: true}
	h.Sum(fp.sum[:0])
	return fp, statOf(fi), nil
}
