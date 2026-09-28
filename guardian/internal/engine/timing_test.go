package engine

import (
	"context"
	"sync"
	"testing"
	"time"
)

// Regression tests for work that must not stall or skew an engine turn: late
// calibration answers (§10.2) and the hosts write budget (§11.3 step 5).

// manualTicker never fires: only the test's commands step the engine.
type manualTicker struct{ c chan time.Time }

func (m manualTicker) C() <-chan time.Time { return m.c }
func (m manualTicker) Stop()               {}

// startLoop opens the engine and runs its loop (loop mode: calibrations are
// asynchronous) with a ticker that never fires.
func (env *testEnv) startLoop() *Engine {
	env.t.Helper()
	o := env.options()
	o.NewTicker = func(time.Duration) Ticker { return manualTicker{make(chan time.Time)} }
	e, err := New(o)
	if err != nil {
		env.t.Fatal(err)
	}
	env.e = e
	ctx, cancel := context.WithCancel(bg)
	env.t.Cleanup(func() { cancel(); _ = e.Stop() })
	if err := e.Start(ctx); err != nil {
		env.t.Fatal(err)
	}
	<-e.Ready()
	for {
		e.lifeMu.Lock()
		running := e.running
		e.lifeMu.Unlock()
		if running {
			return e
		}
		time.Sleep(time.Millisecond)
	}
}

// settleCalibration waits until no calibration is in flight.
func (env *testEnv) settleCalibration() {
	env.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		busy, err := run(env.e, bg, cmdOpts{}, func() (bool, error) { return env.e.cal.inFlight, nil })
		if err != nil {
			env.t.Fatal(err)
		}
		if !busy {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	env.t.Fatal("calibration still in flight")
}

// wantNoCalibrationJump checks that no calibration moved T and that event times never
// go backwards.
func wantNoCalibrationJump(t *testing.T, env *testEnv, wallOffsetMs int64) {
	t.Helper()
	var prev int64
	for _, ev := range env.events() {
		if at := atMs(&ev); at < prev {
			t.Fatalf("seq %d (%s) at %s goes back", ev.Seq, ev.Type, ev.At)
		} else {
			prev = at
		}
		if ev.Type == EvClockJump {
			if d := mustDecode[ClockJumpData](t, ev); d.Source == "calibrate" {
				t.Fatalf("a calibration moved T: %+v", d)
			}
		}
	}
	s := env.state()
	if s.Clock.WallOffsetMs != wallOffsetMs || s.Clock.Trust != TrustVerified {
		t.Fatalf("clock %+v, want offset %d verified", s.Clock, wallOffsetMs)
	}
}

// POST /v1/_test/clock advances in one engine turn; a calibration due during it used to
// answer on a goroutine and be applied after the whole advance, as if T ran ahead by
// the advance: a false clock_jump{calibrate}, event times going back and a wall offset
// wrong from then on. It runs inline at its own step now.
func TestTestClockCalibrationStaysAligned(t *testing.T) {
	env := newTestEnv(t)
	e := env.startLoop()
	env.create(durationReq(ModeNormal, 240, "youtube"))
	env.settleCalibration()
	hour := int64(time.Hour / time.Millisecond)
	if _, err := e.TestClock(bg, TestClockRequest{JumpMs: &hour}); err != nil {
		t.Fatal(err)
	}
	adv := int64(61 * time.Minute / time.Millisecond)
	if _, err := e.TestClock(bg, TestClockRequest{AdvanceMs: &adv}); err != nil {
		t.Fatal(err)
	}
	env.settleCalibration()
	wantNoCalibrationJump(t, env, hour)
}

// gatedNetworkTime answers the real time when released: the answer describes the
// moment it returns.
type gatedNetworkTime struct {
	clk      *FakeClock
	mu       sync.Mutex
	gate     chan struct{}
	returned chan struct{}
}

func (g *gatedNetworkTime) arm() (release, returned chan struct{}) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.gate, g.returned = make(chan struct{}), make(chan struct{})
	return g.gate, g.returned
}

func (g *gatedNetworkTime) NetworkNow(context.Context, func() time.Time) (time.Time, bool) {
	g.mu.Lock()
	gate, returned := g.gate, g.returned
	g.gate, g.returned = nil, nil
	g.mu.Unlock()
	if gate != nil {
		<-gate
		defer close(returned)
	}
	return g.clk.Real(), true
}

// An asynchronous answer applied after the engine finished a long turn (or after a
// suspend) is moved by the boot-clock time elapsed since it arrived, so the delay is
// not taken for T running ahead.
func TestLateCalibrationAnswerIsAdjusted(t *testing.T) {
	env := newTestEnv(t)
	nt := &gatedNetworkTime{clk: env.clk}
	env.netTime = nt
	e := env.startLoop()
	env.create(durationReq(ModeNormal, 240, "youtube"))
	env.settleCalibration()
	env.clk.JumpWall(time.Hour)
	e.Step() // a tick jump: a calibration is due in 10 s
	release, returned := nt.arm()
	if _, err := run(e, bg, cmdOpts{}, func() (struct{}, error) {
		env.clk.Advance(calibrateAfterJump + tickInterval)
		e.step() // starts the calibration; its answer waits for this turn to end
		close(release)
		<-returned
		time.Sleep(50 * time.Millisecond) // the worker reads the boot clock on return
		env.clk.Advance(61 * time.Minute) // the turn goes on (a long test advance)
		return struct{}{}, nil
	}); err != nil {
		t.Fatal(err)
	}
	env.settleCalibration()
	wantNoCalibrationJump(t, env, int64(time.Hour/time.Millisecond))
}

