package procwatch

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var watchT0 = time.Date(2026, time.September, 27, 10, 0, 0, 0, time.UTC)

type fakeTicker struct {
	c       chan time.Time
	stopped atomic.Bool
}

func (f *fakeTicker) C() <-chan time.Time { return f.c }
func (f *fakeTicker) Stop()               { f.stopped.Store(true) }

// syncBuffer is a goroutine-safe log sink.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type killCall struct {
	PID  int
	Name string
}

// harness runs a Watcher against fakes in lockstep: start and step return only
// after a scan has completed, and Run is then parked waiting for the ticker,
// so the test can change the fakes between scans without races.
type harness struct {
	t        *testing.T
	w        *Watcher
	ticker   *fakeTicker
	interval time.Duration
	log      *syncBuffer
	scans    chan struct{}

	mu       sync.Mutex
	procs    []Process
	listErr  error
	listN    int
	killErr  map[int]error
	kills    []killCall
	events   []Killed
	targetsN int
	onKilled func(Killed) // replaces the recording callback when set

	cancel context.CancelFunc
	done   chan struct{}
}

func newHarness(t *testing.T) *harness {
	h := &harness{
		t:       t,
		ticker:  &fakeTicker{c: make(chan time.Time)},
		log:     &syncBuffer{},
		scans:   make(chan struct{}, 100),
		killErr: map[int]error{},
	}
	h.w = &Watcher{
		Lister: ListerFunc(func() ([]Process, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.listN++
			return append([]Process(nil), h.procs...), h.listErr
		}),
		Killer: KillerFunc(func(pid int, name string) error {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.kills = append(h.kills, killCall{pid, name})
			return h.killErr[pid]
		}),
		Logger: slog.New(slog.NewTextHandler(h.log, nil)),
		Now:    func() time.Time { return watchT0 },
		NewTicker: func(d time.Duration) Ticker {
			h.interval = d
			return h.ticker
		},
		scanned: func() { h.scans <- struct{}{} },
	}
	return h
}

// run starts Run with the given arguments and waits for the initial scan.
func (h *harness) run(targets func() Matcher, onKilled func(Killed)) {
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel, h.done = cancel, make(chan struct{})
	go func() {
		defer close(h.done)
		h.w.Run(ctx, targets, onKilled)
	}()
	h.t.Cleanup(h.stop)
	h.waitScan()
}

// start runs with counting targets and a recording callback.
func (h *harness) start(targets func() Matcher) {
	h.run(func() Matcher {
		h.mu.Lock()
		h.targetsN++
		h.mu.Unlock()
		if targets == nil {
			return Matcher{}
		}
		return targets()
	}, func(k Killed) {
		h.mu.Lock()
		cb := h.onKilled
		if cb == nil {
			h.events = append(h.events, k)
		}
		h.mu.Unlock()
		if cb != nil {
			cb(k)
		}
	})
}

func (h *harness) waitScan() {
	h.t.Helper()
	select {
	case <-h.scans:
	case <-time.After(10 * time.Second):
		h.t.Fatal("no scan completed")
	}
}

// step sends n ticks, waiting for each scan to complete.
func (h *harness) step(n int) {
	h.t.Helper()
	for i := 0; i < n; i++ {
		select {
		case h.ticker.c <- watchT0:
		case <-time.After(10 * time.Second):
			h.t.Fatal("watcher did not take the tick")
		}
		h.waitScan()
	}
}

// stop cancels Run and waits for it to return.
func (h *harness) stop() {
	if h.cancel == nil {
		return
	}
	h.cancel()
	select {
	case <-h.done:
	case <-time.After(10 * time.Second):
		h.t.Fatal("Run did not return after cancel")
	}
}

func (h *harness) set(f func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	f()
}

func sortedKills(k []killCall) []killCall {
	out := append([]killCall(nil), k...)
	sort.Slice(out, func(i, j int) bool { return out[i].PID < out[j].PID })
	return out
}

func TestWatcherEmptyTargetsDoesNotList(t *testing.T) {
	h := newHarness(t)
	h.procs = []Process{{PID: 100, Name: "Discord.exe"}}
	h.start(nil)
	h.step(3)
	h.stop()
	if h.targetsN != 4 {
		t.Errorf("targets called %d times, want 4 (initial scan + 3 ticks)", h.targetsN)
	}
	if h.listN != 0 || len(h.kills) != 0 {
		t.Errorf("listed %d times and killed %v with no targets", h.listN, h.kills)
	}
}

