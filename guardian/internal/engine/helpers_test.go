package engine

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/awake"
	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// testEnv is a data directory with fakes for every dependency (§15). Nothing touches
// the system: no admin rights, no real hosts file, no network.
type testEnv struct {
	t      *testing.T
	dir    string
	clk    *FakeClock
	hosts  HostsManager
	fh     *FakeHosts
	dns    *FakeDNS
	net    *FakeNetworkTime
	anchor *store.MemAnchor
	// fs is the store's file system (default newTestFS()).
	fs    store.FS
	procs *FakeProcesses
	logon func() (time.Duration, bool)
	// platform overrides the catalog platform (default: this OS); netTime the network
	// time source (default net).
	platform catalog.Platform
	netTime  NetworkTime
	// flusher overrides the DNS flusher (default dns).
	flusher DNSFlusher
	// binary is Options.BinaryID (default "test-binary-1"); serviceManager is
	// Options.ServiceManager.
	binary         string
	serviceManager string
	// inh is the keep-awake inhibitor of every engine opened on this env (reused
	// across restarts, so Holds() is the whole history).
	inh *awake.Fake
	e   *Engine
}

var testStart = time.Date(2026, 9, 28, 10, 0, 0, 0, time.UTC)

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	clk := NewFakeClock(testStart)
	fh := NewFakeHosts()
	env := &testEnv{
		t:      t,
		dir:    filepath.Join(t.TempDir(), "centrate"),
		clk:    clk,
		hosts:  fh,
		fh:     fh,
		dns:    &FakeDNS{},
		net:    NewFakeNetworkTime(clk.Real),
		anchor: store.NewMemAnchor(),
		fs:     newTestFS(),
		procs:  &FakeProcesses{},
		inh:    awake.NewFake(nil),
	}
	return env
}

// testFS is the store's file system in the engine tests: the real files, created,
// opened, renamed over and removed like store.OSFS does, without its durability
// barriers (File.Sync, the POSIX directory fsync and MOVEFILE_WRITE_THROUGH on Windows).
//
// The engine tests never cut the power: a crash (Engine.crash) or a restart reopens the
// directory in the same process, which reads every write whether or not it reached the
// disk, so the barriers decide nothing these tests check. They do cost: with fake time
// running hours per test, the suite replaces state.json, state.prev.json and
// run/clock.json about 40 000 times (every 30 s of fake time and at every commit) and
// syncs about 42 000 files. On Windows each FlushFileBuffers and each write-through
// MoveFileEx waits milliseconds for the disk, which took the package past CI's 10-minute
// test timeout with no test stuck (the goroutine dumps stopped in MoveFileEx, in a
// different test each run); macOS pays F_FULLFSYNC on every Sync. What the barriers
// guarantee is tested where they are implemented: the store package (writeAtomic, the
// log) and the guardian e2e smoke test of the real binary.
type testFS struct{ store.FS }

func newTestFS() store.FS { return testFS{store.OSFS()} }

func (f testFS) OpenFile(name string, flag int, perm fs.FileMode) (store.File, error) {
	file, err := f.FS.OpenFile(name, flag, perm)
	if err != nil {
		return nil, err
	}
	return noSyncFile{file}, nil
}

// Rename replaces newpath atomically, like store.OSFS (renameNoFlush: testfs_*_test.go).
func (testFS) Rename(oldpath, newpath string) error { return renameNoFlush(oldpath, newpath) }

func (testFS) SyncDir(string) error { return nil }

// noSyncFile is a store.File whose Sync returns at once (see testFS).
type noSyncFile struct{ store.File }

func (noSyncFile) Sync() error { return nil }

func (env *testEnv) options() Options {
	pl := env.platform
	if pl == "" {
		pl = catalog.CurrentPlatform()
	}
	var nt NetworkTime = env.net
	if env.netTime != nil {
		nt = env.netTime
	}
	var fl DNSFlusher = env.dns
	if env.flusher != nil {
		fl = env.flusher
	}
	bin := env.binary
	if bin == "" {
		bin = "test-binary-1"
	}
	return Options{
		BinaryID:            bin,
		ServiceManager:      env.serviceManager,
		DataDir:             env.dir,
		Clock:               env.clk,
		Hosts:               env.hosts,
		DNS:                 fl,
		NetworkTime:         nt,
		ProcessLister:       env.procs,
		ProcessKiller:       env.procs,
		ProcessInterval:     10 * time.Millisecond,
		Anchor:              env.anchor,
		StoreFS:             env.fs,
		Platform:            pl,
		Version:             "0.1.0-test",
		HostsPath:           "/etc/hosts",
		HostsPathRedirected: func() bool { return false },
		DetectTimezone:      func() string { return "Europe/Madrid" },
		LogonBoot:           env.logon,
		DisableWatchers:     true,
		NewInhibitor: func(onChange func()) awake.Inhibitor {
			env.inh.SetOnChange(onChange)
			env.inh.Reopen()
			return env.inh
		},
	}
}

// open creates and opens an Engine on the directory (closing it at the end of the test).
func (env *testEnv) open() *Engine {
	env.t.Helper()
	e, err := New(env.options())
	if err != nil {
		env.t.Fatalf("New: %v", err)
	}
	if err := e.Open(); err != nil {
		env.t.Fatalf("Open: %v", err)
	}
	env.e = e
	env.t.Cleanup(func() { _ = e.Stop() })
	return e
}

