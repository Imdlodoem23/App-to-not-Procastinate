package daemon

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/api"
	"github.com/imdlodoem23/centrate/guardian/internal/engine"
	"github.com/imdlodoem23/centrate/guardian/internal/hosts"
	"github.com/imdlodoem23/centrate/guardian/internal/platform"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

var testStart = time.Date(2026, 9, 28, 8, 0, 0, 0, time.UTC)

// testOptions runs the daemon on temporary files with the engine's fakes.
func testOptions(t *testing.T, dir string, clk *engine.FakeClock, anchor store.AnchorStore) Options {
	t.Helper()
	hostsPath := filepath.Join(filepath.Dir(dir), "hosts")
	if _, err := os.Stat(hostsPath); err != nil {
		if err := os.WriteFile(hostsPath, []byte("127.0.0.1 localhost\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	procs := &engine.FakeProcesses{}
	return Options{
		DataDir:        dir,
		HostsPath:      hostsPath,
		Clock:          clk,
		NetworkTime:    engine.NewFakeNetworkTime(clk.Real),
		ProcessLister:  procs,
		ProcessKiller:  procs,
		Anchor:         anchor,
		DetectTimezone: func() string { return "Europe/Madrid" },
		ShuttingDown:   func() bool { return false },
		Listen: func(ctx context.Context, _ string) (net.Listener, error) {
			var lc net.ListenConfig
			return lc.Listen(ctx, "tcp4", "127.0.0.1:0")
		},
	}
}

func waitBound(t *testing.T, r *Runner) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return r.WaitBound(ctx)
}

func TestRunnerStartsEngineThenAPI(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "centrate")
	clk := engine.NewFakeClock(testStart)
	r := New(testOptions(t, dir, clk, store.NewMemAnchor()))
	if r.Engine() != nil || r.Server() != nil || r.Addr() != nil {
		t.Fatal("New must not build anything")
	}
	if err := r.Stop(); err != nil { // before Start: nothing to do
		t.Fatal(err)
	}
	r = New(testOptions(t, dir, clk, store.NewMemAnchor()))
	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(context.Background()); err == nil {
		t.Fatal("a second Start must fail")
	}
	if err := waitBound(t, r); err != nil {
		t.Fatal(err)
	}
	// The API opened only after the ladder: the engine is ready and client.json exists.
	select {
	case <-r.Engine().Ready():
	default:
		t.Fatal("API open before the engine was ready")
	}
	if r.Engine().OpenErr() != nil {
		t.Fatal(r.Engine().OpenErr())
	}
	if _, err := os.Stat(filepath.Join(dir, api.ClientFileName)); err != nil {
		t.Fatalf("client.json: %v", err)
	}
	if err := r.Stop(); err != nil {
		t.Fatal(err)
	}
	if err := r.Stop(); err != nil { // twice is fine
		t.Fatal(err)
	}
	// A clean stop leaves the clean-shutdown marker and the clock snapshot (§13).
	for _, name := range []string{"clean-shutdown", "clock.json"} {
		if _, err := os.Stat(filepath.Join(dir, "run", name)); err != nil {
			t.Fatalf("run/%s after a clean stop: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "run", "planned-stop")); err == nil {
		t.Fatal("a plain stop wrote the planned-stop marker")
	}
}

func TestShutdownWritesPlannedStop(t *testing.T) {
	for _, tc := range []struct {
		name string
		stop func(r *Runner) error
		opts func(*Options)
	}{
		{"windows shutdown", func(r *Runner) error { return r.Shutdown(context.Background()) }, nil},
		{"unix stop during a shutdown", (*Runner).Stop, func(o *Options) { o.ShuttingDown = func() bool { return true } }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "centrate")
			o := testOptions(t, dir, engine.NewFakeClock(testStart), store.NewMemAnchor())
			if tc.opts != nil {
				tc.opts(&o)
			}
			r := New(o)
			if err := r.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			if err := waitBound(t, r); err != nil {
				t.Fatal(err)
			}
			if err := tc.stop(r); err != nil {
				t.Fatal(err)
			}
			raw, err := os.ReadFile(filepath.Join(dir, "run", "planned-stop"))
			if err != nil || !strings.Contains(string(raw), `"reason":"shutdown"`) {
				t.Fatalf("planned-stop = %q, %v", raw, err)
			}
			if _, err := os.Stat(filepath.Join(dir, "run", "clean-shutdown")); err != nil {
				t.Fatalf("a shutdown must still stop cleanly: %v", err)
			}
		})
	}
}

func TestStartupFailureIsFatal(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "centrate")
	clk := engine.NewFakeClock(testStart)
	anchor := store.NewMemAnchor()
	first := New(testOptions(t, dir, clk, anchor))
	if err := first.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = first.Stop() }()
	if err := waitBound(t, first); err != nil {
		t.Fatal(err)
	}
	// A second guardian on the same folder cannot take the lock (§10.12 step 1).
	var mu sync.Mutex
	var fatal error
	o := testOptions(t, dir, clk, anchor)
	o.OnFatal = func(err error) {
		mu.Lock()
		defer mu.Unlock()
		fatal = err
	}
	second := New(o)
	if err := second.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	err := waitBound(t, second)
	if err == nil || !errors.Is(err, store.ErrLocked) {
		t.Fatalf("WaitBound = %v, want the lock error", err)
	}
	mu.Lock()
	got := fatal
	mu.Unlock()
	if !errors.Is(got, store.ErrLocked) {
		t.Fatalf("OnFatal got %v", got)
	}
	if second.Addr() != nil {
		t.Fatal("the API opened although the guardian did not start")
	}
	if err := second.Stop(); err != nil {
		t.Fatal(err)
	}
}