func TestWatcherKillsMatches(t *testing.T) {
	h := newHarness(t)
	h.procs = []Process{
		{PID: 100, Name: "Discord.exe", Path: `C:\Users\ana\AppData\Local\Discord\app-1.0\Discord.exe`},
		{PID: 101, Name: "explorer.exe"},
		{PID: 102, Name: "chrome.exe"},
		{PID: 103, Name: "discord.exe"},
		{PID: 104, Name: "Steam.exe"},
		{PID: 104, Name: "Steam.exe"}, // duplicate row: killed once
		{PID: 4, Name: "Discord.exe"},
	}
	m := NewMatcherFor("windows", []string{"Discord", "steam.exe", "explorer.exe"})
	h.start(func() Matcher { return m })
	h.stop()

	wantKills := []killCall{{100, "Discord.exe"}, {103, "discord.exe"}, {104, "Steam.exe"}}
	if got := sortedKills(h.kills); !reflect.DeepEqual(got, wantKills) {
		t.Errorf("kills = %v, want %v", got, wantKills)
	}
	// One report per target: both Discord processes go together.
	wantEvents := []Killed{
		{Target: "Discord", Name: "Discord.exe", Path: `C:\Users\ana\AppData\Local\Discord\app-1.0\Discord.exe`, PIDs: []int{100, 103}, At: watchT0},
		{Target: "steam.exe", Name: "Steam.exe", PIDs: []int{104}, At: watchT0},
	}
	if !reflect.DeepEqual(h.events, wantEvents) {
		t.Errorf("events = %+v\nwant %+v", h.events, wantEvents)
	}
	if h.interval != DefaultInterval {
		t.Errorf("ticker interval = %v, want %v", h.interval, DefaultInterval)
	}
	if !h.ticker.stopped.Load() {
		t.Error("ticker not stopped")
	}
}

func TestWatcherIntervalOverride(t *testing.T) {
	h := newHarness(t)
	h.w.Interval = 2 * time.Second
	h.start(nil)
	h.stop()
	if h.interval != 2*time.Second {
		t.Errorf("ticker interval = %v, want 2s", h.interval)
	}
}

func TestWatcherDoesNotReportGoneOrReused(t *testing.T) {
	h := newHarness(t)
	h.procs = []Process{{PID: 100, Name: "Discord"}, {PID: 101, Name: "Discord"}, {PID: 102, Name: "Discord"}}
	h.killErr[100] = ErrNotFound
	h.killErr[101] = fmt.Errorf("wrapped: %w", ErrNameMismatch)
	m := NewMatcherFor("linux", []string{"Discord"})
	h.start(func() Matcher { return m })
	h.stop()
	if len(h.kills) != 3 {
		t.Fatalf("kills = %v", h.kills)
	}
	if len(h.events) != 1 || !reflect.DeepEqual(h.events[0].PIDs, []int{102}) {
		t.Errorf("events = %+v, want only PID 102", h.events)
	}
	if s := h.log.String(); s != "" {
		t.Errorf("unexpected log output: %s", s)
	}
}

func TestWatcherLogsKillErrorsOnceWithoutNames(t *testing.T) {
	h := newHarness(t)
	h.procs = []Process{{PID: 100, Name: "SecretGame"}}
	h.killErr[100] = errors.New("access denied")
	m := NewMatcherFor("linux", []string{"SecretGame"})
	h.start(func() Matcher { return m }) // scan 1 logs
	h.step(2)                            // scans 2 and 3 do not repeat it
	h.set(func() { h.procs = nil })
	h.step(1) // scan 4: it exited, the failure is forgotten
	h.set(func() { h.procs = []Process{{PID: 100, Name: "SecretGame"}} })
	h.step(1) // scan 5 logs again
	h.stop()

	logs := h.log.String()
	if n := strings.Count(logs, "could not close a blocked process"); n != 2 {
		t.Errorf("logged the kill failure %d times, want 2:\n%s", n, logs)
	}
	if !strings.Contains(logs, "pid=100") || !strings.Contains(logs, "access denied") {
		t.Errorf("log lacks PID or error:\n%s", logs)
	}
	if strings.Contains(logs, "SecretGame") {
		t.Errorf("log contains a process name:\n%s", logs)
	}
	if len(h.kills) != 4 || len(h.events) != 0 {
		t.Errorf("kills = %v, events = %+v", h.kills, h.events)
	}
}

