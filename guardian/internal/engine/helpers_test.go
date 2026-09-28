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
	fs     store.FS
	procs  *FakeProcesses
	logon  func() (time.Duration, bool)
	e      *Engine
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
		procs:  &FakeProcesses{},
	}
	return env
}

func (env *testEnv) options() Options {
	return Options{
		DataDir:             env.dir,
		Clock:               env.clk,
		Hosts:               env.hosts,
		DNS:                 env.dns,
		NetworkTime:         env.net,
		ProcessLister:       env.procs,
		ProcessKiller:       env.procs,
		ProcessInterval:     10 * time.Millisecond,
		Anchor:              env.anchor,
		StoreFS:             env.fs,
		Platform:            catalog.CurrentPlatform(),
		Version:             "0.1.0-test",
		HostsPath:           "/etc/hosts",
		HostsPathRedirected: func() bool { return false },
		DetectTimezone:      func() string { return "Europe/Madrid" },
		LogonBoot:           env.logon,
		DisableWatchers:     true,
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
// state.json fail on demand; it records the order of durable operations.
type faultFS struct {
	store.FS
	mu          sync.Mutex
	failAppend  bool
	failState   bool
	ops         []string
	recordOrder bool
}

func newFaultFS() *faultFS { return &faultFS{FS: store.OSFS()} }

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
	fail := (f.kind == "append" && f.fs.failAppend) || (f.kind == "state" && f.fs.failState)
	f.fs.mu.Unlock()
	if fail {
		return 0, errInjected
	}
	f.fs.record(f.kind)
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
