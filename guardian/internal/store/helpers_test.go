package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeClock drives the wall clock, the boot clock and the boot id by hand (§15).
type fakeClock struct {
	mu     sync.Mutex
	wall   time.Time
	boot   time.Duration
	bootID string
	boots  int
}

func newFakeClock() *fakeClock {
	return &fakeClock{wall: time.Date(2026, 9, 28, 10, 0, 0, 0, time.UTC), boot: time.Hour, bootID: "boot-1", boots: 1}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.wall
}

func (c *fakeClock) BootTime() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.boot
}

func (c *fakeClock) BootID() (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.bootID, nil
}

// Advance moves real time: wall and boot clocks together.
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.wall = c.wall.Add(d)
	c.boot += d
}

// JumpWall moves only the wall clock.
func (c *fakeClock) JumpWall(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.wall = c.wall.Add(d)
}

// Reboot starts a new boot: new id, boot clock from zero.
func (c *fakeClock) Reboot() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.boots++
	c.bootID = fmt.Sprintf("boot-%d", c.boots)
	c.boot = 0
}

// env is a data directory with fakes.
type env struct {
	t      *testing.T
	dir    string
	clk    *fakeClock
	anchor *MemAnchor
	fs     FS
	mod    func(*Options)
}

func newEnv(t *testing.T) *env {
	t.Helper()
	return &env{t: t, dir: filepath.Join(t.TempDir(), "centrate"), clk: newFakeClock(), anchor: NewMemAnchor()}
}

func (e *env) options() Options {
	o := Options{Now: e.clk.Now, BootTime: e.clk.BootTime, BootID: e.clk.BootID, Anchor: e.anchor, FS: e.fs}
	if e.mod != nil {
		e.mod(&o)
	}
	return o
}

func (e *env) open() (*Store, RecoveryReport) {
	e.t.Helper()
	s, rep, err := Open(e.dir, e.options())
	if err != nil {
		e.t.Fatalf("Open: %v", err)
	}
	e.t.Cleanup(func() { _ = s.Close() })
	return s, rep
}

// closeClean stops the store like a clean shutdown.
func (e *env) closeClean(s *Store) {
	e.t.Helper()
	if err := s.MarkCleanShutdown(); err != nil {
		e.t.Fatalf("MarkCleanShutdown: %v", err)
	}
	if err := s.Close(); err != nil {
		e.t.Fatalf("Close: %v", err)
	}
}

func (e *env) reopen(s *Store) (*Store, RecoveryReport) {
	e.t.Helper()
	e.closeClean(s)
	return e.open()
}

// started opens a fresh directory and starts the install epoch.
func (e *env) started() *Store {
	e.t.Helper()
	s, rep := e.open()
	if rep.NeedEpoch != EpochInstall {
		e.t.Fatalf("NeedEpoch = %q, want install", rep.NeedEpoch)
	}
	if _, err := s.NewEpoch(EpochInstall, []Event{epochStarted("install", "")}); err != nil {
		e.t.Fatalf("NewEpoch: %v", err)
	}
	return s
}

func (e *env) epochDir(s *Store) string { return filepath.Join(e.dir, dirEvents, s.Epoch()) }

func (e *env) segments(s *Store) []string {
	e.t.Helper()
	files, err := filepath.Glob(filepath.Join(e.epochDir(s), "*.jsonl"))
	if err != nil {
		e.t.Fatal(err)
	}
	return files
}

func (e *env) key() []byte {
	e.t.Helper()
	k, err := os.ReadFile(filepath.Join(e.dir, dirSecret, keyFile))
	if err != nil {
		e.t.Fatal(err)
	}
	return k
}

func (e *env) quarantine() []string {
	e.t.Helper()
	entries, err := os.ReadDir(filepath.Join(e.dir, dirQuarantine))
	if err != nil {
		e.t.Fatal(err)
	}
	var out []string
	for _, x := range entries {
		out = append(out, x.Name())
	}
	return out
}

const testAt = "2026-09-28T10:00:00.000Z"

func ev(typ string, points int64, data string) Event {
	return Event{At: testAt, Day: "2026-09-28", Type: typ, Points: points, Data: json.RawMessage(data)}
}

func epochStarted(reason, prev string) Event {
	p := "null"
	if prev != "" {
		p = fmt.Sprintf("%q", prev)
	}
	return ev("epoch_started", 0, fmt.Sprintf(`{"reason":%q,"previousEpoch":%s,"carryOverBalance":0}`, reason, p))
}

// batchOf returns n attempt events.
func batchOf(n int, tag string) []Event {
	out := make([]Event, n)
	for i := range out {
		out[i] = ev("attempt", -10, fmt.Sprintf(`{"attemptId":"att_%s%02d","targetKey":"svc:youtube"}`, tag, i))
	}
	return out
}

func mustAppend(t *testing.T, s *Store, batch []Event) []Event {
	t.Helper()
	out, err := s.AppendBatch(batch)
	if err != nil {
		t.Fatalf("AppendBatch: %v", err)
	}
	return out
}

// allEvents reads the whole current epoch.
func allEvents(t *testing.T, s *Store) []Event {
	t.Helper()
	var out []Event
	after := int64(0)
	for {
		p, err := s.ReadEvents(s.Epoch(), after, 1000)
		if err != nil {
			t.Fatalf("ReadEvents: %v", err)
		}
		out = append(out, p.Events...)
		after = p.LastSeq
		if !p.HasMore {
			return out
		}
	}
}