func TestWatcherListErrorsAreLoggedAndRecovered(t *testing.T) {
	h := newHarness(t)
	h.listErr = errors.New("snapshot failed")
	h.procs = []Process{{PID: 100, Name: "steam"}}
	m := NewMatcherFor("linux", []string{"steam"})
	h.start(func() Matcher { return m }) // scan 1 logs
	h.step(1)                            // scan 2: same error, silent
	h.set(func() { h.listErr = nil })
	h.step(1) // scan 3: recovered, kills
	h.stop()

	logs := h.log.String()
	if n := strings.Count(logs, "listing processes failed"); n != 1 {
		t.Errorf("listing failure logged %d times, want 1:\n%s", n, logs)
	}
	if n := strings.Count(logs, "listing processes works again"); n != 1 {
		t.Errorf("recovery logged %d times, want 1:\n%s", n, logs)
	}
	if h.listN != 3 || len(h.events) != 1 {
		t.Errorf("listN = %d, events = %+v", h.listN, h.events)
	}
}

func TestWatcherTargetsChangeBetweenScans(t *testing.T) {
	h := newHarness(t)
	h.procs = []Process{{PID: 100, Name: "Discord"}, {PID: 200, Name: "steam"}}
	var current atomic.Value
	current.Store(Matcher{})
	h.start(func() Matcher { return current.Load().(Matcher) })
	h.step(1)
	current.Store(NewMatcherFor("linux", []string{"steam"}))
	h.step(1)
	h.stop()
	if h.listN != 1 || !reflect.DeepEqual(h.kills, []killCall{{200, "steam"}}) {
		t.Errorf("kills = %v (listN %d), want only steam in the third scan", h.kills, h.listN)
	}
}

func TestWatcherSurvivesPanics(t *testing.T) {
	h := newHarness(t)
	var listCalls atomic.Int32
	h.w.Lister = ListerFunc(func() ([]Process, error) {
		if listCalls.Add(1) == 1 {
			panic("lister exploded with a secret name")
		}
		return []Process{{PID: 100, Name: "Discord"}, {PID: 101, Name: "Discord"}}, nil
	})
	h.w.Killer = KillerFunc(func(pid int, name string) error {
		if pid == 100 {
			var m map[string]int
			m["boom"]++ // runtime panic
		}
		return nil
	})
	var reported atomic.Int32
	h.onKilled = func(Killed) {
		reported.Add(1)
		panic(errors.New("onKilled failed"))
	}
	m := NewMatcherFor("linux", []string{"Discord"})
	h.start(func() Matcher { return m }) // scan 1: the lister panics
	h.step(2)                            // scans 2 and 3: the killer and onKilled panic
	h.stop()

	logs := h.log.String()
	if !strings.Contains(logs, "recovered from panic") || !strings.Contains(logs, "killer panicked") {
		t.Errorf("panics not logged:\n%s", logs)
	}
	if strings.Contains(logs, "secret name") {
		t.Errorf("panic message echoed in logs:\n%s", logs)
	}
	if reported.Load() != 2 {
		t.Errorf("onKilled called %d times, want 2 (PID 101 in scans 2 and 3)", reported.Load())
	}
}

func TestWatcherPoke(t *testing.T) {
	h := newHarness(t)
	h.start(nil)
	h.w.Poke()
	h.waitScan()
	h.stop()
	if h.targetsN != 2 {
		t.Errorf("targets called %d times, want 2", h.targetsN)
	}
	// Pokes on a stopped watcher, several in a row or on a new one never block.
	h.w.Poke()
	h.w.Poke()
	(&Watcher{}).Poke()
}

func TestWatcherStopsWhenContextIsDone(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.w.Run(ctx, func() Matcher { return NewMatcherFor("linux", []string{"steam"}) }, nil)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Run ignored a cancelled context")
	}
	if h.listN != 0 {
		t.Errorf("listed %d times after cancel", h.listN)
	}
}