// restart stops the engine cleanly and opens a new one on the same directory.
func (env *testEnv) restart() *Engine {
	env.t.Helper()
	if err := env.e.Stop(); err != nil {
		env.t.Fatalf("Stop: %v", err)
	}
	return env.open()
}

// shutdown stops the engine the way an OS shutdown does (the service manager's shutdown
// notice: the planned-stop marker «shutdown», then the clean stop), before a reboot.
func (env *testEnv) shutdown() {
	env.t.Helper()
	if err := env.e.Shutdown(bg); err != nil {
		env.t.Fatalf("Shutdown: %v", err)
	}
}

// advance moves real time with the machine awake, one engine tick every 2 s.
func (env *testEnv) advance(d time.Duration) {
	env.t.Helper()
	for d > 0 {
		s := min(tickInterval, d)
		env.clk.Advance(s)
		d -= s
		env.e.Step()
	}
}

var bg = context.Background()

func durationReq(mode string, minutes int64, services ...string) CreateBlockRequest {
	t := emptyTargets()
	t.ServiceIDs = services
	return CreateBlockRequest{
		Targets: t, Allow: emptyAllow(), Mode: mode, DurationMinutes: &minutes,
		AcknowledgeLong: minutes > 240, AcknowledgeNoEmergency: mode == ModeHardcore || mode == ModeExam,
	}
}

func (env *testEnv) create(req CreateBlockRequest) Block {
	env.t.Helper()
	res, err := env.e.CreateBlock(bg, Request{Scope: "app"}, req)
	if err != nil {
		env.t.Fatalf("CreateBlock: %v", err)
	}
	return res.Block
}

// events returns every committed event of the current epoch.
func (env *testEnv) events() []store.Event {
	env.t.Helper()
	var out []store.Event
	var after int64
	for {
		page, err := env.e.st.ReadEvents(env.e.st.Epoch(), after, 1000)
		if err != nil {
			env.t.Fatalf("ReadEvents: %v", err)
		}
		out = append(out, page.Events...)
		if !page.HasMore {
			return out
		}
		after = page.LastSeq
	}
}

// eventsOf returns the events of one type.
func (env *testEnv) eventsOf(typ string) []store.Event {
	var out []store.Event
	for _, ev := range env.events() {
		if ev.Type == typ {
			out = append(out, ev)
		}
	}
	return out
}

func mustDecode[T any](t *testing.T, ev store.Event) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(ev.Data, &v); err != nil {
		t.Fatalf("decode %s: %v", ev.Type, err)
	}
	return v
}

func (env *testEnv) state() GuardianStateResponse {
	env.t.Helper()
	s, err := env.e.State(bg)
	if err != nil {
		env.t.Fatalf("State: %v", err)
	}
	return s
}

func apiCode(err error) string {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae.Code
	}
	return ""
}

func apiDetails(err error) map[string]any {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae.Details
	}
	return nil
}

// faultFS wraps the real file system and makes appends to event segments and writes of
// state.json and run/clock.json fail on demand; it records the order of durable
// operations (appends and state writes).
type faultFS struct {
	store.FS
	mu          sync.Mutex
	failAppend  bool
	failState   bool
	failClock   bool
	ops         []string
	recordOrder bool
}

// setFailSnapshots makes the writes of state.json and run/clock.json fail (a crash
// between the append and the end of the turn, as far as the next start can tell).
func (f *faultFS) setFailSnapshots(v bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failState, f.failClock = v, v
}

func newFaultFS() *faultFS { return &faultFS{FS: newTestFS()} }

func (f *faultFS) setFailAppend(v bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failAppend = v
}

func (f *faultFS) record(op string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.recordOrder {
		f.ops = append(f.ops, op)
	}
}

func (f *faultFS) takeOps() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	ops := f.ops
	f.ops = nil
	return ops
}

func (f *faultFS) OpenFile(name string, flag int, perm fs.FileMode) (store.File, error) {
	file, err := f.FS.OpenFile(name, flag, perm)
	if err != nil {
		return nil, err
	}
	slash := filepath.ToSlash(name)
	switch {
	case strings.Contains(slash, "/events/") && strings.HasSuffix(slash, ".jsonl"):
		return &faultFile{File: file, fs: f, kind: "append"}, nil
	case strings.Contains(filepath.Base(name), "state.json"):
		return &faultFile{File: file, fs: f, kind: "state"}, nil
	case strings.Contains(filepath.Base(name), "clock.json"):
		return &faultFile{File: file, fs: f, kind: "clock"}, nil
	}
	return file, nil
}

type faultFile struct {
	store.File
	fs   *faultFS
	kind string
}

var errInjected = errors.New("injected I/O failure")

func (f *faultFile) Write(p []byte) (int, error) {
	f.fs.mu.Lock()
	fail := (f.kind == "append" && f.fs.failAppend) || (f.kind == "state" && f.fs.failState) ||
		(f.kind == "clock" && f.fs.failClock)
	f.fs.mu.Unlock()
	if fail {
		return 0, errInjected
	}
	if f.kind != "clock" {
		f.fs.record(f.kind)
	}
	return f.File.Write(p)
}

// crash simulates a crash for tests: the loop and watchers stop and the store is
// closed without saving state or writing the clean-shutdown marker.
func (e *Engine) crash() {
	e.lifeMu.Lock()
	e.stopped = true
	cancel := e.cancel
	e.lifeMu.Unlock()
	if cancel != nil {
		cancel()
	}
	e.wg.Wait()
	if e.st != nil {
		_ = e.st.Close()
	}
}