func TestFakeClockRoundTrip(t *testing.T) {
	c := engine.NewFakeClock(testStart)
	check := func(step string) {
		t.Helper()
		got, err := restoreFakeClock(snapshotFakeClock(c))
		if err != nil {
			t.Fatalf("%s: %v", step, err)
		}
		gid, _ := got.BootID()
		wid, _ := c.BootID()
		if !got.Wall().Equal(c.Wall()) || got.Boot() != c.Boot() || got.Awake() != c.Awake() || gid != wid || !got.Real().Equal(c.Real()) {
			t.Fatalf("%s: restored wall %s boot %s awake %s id %s real %s; want %s %s %s %s %s", step,
				got.Wall(), got.Boot(), got.Awake(), gid, got.Real(), c.Wall(), c.Boot(), c.Awake(), wid, c.Real())
		}
	}
	check("new")
	c.Advance(90 * time.Minute)
	check("advance")
	c.Suspend(7 * time.Hour)
	check("suspend")
	c.JumpWall(-3 * time.Hour)
	check("jump back")
	c.RebootAfter(time.Hour)
	check("reboot")
	c.Advance(time.Minute)
	c.JumpWall(26 * time.Hour)
	c.Suspend(time.Second)
	check("second boot")
	c.Reboot()
	check("third boot")

	// Through the file: a missing file starts at now, a saved one resumes.
	path := filepath.Join(t.TempDir(), fakeClockFileName)
	fc, err := openFakeClock(path, testStart)
	if err != nil || !fc.clock.Wall().Equal(testStart) {
		t.Fatalf("fresh = %v, %v", fc, err)
	}
	fc.clock.Advance(45 * time.Minute)
	fc.clock.JumpWall(time.Hour)
	if err := fc.save(); err != nil {
		t.Fatal(err)
	}
	again, err := openFakeClock(path, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !again.clock.Wall().Equal(testStart.Add(105*time.Minute)) || !again.clock.Real().Equal(testStart.Add(45*time.Minute)) {
		t.Fatalf("resumed wall %s real %s", again.clock.Wall(), again.clock.Real())
	}
	if err := os.WriteFile(path, []byte(`{"v":1,"wall":"x"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := openFakeClock(path, time.Now()); err == nil {
		t.Fatal("a damaged clock file must fail")
	}
}

func TestSystemdStopping(t *testing.T) {
	for out, want := range map[string]bool{
		"stopping\n": true, "stopping": true, "running\n": false, "degraded\n": false,
		"": false, "starting\n": false, "stopping-ish\n": false,
	} {
		if got := systemdStopping([]byte(out)); got != want {
			t.Errorf("systemdStopping(%q) = %v", out, got)
		}
	}
}

func TestPurgeHandler(t *testing.T) {
	n := 0
	o := Options{Logger: slog.New(slog.DiscardHandler), PurgeLogs: func() error { n++; return nil }}.withDefaults()
	for _, l := range []*slog.Logger{o.Logger, o.Logger.With("k", 1), o.Logger.WithGroup("g")} {
		p, ok := l.Handler().(engine.LogPurger)
		if !ok {
			t.Fatalf("%T does not purge", l.Handler())
		}
		if err := p.PurgeLogs(); err != nil {
			t.Fatal(err)
		}
	}
	if n != 3 {
		t.Fatalf("purges = %d", n)
	}
	if _, ok := (Options{}).withDefaults().Logger.Handler().(engine.LogPurger); ok {
		t.Fatal("without PurgeLogs the logs are kept")
	}
}

func TestScrubBackups(t *testing.T) {
	base := t.TempDir()
	path := filepath.Join(base, "hosts")
	backups := filepath.Join(base, "backups")
	const user = "127.0.0.1 localhost\n"
	if err := os.WriteFile(path, []byte(user), 0o644); err != nil {
		t.Fatal(err)
	}
	// A section left by an earlier run, then edits by the user: the backups taken
	// before our writes hold the section.
	if err := (&hosts.Manager{Path: path}).Apply([]string{"youtube.com"}); err != nil {
		t.Fatal(err)
	}
	h := &hostsLayer{Manager: &hosts.Manager{Path: path, BackupDir: backups}}
	if err := h.Apply([]string{"tiktok.com"}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(h.BackupPath(0))
	if err != nil || !strings.Contains(string(raw), "youtube.com") {
		t.Fatalf("setup: backup = %q, %v", raw, err)
	}
	if err := h.ScrubBackups(); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(h.BackupPath(0))
	if string(raw) != user {
		t.Fatalf("scrubbed backup = %q, want %q", raw, user)
	}
	// The live section is not touched (the engine re-renders it).
	if live, _ := h.Current(); len(live) != 1 || live[0] != "tiktok.com" {
		t.Fatalf("live section = %v", live)
	}
	if err := h.ScrubBackups(); err != nil { // twice is fine
		t.Fatal(err)
	}
}

func TestDefaultFlusherOnlyForTheSystemHostsFile(t *testing.T) {
	test := filepath.Join(t.TempDir(), "hosts")
	f := defaultFlusher(func() string { return test }, slog.New(slog.DiscardHandler))
	if err := f.FlushDNS(context.Background()); err != nil {
		t.Fatalf("a test hosts file must never flush the system resolver: %v", err)
	}
}

// The flusher decides at every flush: the hosts file the guardian manages can move to
// or away from the system one while it runs (DataBasePath, §10.10).
func TestFlusherFollowsTheHostsPath(t *testing.T) {
	system, other := filepath.FromSlash("/etc/hosts"), filepath.FromSlash("/srv/hosts")
	cur, sys := other, system
	flushes := 0
	f := pathFlusher(func() string { return cur }, func() string { return sys },
		func(context.Context) error { flushes++; return nil })
	ctx := context.Background()
	_ = f.FlushDNS(ctx)
	if flushes != 0 {
		t.Fatal("flushed for a file that is not the system hosts file")
	}
	cur = system
	_ = f.FlushDNS(ctx)
	if flushes != 1 {
		t.Fatal("did not flush once the managed file became the system hosts file")
	}
	sys = other // the system moved its hosts file under the guardian
	_ = f.FlushDNS(ctx)
	if flushes != 1 {
		t.Fatal("flushed although the system hosts file moved elsewhere")
	}
}

// A defaulted hosts path is resolved again while the guardian runs (Windows
// DataBasePath, §10.10): the default layer writes the file platform.HostsPath names now,
// not the one it named at start. An explicit path stays put.
func TestDefaultHostsLayerFollowsTheHostsPath(t *testing.T) {
	dir := t.TempDir()
	first, second := filepath.Join(dir, "hosts-a"), filepath.Join(dir, "hosts-b")
	for _, p := range []string{first, second} {
		if err := os.WriteFile(p, []byte("127.0.0.1 localhost\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv(platform.EnvHostsPath, first)
	o := Options{DataDir: filepath.Join(dir, "centrate")}.withDefaults()
	m := o.hostsManager()
	if m.Resolve == nil {
		t.Fatal("the default hosts layer does not follow platform.HostsPath")
	}
	m.ResolveEvery = time.Nanosecond
	if got := m.CurrentPath(); got != first {
		t.Fatalf("CurrentPath = %q, want %q", got, first)
	}
	if err := m.Apply([]string{"youtube.com"}); err != nil {
		t.Fatal(err)
	}
	t.Setenv(platform.EnvHostsPath, second)
	deadline := time.Now().Add(5 * time.Second)
	for m.CurrentPath() != second {
		if time.Now().After(deadline) {
			t.Fatalf("CurrentPath stayed %q after the hosts path moved", m.CurrentPath())
		}
		time.Sleep(time.Millisecond)
	}
	if err := m.Apply([]string{"youtube.com"}); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(second); !strings.Contains(string(raw), "youtube.com") {
		t.Fatalf("the new hosts file was not enforced: %q", raw)
	}
	// The DNS flusher follows the same file.
	if got := currentHostsPath(&hostsLayer{Manager: m}, "")(); got != second {
		t.Fatalf("flusher path = %q", got)
	}

	fixed := Options{DataDir: o.DataDir, HostsPath: first}.withDefaults().hostsManager()
	if fixed.Resolve != nil || fixed.CurrentPath() != first {
		t.Fatalf("an explicit HostsPath must never be re-resolved: %q", fixed.CurrentPath())
	}
	if got := currentHostsPath(engine.NewFakeHosts(), first)(); got != first {
		t.Fatalf("a layer without CurrentPath: %q", got)
	}
}