func TestWatcherNilTargetsAndCallback(t *testing.T) {
	h := newHarness(t)
	h.procs = []Process{{PID: 100, Name: "steam"}}
	h.run(nil, nil)
	h.step(1)
	h.stop()
	if h.listN != 0 {
		t.Errorf("nil targets listed %d times", h.listN)
	}

	h2 := newHarness(t)
	h2.procs = []Process{{PID: 100, Name: "steam"}}
	m := NewMatcherFor("linux", []string{"steam"})
	h2.run(func() Matcher { return m }, nil)
	h2.stop()
	if len(h2.kills) != 1 {
		t.Errorf("kills = %v with a nil onKilled", h2.kills)
	}
}

func TestWatcherKillsInParallelBounded(t *testing.T) {
	h := newHarness(t)
	const n = 20
	for i := 0; i < n; i++ {
		h.procs = append(h.procs, Process{PID: 1000 + i, Name: "steam"})
	}
	var active, peak atomic.Int32
	h.w.Killer = KillerFunc(func(pid int, name string) error {
		cur := active.Add(1)
		for {
			p := peak.Load()
			if cur <= p || peak.CompareAndSwap(p, cur) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		active.Add(-1)
		return nil
	})
	m := NewMatcherFor("linux", []string{"steam"})
	h.start(func() Matcher { return m })
	h.stop()
	if len(h.events) != 1 || len(h.events[0].PIDs) != n {
		t.Fatalf("events = %+v, want one report with %d PIDs", h.events, n)
	}
	for i, pid := range h.events[0].PIDs {
		if pid != 1000+i {
			t.Fatalf("PIDs out of listing order: %v", h.events[0].PIDs)
		}
	}
	if p := peak.Load(); p < 2 || p > maxParallelKills {
		t.Errorf("peak parallel kills = %d, want 2..%d", p, maxParallelKills)
	}
}

func TestWatcherDefaults(t *testing.T) {
	// A zero Watcher uses the OS lister and killer; with no targets it never
	// touches them, so this is safe on any machine.
	w := &Watcher{scanned: func() {}}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	w.Run(ctx, func() Matcher { return Matcher{} }, nil)
}

// TestWatcherReportsOneLaunchOnce: an Electron app's main process and its
// three helpers (same executable) are one report, not four.
func TestWatcherReportsOneLaunchOnce(t *testing.T) {
	h := newHarness(t)
	h.procs = []Process{
		{PID: 1, Name: "systemd"},
		{PID: 500, PPID: 1, Name: "Discord", Path: "/opt/discord/Discord"},
		{PID: 501, PPID: 500, Name: "Discord", Path: "/opt/discord/Discord"},
		{PID: 502, PPID: 500, Name: "Discord", Path: "/opt/discord/Discord"},
		{PID: 503, PPID: 501, Name: "Discord", Path: "/opt/discord/Discord"},
	}
	m := NewMatcherFor("linux", []string{"Discord"})
	h.start(func() Matcher { return m })
	h.stop()
	if len(h.kills) != 4 {
		t.Errorf("kills = %v, want the 4 Discord processes", h.kills)
	}
	want := []Killed{{Target: "Discord", Name: "Discord", Path: "/opt/discord/Discord", PIDs: []int{500, 501, 502, 503}, At: watchT0}}
	if !reflect.DeepEqual(h.events, want) {
		t.Errorf("events = %+v\nwant %+v", h.events, want)
	}
}

// TestWatcherFoldsChildrenOfOtherTargets: a game started by a blocked
// launcher counts for the launcher; the same game started on its own is a
// report of its own.
func TestWatcherFoldsChildrenOfOtherTargets(t *testing.T) {
	h := newHarness(t)
	h.procs = []Process{
		{PID: 10, PPID: 1, Name: "steam"},
		{PID: 11, PPID: 10, Name: "hl2_linux"},
		{PID: 12, PPID: 11, Name: "hl2_linux"},
		{PID: 20, PPID: 1, Name: "hl2_linux"},
		{PID: 30, PPID: 1, Name: "lutris"},
	}
	m := NewMatcherFor("linux", []string{"steam", "hl2_linux", "lutris"})
	h.start(func() Matcher { return m })
	h.stop()
	want := []Killed{
		{Target: "steam", Name: "steam", PIDs: []int{10, 11, 12}, At: watchT0},
		{Target: "hl2_linux", Name: "hl2_linux", PIDs: []int{20}, At: watchT0},
		{Target: "lutris", Name: "lutris", PIDs: []int{30}, At: watchT0},
	}
	if !reflect.DeepEqual(h.events, want) {
		t.Errorf("events = %+v\nwant %+v", h.events, want)
	}
}

// TestWatcherFoldsIntoAParentThatWasNotClosed: the launcher exited on its
// own (or could not be closed) but its child was: the report still names the
// launcher's target, with the child's name.
func TestWatcherFoldsIntoAParentThatWasNotClosed(t *testing.T) {
	h := newHarness(t)
	h.procs = []Process{
		{PID: 10, PPID: 1, Name: "steam"},
		{PID: 11, PPID: 10, Name: "hl2_linux"},
	}
	h.killErr[10] = ErrNotFound
	m := NewMatcherFor("linux", []string{"steam", "hl2_linux"})
	h.start(func() Matcher { return m })
	h.stop()
	want := []Killed{{Target: "steam", Name: "hl2_linux", PIDs: []int{11}, At: watchT0}}
	if !reflect.DeepEqual(h.events, want) {
		t.Errorf("events = %+v\nwant %+v", h.events, want)
	}
}

func TestWatcherParentCycleTerminates(t *testing.T) {
	// PID reuse can make a listing's parent links loop.
	h := newHarness(t)
	h.procs = []Process{
		{PID: 10, PPID: 11, Name: "steam"},
		{PID: 11, PPID: 10, Name: "steam"},
		{PID: 12, PPID: 12, Name: "steam"},
	}
	m := NewMatcherFor("linux", []string{"steam"})
	h.start(func() Matcher { return m })
	h.stop()
	if len(h.events) != 1 || len(h.events[0].PIDs) != 3 {
		t.Errorf("events = %+v, want one report with 3 PIDs", h.events)
	}
}

// TestWatcherNeverKillsSystemProcesses: a target that names a process run by
// root, a service account or a kernel thread (python3, java, node…) only
// closes the user's own processes.
func TestWatcherNeverKillsSystemProcesses(t *testing.T) {
	h := newHarness(t)
	h.procs = []Process{
		{PID: 700, Name: "python3", Path: "/usr/bin/python3", Comm: "unattended-upgr", System: true},
		{PID: 701, Name: "python3", Path: "/usr/bin/python3", Comm: "networkd-dispat", System: true},
		{PID: 702, Name: "java", System: true},
		{PID: 703, Name: "kworker/0:1", Comm: "python3", System: true},
		{PID: 800, Name: "python3", Path: "/usr/bin/python3"},
	}
	m := NewMatcherFor("linux", []string{"python3", "java"})
	h.start(func() Matcher { return m })
	h.stop()
	if want := []killCall{{800, "python3"}}; !reflect.DeepEqual(h.kills, want) {
		t.Errorf("kills = %v, want only the user's python3", h.kills)
	}
	if len(h.events) != 1 || !reflect.DeepEqual(h.events[0].PIDs, []int{800}) {
		t.Errorf("events = %+v", h.events)
	}
}

func TestWatcherSkipsWindowsServices(t *testing.T) {
	h := newHarness(t)
	h.procs = []Process{
		{PID: 900, Name: "SteamService.exe", System: true}, // session 0
		{PID: 901, Name: "EasyAntiCheat.exe", System: true},
		{PID: 902, Name: "steam.exe"},
	}
	m := NewMatcherFor("windows", []string{"SteamService", "EasyAntiCheat.exe", "steam"})
	h.start(func() Matcher { return m })
	h.stop()
	if want := []killCall{{902, "steam.exe"}}; !reflect.DeepEqual(h.kills, want) {
		t.Errorf("kills = %v, want only steam.exe", h.kills)
	}
}

// TestWatcherProtectedAtKillIsSilent: the check right before the kill found
// the process protected (for example a service helper running as SYSTEM in
// the user's session): no report and no log.
func TestWatcherProtectedAtKillIsSilent(t *testing.T) {
	h := newHarness(t)
	h.procs = []Process{{PID: 100, Name: "vendorhelper.exe"}}
	h.killErr[100] = ErrProtected
	m := NewMatcherFor("windows", []string{"vendorhelper"})
	h.start(func() Matcher { return m })
	h.step(1)
	h.stop()
	if len(h.events) != 0 {
		t.Errorf("events = %+v", h.events)
	}
	if s := h.log.String(); s != "" {
		t.Errorf("unexpected log output: %s", s)
	}
}