// lineOffsets returns the start offset of every line of data, plus len(data).
func lineOffsets(data []byte) []int {
	offs := []int{0}
	for i, b := range data {
		if b == '\n' {
			offs = append(offs, i+1)
		}
	}
	return offs
}

func readFileT(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func writeFileT(t *testing.T, p string, b []byte) {
	t.Helper()
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

// ---------------------------------------------------------------------------------------
// faultFS: failure and crash injection
// ---------------------------------------------------------------------------------------

var (
	errInjected = errors.New("injected failure")
	errCrashed  = errors.New("process crashed")
)

// faultFS counts the mutating operations (open for writing, write, sync, close of a
// written file, truncate, rename, remove, directory sync) and fails the failAt-th.
// With crash set, every later mutating operation fails too, so no cleanup runs: the
// directory is left exactly as a process killed at that step leaves it. partial bytes
// of a failing write are written first (a torn write).
type faultFS struct {
	base FS

	mu      sync.Mutex
	n       int
	failAt  int
	crash   bool
	failed  bool
	partial int
	err     error
	ops     []string
}

func newFaultFS() *faultFS { return &faultFS{base: OSFS()} }

// arm fails the k-th mutating operation from now.
func (f *faultFS) arm(k int, crash bool, partial int, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failAt, f.crash, f.failed, f.partial, f.err = f.n+k, crash, false, partial, err
	f.ops = nil
}

func (f *faultFS) disarm() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failAt, f.crash, f.failed = 0, false, false
}

func (f *faultFS) didFail() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.failed
}

func (f *faultFS) opLog() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.ops...)
}

// hit records a mutating operation and says whether it must fail.
func (f *faultFS) hit(op string) (failing bool, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.n++
	f.ops = append(f.ops, op)
	if f.failed && f.crash {
		return false, errCrashed
	}
	if f.failAt > 0 && f.n == f.failAt {
		f.failed = true
		if f.err != nil {
			return true, f.err
		}
		return true, errInjected
	}
	return false, nil
}

func writeFlags(flag int) bool {
	return flag&(os.O_WRONLY|os.O_RDWR|os.O_CREATE|os.O_APPEND|os.O_TRUNC) != 0
}

func (f *faultFS) OpenFile(name string, flag int, perm fs.FileMode) (File, error) {
	w := writeFlags(flag)
	if w {
		if _, err := f.hit("open " + filepath.Base(name)); err != nil {
			return nil, err
		}
	}
	file, err := f.base.OpenFile(name, flag, perm)
	if err != nil {
		return nil, err
	}
	return &faultFile{File: file, fs: f, name: filepath.Base(name), writable: w}, nil
}

func (f *faultFS) ReadDir(name string) ([]fs.DirEntry, error) { return f.base.ReadDir(name) }
func (f *faultFS) Lstat(name string) (fs.FileInfo, error)     { return f.base.Lstat(name) }

func (f *faultFS) Rename(oldpath, newpath string) error {
	if _, err := f.hit("rename " + filepath.Base(newpath)); err != nil {
		return err
	}
	return f.base.Rename(oldpath, newpath)
}

func (f *faultFS) Remove(name string) error {
	if _, err := f.hit("remove " + filepath.Base(name)); err != nil {
		return err
	}
	return f.base.Remove(name)
}

func (f *faultFS) RemoveAll(name string) error {
	if _, err := f.hit("removeall " + filepath.Base(name)); err != nil {
		return err
	}
	return f.base.RemoveAll(name)
}

func (f *faultFS) SyncDir(dir string) error {
	if _, err := f.hit("syncdir " + filepath.Base(dir)); err != nil {
		return err
	}
	return f.base.SyncDir(dir)
}

type faultFile struct {
	File
	fs       *faultFS
	name     string
	writable bool
}

func (f *faultFile) Write(p []byte) (int, error) {
	failing, err := f.fs.hit("write " + f.name)
	if failing {
		n := min(max(f.fs.partial, 0), len(p))
		if n > 0 {
			if _, werr := f.File.Write(p[:n]); werr != nil {
				return 0, werr
			}
		}
		return n, err
	}
	if err != nil {
		return 0, err
	}
	return f.File.Write(p)
}

func (f *faultFile) Sync() error {
	if _, err := f.fs.hit("sync " + f.name); err != nil {
		return err
	}
	return f.File.Sync()
}

func (f *faultFile) Truncate(size int64) error {
	if _, err := f.fs.hit("truncate " + f.name); err != nil {
		return err
	}
	return f.File.Truncate(size)
}

// Close always releases the descriptor (a dead process releases it too) but reports
// the injected failure.
func (f *faultFile) Close() error {
	var err error
	if f.writable {
		_, err = f.fs.hit("close " + f.name)
	}
	cerr := f.File.Close()
	if err != nil {
		return err
	}
	return cerr
}

func tempsIn(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.Contains(d.Name(), tmpInfix) {
			out = append(out, p)
		}
		return nil
	})
	return out
}

func equalBytes(a, b []byte) bool { return bytes.Equal(a, b) }