// slowHosts is a FakeHosts whose writes wait while held (an antivirus holding the
// file); slowDNS a flusher that waits while held.
type slowHosts struct {
	*FakeHosts
	mu   sync.Mutex
	gate chan struct{}
}

func (s *slowHosts) hold() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gate = make(chan struct{})
}

func (s *slowHosts) release() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.gate != nil {
		close(s.gate)
		s.gate = nil
	}
}

func (s *slowHosts) wait() {
	s.mu.Lock()
	g := s.gate
	s.mu.Unlock()
	if g != nil {
		<-g
	}
}

func (s *slowHosts) Apply(d []string) error { s.wait(); return s.FakeHosts.Apply(d) }
func (s *slowHosts) Remove() error          { s.wait(); return s.FakeHosts.Remove() }

type slowDNS struct {
	FakeDNS
	held slowHosts
}

func (s *slowDNS) FlushDNS(ctx context.Context) error {
	s.held.wait()
	return s.FakeDNS.FlushDNS(ctx)
}

// withinBudget fails when fn held the caller much longer than the hosts budget.
func withinBudget(t *testing.T, what string, fn func()) {
	t.Helper()
	start := time.Now()
	fn()
	if d := time.Since(start); d > hostsWriteBudget+time.Second {
		t.Fatalf("%s took %s: the hosts work held the turn", what, d)
	}
}

// A hosts write blocked by a lock used to hold the engine turn (every API request, long
// poll and watcher notice) for the hosts layer's whole retry budget, and the DNS flush
// ran system commands on the engine goroutine too. The turn waits 1 s at most now; the
// write finishes in the background and protection.hosts says "locked" meanwhile.
func TestHostsWriteBudget(t *testing.T) {
	env := newTestEnv(t)
	sh := &slowHosts{FakeHosts: env.fh}
	env.hosts = sh
	e := env.open()
	t.Cleanup(sh.release)
	sh.hold()
	var b Block
	withinBudget(t, "a create with the hosts file held", func() { b = env.create(durationReq(ModeNormal, 30, "youtube")) })
	if p := env.state().Protection.Hosts; p.OK || p.Status != "locked" {
		t.Fatalf("protection.hosts while the write is held: %+v", p)
	}
	withinBudget(t, "a step while the write is still held", e.Step)
	if len(env.fh.Domains()) != 0 {
		t.Fatal("the held write landed")
	}
	sh.release()
	for i := 0; i < 500 && len(env.fh.Domains()) == 0; i++ {
		time.Sleep(2 * time.Millisecond)
	}
	e.Step() // collects the result
	if p := env.state().Protection.Hosts; !p.OK || p.Status != "ok" || p.Entries == 0 {
		t.Fatalf("protection.hosts after the write: %+v", p)
	}
	if e.block(b.ID).Status != StatusActive || env.dns.Flushes() == 0 {
		t.Fatal("block or flush missing after the write")
	}
}

// The DNS flush runs on a worker: a slow one does not hold the turn beyond the budget.
func TestSlowDNSFlushDoesNotHoldTurn(t *testing.T) {
	env := newTestEnv(t)
	dns := &slowDNS{}
	env.dns = &dns.FakeDNS
	env.flusher = dns
	e := env.open()
	t.Cleanup(dns.held.release)
	dns.held.hold()
	withinBudget(t, "a create with a slow flush", func() { env.create(durationReq(ModeNormal, 30, "youtube")) })
	if len(env.fh.Domains()) == 0 {
		t.Fatal("the section was not written")
	}
	dns.held.release()
	for i := 0; i < 500 && dns.Flushes() == 0; i++ {
		time.Sleep(2 * time.Millisecond)
	}
	e.Step()
	if d, err := e.Diagnostics(bg); err != nil || d.Hosts.LastFlush == nil || !d.Hosts.LastFlush.OK {
		t.Fatalf("lastFlush %+v %v", d.Hosts.LastFlush, err)
	}
}

// A hosts write still running at the stop lands afterwards: the section on disk is then
// newer than the hash the final state.json holds. The pending write's hash is saved too,
// so the next start does not take our own write for an edit made while stopped.
func TestHostsWriteLandingAfterStop(t *testing.T) {
	env := newTestEnv(t)
	sh := &slowHosts{FakeHosts: env.fh}
	env.hosts = sh
	e := env.open()
	t.Cleanup(sh.release)
	env.create(durationReq(ModeNormal, 60, "youtube"))
	before := len(env.fh.Domains())
	sh.hold()
	env.create(durationReq(ModeNormal, 60, "instagram"))
	if err := e.Stop(); err != nil { // the write is still held: Stop gives up waiting
		t.Fatal(err)
	}
	sh.release()
	for i := 0; i < 500 && len(env.fh.Domains()) == before; i++ {
		time.Sleep(2 * time.Millisecond)
	}
	env.clk.ServiceRestart(10 * time.Second)
	env.open()
	wantNoTamper(t, env)
}
