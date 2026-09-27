package clock

import (
	"encoding/json"
	"errors"
	"math"
	"sync"
	"testing"
	"time"
)

// fakeClock drives the three sources by hand. Mono and Awake start at
// arbitrary non-zero values, like real clocks.
type fakeClock struct {
	mu     sync.Mutex
	wall   time.Time
	mono   time.Duration
	awake  time.Duration
	bootID string
}

var t0 = time.Date(2026, time.September, 27, 10, 0, 0, 0, time.UTC)

func newFake() *fakeClock {
	return &fakeClock{wall: t0, mono: 3 * time.Hour, awake: 2 * time.Hour, bootID: "boot-a"}
}

func (f *fakeClock) Wall() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.wall
}

func (f *fakeClock) Mono() time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.mono
}

func (f *fakeClock) Awake() time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.awake
}

func (f *fakeClock) BootID() (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.bootID, nil
}

// run lets d of real time pass with the machine awake.
func (f *fakeClock) run(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wall = f.wall.Add(d)
	f.mono += d
	f.awake += d
}

// sleep lets d of real time pass with the machine suspended.
func (f *fakeClock) sleep(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wall = f.wall.Add(d)
	f.mono += d
}

// setWall moves the wall clock only, as a user changing the time would.
func (f *fakeClock) setWall(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wall = f.wall.Add(d)
}

// reboot restarts Mono and Awake from near zero under a new boot identifier;
// the wall clock keeps running through the downtime.
func (f *fakeClock) reboot(down time.Duration, id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wall = f.wall.Add(down)
	f.mono, f.awake = 20*time.Second, 15*time.Second
	f.bootID = id
}

func (f *fakeClock) opts() Options {
	return Options{Wall: f.Wall, Mono: f.Mono, Awake: f.Awake, BootID: f.BootID}
}

func (f *fakeClock) detector(mod func(*Options)) *Detector {
	o := f.opts()
	if mod != nil {
		mod(&o)
	}
	return NewDetector(o)
}

func assertTime(t *testing.T, what string, got, want time.Time) {
	t.Helper()
	if !got.Equal(want) {
		t.Fatalf("%s = %v, want %v (off by %v)", what, got, want, got.Sub(want))
	}
}

func assertNoJump(t *testing.T, r JumpResult) {
	t.Helper()
	if r.Jumped() || r.Forward || r.Delta != 0 {
		t.Fatalf("unexpected jump: %+v", r)
	}
}

func TestNoJump(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	for i := range 100 {
		f.run(5 * time.Second)
		r := d.Tick()
		assertNoJump(t, r)
		if r.Suspended || r.Reset {
			t.Fatalf("tick %d: unexpected flags %+v", i, r)
		}
		if r.Elapsed != 5*time.Second {
			t.Fatalf("tick %d: Elapsed = %v, want 5s", i, r.Elapsed)
		}
	}
	assertTime(t, "EffectiveNow", d.EffectiveNow(), f.Wall())
	if off := d.WallOffset(); off != 0 {
		t.Fatalf("WallOffset = %v, want 0", off)
	}
}

func TestForwardJumpTwoHours(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	f.run(5 * time.Second)
	f.setWall(2 * time.Hour)
	r := d.Tick()
	if r.Delta != 2*time.Hour || !r.Forward || !r.Jumped() {
		t.Fatalf("got %+v, want a forward jump of 2h", r)
	}
	if r.Suspended {
		t.Fatalf("a clock change is not a suspend: %+v", r)
	}
	assertTime(t, "EffectiveNow", d.EffectiveNow(), t0.Add(5*time.Second))
	if off := d.WallOffset(); off != 2*time.Hour {
		t.Fatalf("WallOffset = %v, want 2h", off)
	}

	// The jump is reported once; afterwards both clocks agree again.
	f.run(5 * time.Second)
	assertNoJump(t, d.Tick())
	assertTime(t, "EffectiveNow", d.EffectiveNow(), t0.Add(10*time.Second))
	// A 1 h block started before the jump still ends 1 h after it started.
	endsAt := t0.Add(time.Hour)
	if !d.EffectiveNow().Before(endsAt) {
		t.Fatal("block ended early after a forward jump")
	}
	// And the machine's clock shows it ending 2 h later.
	assertTime(t, "endsAt on the wall clock", endsAt.Add(d.WallOffset()), t0.Add(3*time.Hour))
}

func TestBackwardJump(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	f.run(5 * time.Second)
	f.setWall(-3 * time.Hour)
	r := d.Tick()
	if r.Delta != -3*time.Hour || r.Forward || !r.Jumped() {
		t.Fatalf("got %+v, want a backward jump of 3h", r)
	}
	// The trusted clock is not dragged back: a block ends at the promised
	// real moment, not three hours later.
	assertTime(t, "EffectiveNow", d.EffectiveNow(), t0.Add(5*time.Second))
	endsAt := t0.Add(time.Hour)
	f.run(time.Hour)
	assertNoJump(t, d.Tick())
	if d.EffectiveNow().Before(endsAt) {
		t.Fatal("block outlived its promised end after a backward jump")
	}
	assertTime(t, "endsAt on the wall clock", endsAt.Add(d.WallOffset()), t0.Add(-2*time.Hour))
}

func TestSuspendThirtyMinutesIsNotAJump(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	f.run(3 * time.Second)
	f.sleep(30 * time.Minute)
	f.run(2 * time.Second)
	r := d.Tick()
	assertNoJump(t, r)
	if !r.Suspended || r.SuspendedFor != 30*time.Minute {
		t.Fatalf("got %+v, want Suspended for 30m", r)
	}
	if r.Elapsed != 30*time.Minute+5*time.Second {
		t.Fatalf("Elapsed = %v, want 30m5s", r.Elapsed)
	}
	// Suspend counts as real time: blocks keep running while asleep.
	assertTime(t, "EffectiveNow", d.EffectiveNow(), t0.Add(30*time.Minute+5*time.Second))

	f.run(5 * time.Second)
	if r := d.Tick(); r.Suspended {
		t.Fatalf("suspend reported twice: %+v", r)
	}
}

func TestShortSuspendBelowThreshold(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	f.sleep(DefaultSuspendThreshold)
	if r := d.Tick(); r.Suspended {
		t.Fatalf("a suspend of exactly the threshold must not be reported: %+v", r)
	}
	f.sleep(DefaultSuspendThreshold + time.Millisecond)
	if r := d.Tick(); !r.Suspended {
		t.Fatalf("a suspend above the threshold must be reported: %+v", r)
	}
}

func TestSuspendAndJumpTogether(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	f.sleep(30 * time.Minute)
	f.setWall(2 * time.Hour)
	r := d.Tick()
	if r.Delta != 2*time.Hour || !r.Forward {
		t.Fatalf("got %+v, want a forward jump of 2h", r)
	}
	if !r.Suspended || r.SuspendedFor != 30*time.Minute {
		t.Fatalf("got %+v, want Suspended for 30m", r)
	}
	assertTime(t, "EffectiveNow", d.EffectiveNow(), t0.Add(30*time.Minute))
}

func TestToleranceEdge(t *testing.T) {
	const tol = DefaultTolerance
	cases := []struct {
		name   string
		move   time.Duration
		jumped bool
	}{
		{"forward exactly tolerance", tol, false},
		{"forward just above tolerance", tol + time.Millisecond, true},
		{"backward exactly tolerance", -tol, false},
		{"backward just above tolerance", -tol - time.Millisecond, true},
		{"forward well below tolerance", tol / 2, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFake()
			d := f.detector(nil)
			f.run(5 * time.Second)
			f.setWall(c.move)
			r := d.Tick()
			if r.Jumped() != c.jumped {
				t.Fatalf("move %v: got %+v, want jumped=%v", c.move, r, c.jumped)
			}
			if c.jumped && r.Delta != c.move {
				t.Fatalf("Delta = %v, want %v", r.Delta, c.move)
			}
			if !c.jumped && d.WallOffset() != 0 {
				t.Fatalf("WallOffset = %v, want 0", d.WallOffset())
			}
		})
	}
}

func TestCustomTolerance(t *testing.T) {
	f := newFake()
	d := f.detector(func(o *Options) { o.Tolerance = 5 * time.Second })
	f.run(time.Second)
	f.setWall(6 * time.Second)
	if r := d.Tick(); r.Delta != 6*time.Second {
		t.Fatalf("got %+v, want Delta 6s with a 5s tolerance", r)
	}
}

// Moving the clock in steps below the tolerance must not escape detection:
// the steps add up against the trusted clock, not against the previous tick.
func TestSmallStepsAddUp(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	var reported time.Duration
	var real time.Duration
	const step = 20 * time.Second
	const ticks = 30
	for range ticks {
		f.run(5 * time.Second)
		real += 5 * time.Second
		f.setWall(step)
		r := d.Tick()
		reported += r.Delta
	}
	moved := time.Duration(ticks) * step
	if reported < moved-DefaultTolerance {
		t.Fatalf("reported %v of %v moved; at most the tolerance may stay pending", reported, moved)
	}
	// The trusted clock gained at most MaxSlew of the real elapsed time.
	gain := d.EffectiveNow().Sub(t0.Add(real))
	if limit := time.Duration(float64(real) * DefaultMaxSlew); gain < 0 || gain > limit {
		t.Fatalf("trusted clock gained %v, limit %v", gain, limit)
	}
}

// NTP slewing and oscillator error are followed without reports.
func TestSlewFollowsDriftingWall(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	const tick = 5 * time.Second
	drift := time.Duration(float64(tick) * 200e-6) // wall runs 200 ppm fast
	for i := range 20000 {                         // about 28 h
		f.run(tick)
		f.setWall(drift)
		if r := d.Tick(); r.Jumped() {
			t.Fatalf("tick %d: drift reported as a jump: %+v", i, r)
		}
	}
	assertTime(t, "EffectiveNow", d.EffectiveNow(), f.Wall())
}

func TestSlewDisabledReportsAccumulatedDrift(t *testing.T) {
	f := newFake()
	d := f.detector(func(o *Options) {
		o.MaxSlew = -1
		o.Tolerance = time.Second
	})
	jumped := false
	for range 200 {
		f.run(5 * time.Second)
		f.setWall(10 * time.Millisecond)
		if d.Tick().Jumped() {
			jumped = true
			break
		}
	}
	if !jumped {
		t.Fatal("with MaxSlew < 0 an accumulated drift above the tolerance must be reported")
	}
}

// A small step (for instance NTP correcting the clock after resume) is not a
// jump and is absorbed at most at MaxSlew.
func TestSmallStepAbsorbedGradually(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	f.run(10 * time.Second)
	f.setWall(30 * time.Second)
	assertNoJump(t, d.Tick())
	// 10 s of Mono allow 10 ms of correction.
	assertTime(t, "EffectiveNow", d.EffectiveNow(), t0.Add(10*time.Second+10*time.Millisecond))
}

func TestMonoBackwardsResets(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	f.run(10 * time.Second)
	assertNoJump(t, d.Tick())
	before := d.EffectiveNow()
	f.mu.Lock()
	f.mono -= time.Minute
	f.mu.Unlock()
	r := d.Tick()
	if !r.Reset {
		t.Fatalf("got %+v, want Reset", r)
	}
	if got := d.EffectiveNow(); got.Before(before) {
		t.Fatalf("EffectiveNow went back from %v to %v", before, got)
	}
	f.run(5 * time.Second)
	if r := d.Tick(); r.Reset || r.Jumped() {
		t.Fatalf("detector did not recover: %+v", r)
	}
}

func TestSnapshotJSONRoundTrip(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	f.run(time.Minute)
	f.setWall(2 * time.Hour)
	d.Tick()
	s := d.Snapshot()
	if s.BootID != "boot-a" || s.Offset != 2*time.Hour || s.Boot != 3*time.Hour+time.Minute {
		t.Fatalf("unexpected snapshot %+v", s)
	}
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	var back Snapshot
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if !back.Wall.Equal(s.Wall) || !back.Trusted.Equal(s.Trusted) || back.Offset != s.Offset ||
		back.Boot != s.Boot || back.BootID != s.BootID {
		t.Fatalf("round trip changed the snapshot:\n%+v\n%+v\n%s", s, back, b)
	}
}

// Stopping the guardian, changing the clock and starting it again in the same
// boot is caught.
func TestRestoreSameBootDetectsJumpWhileStopped(t *testing.T) {
	f := newFake()
	d1 := f.detector(nil)
	f.run(time.Minute)
	d1.Tick()
	saved := d1.Snapshot()

	f.run(10 * time.Minute) // guardian stopped
	f.setWall(2 * time.Hour)

	d2 := f.detector(nil) // new process anchors on the (wrong) wall clock...
	res := d2.Restore(saved)
	if !res.SameBoot || res.WallBehind {
		t.Fatalf("got %+v, want SameBoot", res)
	}
	if res.Downtime != 10*time.Minute {
		t.Fatalf("Downtime = %v, want 10m", res.Downtime)
	}
	if res.Jump.Delta != 2*time.Hour || !res.Jump.Forward {
		t.Fatalf("jump while stopped not reported: %+v", res.Jump)
	}
	// ...but Restore puts the trusted clock back on the real timeline.
	assertTime(t, "EffectiveNow", d2.EffectiveNow(), t0.Add(11*time.Minute))
	if off := d2.WallOffset(); off != 2*time.Hour {
		t.Fatalf("WallOffset = %v, want 2h", off)
	}
}

// A jump reported before the restart stays compensated, and one that was not
// yet reported when the snapshot was taken is reported on Restore.
func TestRestoreSameBootKeepsOffsets(t *testing.T) {
	f := newFake()
	d1 := f.detector(nil)
	f.setWall(time.Hour)
	d1.Tick()                 // reported: offset 1h
	f.setWall(-3 * time.Hour) // not yet reported when the snapshot is taken
	saved := d1.Snapshot()
	f.run(time.Minute)

	d2 := f.detector(nil)
	res := d2.Restore(saved)
	if !res.SameBoot || res.Jump.Delta != -3*time.Hour {
		t.Fatalf("got %+v, want the pending -3h jump", res)
	}
	if off := d2.WallOffset(); off != -2*time.Hour {
		t.Fatalf("WallOffset = %v, want -2h", off)
	}
	assertTime(t, "EffectiveNow", d2.EffectiveNow(), t0.Add(time.Minute))
}

func TestRestoreDetectsRebootByBootID(t *testing.T) {
	f := newFake()
	d1 := f.detector(nil)
	f.run(time.Hour)
	d1.Tick()
	saved := d1.Snapshot()

	f.reboot(5*time.Minute, "boot-b")
	d2 := f.detector(nil)
	res := d2.Restore(saved)
	if res.SameBoot || res.WallBehind || res.Jump.Jumped() || res.Downtime != 0 {
		t.Fatalf("got %+v, want a plain reboot", res)
	}
	// Continuity is lost: fall back to the wall clock.
	assertTime(t, "EffectiveNow", d2.EffectiveNow(), f.Wall())
	f.run(5 * time.Second)
	assertNoJump(t, d2.Tick())
}

// Same boot identifier but Mono lower than saved: the snapshot is from another
// boot (or corrupt), so continuity must not be assumed.
func TestRestoreMonoBackwardsIsNotSameBoot(t *testing.T) {
	f := newFake()
	d1 := f.detector(nil)
	saved := d1.Snapshot()
	f.reboot(time.Minute, "boot-a")
	d2 := f.detector(nil)
	if res := d2.Restore(saved); res.SameBoot {
		t.Fatalf("got %+v, want SameBoot false", res)
	}
	assertTime(t, "EffectiveNow", d2.EffectiveNow(), f.Wall())
}

func TestRestoreUnknownBootIDIsNotSameBoot(t *testing.T) {
	f := newFake()
	noID := func(o *Options) { o.BootID = func() (string, error) { return "", errors.New("unavailable") } }
	d1 := f.detector(noID)
	saved := d1.Snapshot()
	if saved.BootID != "" {
		t.Fatalf("BootID = %q, want empty", saved.BootID)
	}
	f.run(time.Minute)
	d2 := f.detector(noID)
	if res := d2.Restore(saved); res.SameBoot {
		t.Fatalf("got %+v, want SameBoot false when the boot id is unknown", res)
	}
}

// "Move the clock forward, let it be compensated, then reboot" must not win.
func TestRestoreAfterRebootKeepsPreviousOffset(t *testing.T) {
	f := newFake()
	d1 := f.detector(nil)
	f.run(time.Minute)
	f.setWall(2 * time.Hour)
	d1.Tick()
	saved := d1.Snapshot()

	f.reboot(5*time.Minute, "boot-b") // the clock is still 2 h ahead
	d2 := f.detector(nil)
	res := d2.Restore(saved)
	if res.SameBoot || res.WallBehind {
		t.Fatalf("got %+v", res)
	}
	assertTime(t, "EffectiveNow", d2.EffectiveNow(), t0.Add(6*time.Minute))
	if off := d2.WallOffset(); off != 2*time.Hour {
		t.Fatalf("WallOffset = %v, want 2h", off)
	}
}

// "Move the clock back, let it be compensated, then fix it while the machine
// is off" must not win either: the earlier candidate is taken.
func TestRestoreAfterRebootWithClockFixedWhileOff(t *testing.T) {
	f := newFake()
	d1 := f.detector(nil)
	f.run(time.Minute)
	f.setWall(-10 * time.Hour)
	d1.Tick()
	saved := d1.Snapshot()

	f.reboot(5*time.Minute, "boot-b")
	f.setWall(10 * time.Hour) // clock put right while off
	d2 := f.detector(nil)
	d2.Restore(saved)
	assertTime(t, "EffectiveNow", d2.EffectiveNow(), t0.Add(6*time.Minute))
	if off := d2.WallOffset(); off != 0 {
		t.Fatalf("WallOffset = %v, want 0", off)
	}
}

// A dead CMOS battery (or a clock set back while off) makes the wall clock
// read earlier than the saved trusted time: it is not believed.
func TestRestoreWallBehindClampsToSavedTrusted(t *testing.T) {
	f := newFake()
	d1 := f.detector(nil)
	f.run(time.Minute)
	d1.Tick()
	saved := d1.Snapshot()

	f.reboot(0, "boot-b")
	f.mu.Lock()
	f.wall = time.Date(2000, time.January, 1, 0, 0, 0, 0, time.UTC)
	f.mu.Unlock()
	d2 := f.detector(nil)
	res := d2.Restore(saved)
	if res.SameBoot || !res.WallBehind {
		t.Fatalf("got %+v, want WallBehind", res)
	}
	assertTime(t, "EffectiveNow", d2.EffectiveNow(), saved.Trusted)

	// NTP later puts the clock right: reported as a forward jump, and the
	// trusted clock does not move.
	f.run(10 * time.Second)
	f.mu.Lock()
	f.wall = t0.Add(2 * time.Hour)
	f.mu.Unlock()
	r := d2.Tick()
	if !r.Forward || !r.Jumped() {
		t.Fatalf("got %+v, want the correction reported as a forward jump", r)
	}
	assertTime(t, "EffectiveNow", d2.EffectiveNow(), saved.Trusted.Add(10*time.Second))

	// The trusted clock now lags real time by the downtime. Calibrate leaves
	// that alone; Resync, with a network reference, corrects it.
	realNow := f.Wall()
	lag := realNow.Sub(d2.EffectiveNow())
	if r := d2.Calibrate(realNow); r.Jumped() || r.TrustedShift != 0 {
		t.Fatalf("Calibrate moved a lagging clock: %+v", r)
	}
	r = d2.Resync(realNow)
	if r.TrustedShift != lag || r.Jumped() {
		t.Fatalf("got %+v, want TrustedShift %v and no jump", r, lag)
	}
	assertTime(t, "EffectiveNow", d2.EffectiveNow(), realNow)
	if off := d2.WallOffset(); off != 0 {
		t.Fatalf("WallOffset = %v, want 0", off)
	}
}

func TestRestoreZeroSnapshotIsFreshStart(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	f.run(time.Second)
	res := d.Restore(Snapshot{})
	if res != (RestoreResult{}) {
		t.Fatalf("got %+v, want zero result", res)
	}
	assertTime(t, "EffectiveNow", d.EffectiveNow(), f.Wall())
	if d.WallOffset() != 0 {
		t.Fatal("WallOffset must be 0 after a fresh start")
	}
}

func TestSameBoot(t *testing.T) {
	prev := Snapshot{Trusted: t0, Boot: time.Hour, BootID: "a"}
	cases := []struct {
		name string
		prev Snapshot
		cur  Snapshot
		want bool
	}{
		{"same id, mono forward", prev, Snapshot{Boot: 2 * time.Hour, BootID: "a"}, true},
		{"same id, same mono", prev, Snapshot{Boot: time.Hour, BootID: "a"}, true},
		{"different id", prev, Snapshot{Boot: 2 * time.Hour, BootID: "b"}, false},
		{"same id, mono backwards", prev, Snapshot{Boot: time.Minute, BootID: "a"}, false},
		{"unknown ids", Snapshot{Trusted: t0, Boot: time.Hour}, Snapshot{Boot: 2 * time.Hour}, false},
		{"empty previous snapshot", Snapshot{BootID: "a"}, Snapshot{Boot: 2 * time.Hour, BootID: "a"}, false},
		{"corrupt negative mono", Snapshot{Trusted: t0, Boot: -time.Hour, BootID: "a"}, Snapshot{Boot: time.Hour, BootID: "a"}, false},
		// Fallback identifiers move with the wall clock: continuity decides.
		{"derived ids differ, mono forward", Snapshot{Trusted: t0, Boot: time.Hour, BootID: "derived:100"}, Snapshot{Boot: 2 * time.Hour, BootID: "derived:7300"}, true},
		{"boottime ids differ, mono forward", Snapshot{Trusted: t0, Boot: time.Hour, BootID: "boottime:1.000001"}, Snapshot{Boot: 2 * time.Hour, BootID: "boottime:9.000001"}, true},
		{"fallback then primary, mono forward", Snapshot{Trusted: t0, Boot: time.Hour, BootID: "derived:100"}, Snapshot{Boot: 2 * time.Hour, BootID: "bootid:7:99"}, true},
		{"primary then fallback, mono forward", prev, Snapshot{Boot: 2 * time.Hour, BootID: "derived:100"}, true},
		{"fallback, mono backwards", Snapshot{Trusted: t0, Boot: time.Hour, BootID: "derived:100"}, Snapshot{Boot: time.Minute, BootID: "derived:100"}, false},
		{"fallback then unknown", Snapshot{Trusted: t0, Boot: time.Hour, BootID: "derived:100"}, Snapshot{Boot: 2 * time.Hour}, false},
		{"different primary ids", Snapshot{Trusted: t0, Boot: time.Hour, BootID: "bootid:7:1"}, Snapshot{Boot: 2 * time.Hour, BootID: "bootid:7:2"}, false},
	}
	for _, c := range cases {
		if got := SameBoot(c.prev, c.cur); got != c.want {
			t.Errorf("%s: SameBoot = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestInvalidBootIDIsIgnored(t *testing.T) {
	f := newFake()
	d := f.detector(func(o *Options) {
		o.BootID = func() (string, error) { return "bad id\n", nil }
	})
	if id := d.Snapshot().BootID; id != "" {
		t.Fatalf("BootID = %q, want empty", id)
	}
}

// A clock moved forward while the machine was off is caught by a network
// reference: the trusted clock goes back, blocks last until their real end.
func TestCalibrateMovesTrustedClockBack(t *testing.T) {
	f := newFake()
	d := f.detector(nil) // anchored on a wall clock that is 2 h ahead
	f.run(time.Minute)
	realNow := t0.Add(time.Minute - 2*time.Hour)
	r := d.Calibrate(realNow)
	if r.Delta != 2*time.Hour || !r.Forward {
		t.Fatalf("got %+v, want a forward correction of 2h", r)
	}
	assertTime(t, "EffectiveNow", d.EffectiveNow(), realNow)
	if off := d.WallOffset(); off != 2*time.Hour {
		t.Fatalf("WallOffset = %v, want 2h", off)
	}
	// The wall clock is consistent with the new offset: no spurious jump.
	f.run(5 * time.Second)
	assertNoJump(t, d.Tick())
}

func TestCalibrateNeverMovesTrustedClockForward(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	f.run(time.Minute)
	want := t0.Add(time.Minute)
	for _, ref := range []time.Time{
		want.Add(3 * time.Hour),        // trusted clock behind: left alone
		want.Add(-DefaultTolerance),    // within tolerance
		want.Add(DefaultTolerance / 2), // within tolerance
		{},                             // zero time: implausible
		time.Date(1999, 1, 1, 0, 0, 0, 0, time.UTC), // implausible
	} {
		if r := d.Calibrate(ref); r.Jumped() {
			t.Fatalf("Calibrate(%v) = %+v, want no change", ref, r)
		}
		assertTime(t, "EffectiveNow", d.EffectiveNow(), want)
	}
}

func TestDefaultsWithRealClocks(t *testing.T) {
	d := NewDetector(Options{})
	time.Sleep(20 * time.Millisecond)
	r := d.Tick()
	if r.Jumped() || r.Reset {
		t.Fatalf("real clocks disagree: %+v", r)
	}
	if r.Elapsed <= 0 {
		t.Fatalf("Elapsed = %v, want > 0", r.Elapsed)
	}
	if diff := d.EffectiveNow().Sub(time.Now()).Abs(); diff > time.Second {
		t.Fatalf("EffectiveNow is %v away from time.Now", diff)
	}
}

func TestConcurrentUse(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	var wg sync.WaitGroup
	for g := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range 200 {
				switch (g + i) % 5 {
				case 0:
					f.run(time.Second)
				case 1:
					d.Tick()
				case 2:
					d.EffectiveNow()
				case 3:
					d.WallOffset()
				case 4:
					d.Snapshot()
				}
			}
		}()
	}
	wg.Wait()
	if r := d.Tick(); r.Jumped() {
		t.Fatalf("no clock change was made, got %+v", r)
	}
}

// setWallTo sets the wall clock to an absolute value.
func (f *fakeClock) setWallTo(w time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wall = w
}

// Probe from review: the clock is moved +2h (compensated), the machine is off
// for 10 h and the clock is put right before the guardian starts. Restore
// cannot tell that from "still 2h ahead" and picks the earlier reading, so
// the trusted clock lags by 2 h. Ticks, Calibrate and further reboots keep
// that lag; Resync removes it without shortening any deadline.
func TestResyncCorrectsLagLeftByReboot(t *testing.T) {
	f := newFake()
	d1 := f.detector(nil)
	f.run(time.Minute)
	f.setWall(2 * time.Hour)
	d1.Tick()
	saved := d1.Snapshot()

	f.reboot(10*time.Hour, "boot-b")
	f.setWall(-2 * time.Hour) // put right while off: the wall clock is real time from now on
	d2 := f.detector(nil)
	d2.Restore(saved)
	lagOf := func(d *Detector) time.Duration { return f.Wall().Sub(d.EffectiveNow()) }
	if lag := lagOf(d2); lag != 2*time.Hour {
		t.Fatalf("lag after Restore = %v, want 2h", lag)
	}
	for range 17280 { // one day of 5 s ticks
		f.run(5 * time.Second)
		if r := d2.Tick(); r.Jumped() {
			t.Fatalf("unexpected jump %+v", r)
		}
	}
	if r := d2.Calibrate(f.Wall()); r.Jumped() || r.TrustedShift != 0 {
		t.Fatalf("Calibrate moved a lagging clock: %+v", r)
	}
	if lag := lagOf(d2); lag != 2*time.Hour {
		t.Fatalf("lag after a day and Calibrate = %v, want still 2h", lag)
	}
	// The lag survives another reboot on its own.
	again := d2.Snapshot()
	f.reboot(time.Hour, "boot-c")
	d3 := f.detector(nil)
	d3.Restore(again)
	if lag := lagOf(d3); lag != 2*time.Hour {
		t.Fatalf("lag after a second reboot = %v, want still 2h", lag)
	}

	// A 1 h block created now, on the lagging clock.
	endsAt := d3.EffectiveNow().Add(time.Hour)
	shownAt := endsAt.Add(d3.WallOffset())
	r := d3.Resync(f.Wall())
	if r.TrustedShift != 2*time.Hour || r.Jumped() {
		t.Fatalf("got %+v, want TrustedShift 2h and no jump", r)
	}
	assertTime(t, "EffectiveNow", d3.EffectiveNow(), f.Wall())
	if off := d3.WallOffset(); off != 0 {
		t.Fatalf("WallOffset = %v, want 0", off)
	}
	// The engine shifts its deadlines: nothing ends earlier, nothing moves on
	// the app's countdown.
	endsAt = endsAt.Add(r.TrustedShift)
	if rem := endsAt.Sub(d3.EffectiveNow()); rem != time.Hour {
		t.Fatalf("remaining = %v, want 1h", rem)
	}
	assertTime(t, "endsAt on the wall clock", endsAt.Add(d3.WallOffset()), shownAt)

	f.run(5 * time.Second)
	assertNoJump(t, d3.Tick())
	fixed := d3.Snapshot()
	f.reboot(time.Hour, "boot-d")
	d4 := f.detector(nil)
	d4.Restore(fixed)
	assertTime(t, "EffectiveNow after the next reboot", d4.EffectiveNow(), f.Wall())
}

func TestResyncMovesTrustedClockBackLikeCalibrate(t *testing.T) {
	f := newFake()
	d := f.detector(nil) // anchored on a wall clock that is 2 h ahead
	f.run(time.Minute)
	realNow := t0.Add(time.Minute - 2*time.Hour)
	r := d.Resync(realNow)
	if r.Delta != 2*time.Hour || !r.Forward || r.TrustedShift != 0 {
		t.Fatalf("got %+v, want a forward correction of 2h and no shift", r)
	}
	assertTime(t, "EffectiveNow", d.EffectiveNow(), realNow)
	if off := d.WallOffset(); off != 2*time.Hour {
		t.Fatalf("WallOffset = %v, want 2h", off)
	}
	f.run(5 * time.Second)
	assertNoJump(t, d.Tick())
}

func TestResyncIgnoresSmallAndImplausibleReferences(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	f.run(time.Minute)
	want := t0.Add(time.Minute)
	for _, ref := range []time.Time{
		want.Add(DefaultTolerance),
		want.Add(-DefaultTolerance),
		{},
		time.Date(1999, 1, 1, 0, 0, 0, 0, time.UTC),
	} {
		if r := d.Resync(ref); r.Jumped() || r.TrustedShift != 0 {
			t.Fatalf("Resync(%v) = %+v, want no change", ref, r)
		}
		assertTime(t, "EffectiveNow", d.EffectiveNow(), want)
	}
	if r := d.Resync(want.Add(DefaultTolerance + time.Millisecond)); r.TrustedShift != DefaultTolerance+time.Millisecond {
		t.Fatalf("just above the tolerance: got %+v", r)
	}
}

// Tick reports a jump in the same call as Resync's shift when both happen.
func TestResyncAlsoTicks(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	f.run(time.Minute)
	f.setWall(-3 * time.Hour)
	r := d.Resync(t0.Add(time.Minute + time.Hour))
	if r.Delta != -3*time.Hour || r.TrustedShift != time.Hour {
		t.Fatalf("got %+v, want the -3h jump and a 1h shift", r)
	}
	assertTime(t, "EffectiveNow", d.EffectiveNow(), t0.Add(time.Minute+time.Hour))
	if off := d.WallOffset(); off != -4*time.Hour {
		t.Fatalf("WallOffset = %v, want -4h", off)
	}
}

// A corrupt snapshot must not move the trusted clock decades away.
func TestRestoreDiscardsCorruptSnapshot(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Snapshot)
	}{
		{"trusted far ahead", func(s *Snapshot) { s.Trusted = time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC) }},
		{"trusted before 2025", func(s *Snapshot) { s.Trusted = time.Date(1990, 1, 1, 0, 0, 0, 0, time.UTC) }},
		{"trusted ahead, wall missing", func(s *Snapshot) {
			s.Trusted, s.Wall = time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC), time.Time{}
		}},
	}
	for _, c := range cases {
		for _, same := range []bool{true, false} {
			f := newFake()
			d1 := f.detector(nil)
			f.run(time.Minute)
			d1.Tick()
			saved := d1.Snapshot()
			c.mutate(&saved)
			if same {
				f.run(time.Minute)
			} else {
				f.reboot(time.Minute, "boot-b")
			}
			d2 := f.detector(nil)
			res := d2.Restore(saved)
			if !res.Discarded || res.SameBoot || res.WallBehind || res.Jump.Jumped() {
				t.Fatalf("%s (same boot %v): got %+v, want Discarded only", c.name, same, res)
			}
			assertTime(t, "EffectiveNow", d2.EffectiveNow(), f.Wall())
			if off := d2.WallOffset(); off != 0 {
				t.Fatalf("%s: WallOffset = %v, want 0", c.name, off)
			}
		}
	}
}

// A zero trusted time is no snapshot at all: its offset is ignored too (an
// extreme one used to move EffectiveNow to the year 1734).
func TestRestoreZeroTrustedIgnoresOffset(t *testing.T) {
	for _, off := range []time.Duration{math.MaxInt64, math.MinInt64, 2 * time.Hour} {
		f := newFake()
		d := f.detector(nil)
		f.run(time.Second)
		res := d.Restore(Snapshot{Wall: t0, Offset: off, Boot: time.Hour, BootID: "boot-a"})
		if res != (RestoreResult{}) {
			t.Fatalf("offset %v: got %+v, want a plain fresh start", off, res)
		}
		assertTime(t, "EffectiveNow", d.EffectiveNow(), f.Wall())
		if d.WallOffset() != 0 {
			t.Fatalf("offset %v: WallOffset = %v, want 0", off, d.WallOffset())
		}
	}
}

// An offset at the limits of time.Duration never moves EffectiveNow outside
// [saved Trusted, wall clock] (give or take the slewing of a nanosecond left
// by the saturation), and later ticks do not wrap it around.
func TestRestoreExtremeOffsetStaysSane(t *testing.T) {
	for _, off := range []time.Duration{math.MaxInt64, math.MinInt64} {
		for _, same := range []bool{true, false} {
			f := newFake()
			d1 := f.detector(nil)
			f.run(time.Minute)
			saved := d1.Snapshot()
			saved.Offset = off
			if same {
				f.run(5 * time.Minute)
			} else {
				f.reboot(5*time.Minute, "boot-b")
			}
			d2 := f.detector(nil)
			if res := d2.Restore(saved); res.Discarded {
				t.Fatalf("offset %v: a plausible trusted time was discarded", off)
			}
			for i := range 3 {
				now := d2.EffectiveNow()
				if now.Before(saved.Trusted) || now.After(f.Wall().Add(time.Microsecond)) {
					t.Fatalf("offset %v, same boot %v, tick %d: EffectiveNow %v outside [%v, %v]",
						off, same, i, now, saved.Trusted, f.Wall())
				}
				f.run(5 * time.Second)
				d2.Tick()
			}
			if w := d2.WallOffset(); w.Abs() > time.Hour {
				t.Fatalf("offset %v, same boot %v: WallOffset = %v after ticks", off, same, w)
			}
		}
	}
}

// A dead CMOS battery can reset the clock to a firmware date after 2025 but
// more than a year back. The snapshot agrees with itself, so it is kept and
// the trusted clock resumes from it instead of from the firmware date.
func TestRestoreKeepsConsistentSnapshotWhenWallIsYearsBehind(t *testing.T) {
	f := newFake()
	d1 := f.detector(nil)
	f.run(time.Minute)
	d1.Tick()
	saved := d1.Snapshot()

	f.reboot(0, "boot-b")
	f.setWallTo(time.Date(2025, time.March, 1, 0, 0, 0, 0, time.UTC))
	d2 := f.detector(nil)
	res := d2.Restore(saved)
	if res.Discarded || !res.WallBehind {
		t.Fatalf("got %+v, want WallBehind and the snapshot kept", res)
	}
	assertTime(t, "EffectiveNow", d2.EffectiveNow(), saved.Trusted)
}

// The trusted clock was first anchored on a dead-CMOS wall clock in 2000 and
// NTP put the wall clock right later. The snapshot agrees with itself, so it
// is kept (discarding it would end blocks set on that timeline at once); the
// lag is Resync's to correct.
func TestRestoreKeepsConsistentSnapshotBefore2025(t *testing.T) {
	f := newFake()
	f.setWallTo(time.Date(2000, time.January, 1, 0, 0, 0, 0, time.UTC))
	d1 := f.detector(nil)
	f.run(time.Minute)
	f.setWallTo(t0.Add(time.Minute)) // NTP
	if r := d1.Tick(); !r.Forward {
		t.Fatalf("NTP correction not reported: %+v", r)
	}
	saved := d1.Snapshot()
	endsAt := saved.Trusted.Add(time.Hour) // a block set on that timeline

	f.reboot(5*time.Minute, "boot-b")
	d2 := f.detector(nil)
	res := d2.Restore(saved)
	if res.Discarded || res.WallBehind {
		t.Fatalf("got %+v, want the snapshot kept", res)
	}
	if !d2.EffectiveNow().Before(endsAt) {
		t.Fatal("block ended at once after the reboot")
	}
	r := d2.Resync(f.Wall())
	assertTime(t, "EffectiveNow", d2.EffectiveNow(), f.Wall())
	if rem := endsAt.Add(r.TrustedShift).Sub(d2.EffectiveNow()); rem <= 0 || rem > time.Hour {
		t.Fatalf("remaining after the shift = %v, want within (0, 1h]", rem)
	}
}

// A large offset is a real, compensated clock change, not corruption:
// discarding it would let "move the clock 2 years ahead, wait for the tick,
// reboot offline" end every block.
func TestRestoreKeepsLargeGenuineOffset(t *testing.T) {
	f := newFake()
	d1 := f.detector(nil)
	f.run(time.Minute)
	const twoYears = 2 * 365 * 24 * time.Hour
	f.setWall(twoYears)
	d1.Tick()
	saved := d1.Snapshot()

	f.reboot(5*time.Minute, "boot-b") // the clock is still 2 years ahead
	d2 := f.detector(nil)
	if res := d2.Restore(saved); res.Discarded || res.WallBehind {
		t.Fatalf("got %+v", res)
	}
	assertTime(t, "EffectiveNow", d2.EffectiveNow(), t0.Add(6*time.Minute))
	if off := d2.WallOffset(); off != twoYears {
		t.Fatalf("WallOffset = %v, want 2 years", off)
	}
}

// With a fallback boot id (which moves with the wall clock), a clock change
// made while the guardian was stopped is still caught through Mono
// continuity instead of being taken for a reboot.
func TestRestoreFallbackIDStillDetectsJumpWhileStopped(t *testing.T) {
	f := newFake()
	f.bootID = "derived:1000"
	d1 := f.detector(nil)
	f.run(time.Minute)
	d1.Tick()
	saved := d1.Snapshot()

	f.run(10 * time.Minute) // guardian stopped
	f.setWall(2 * time.Hour)
	f.bootID = "derived:8200" // derived from the (moved) wall clock
	d2 := f.detector(nil)
	res := d2.Restore(saved)
	if !res.SameBoot || res.Jump.Delta != 2*time.Hour {
		t.Fatalf("got %+v, want SameBoot and the 2h jump", res)
	}
	assertTime(t, "EffectiveNow", d2.EffectiveNow(), t0.Add(11*time.Minute))
}

// Review finding: with BootId stuck (prefetcher disabled), a short previous
// session followed by a slower boot looked like the same boot, and the whole
// off time was reported as a forward jump. The System process creation time
// in the identifier tells the boots apart.
func TestRestoreStuckBootCounterStillSeesReboot(t *testing.T) {
	stuck := func() (uint64, error) { return 7, nil }
	id := func(ft uint64) string {
		return windowsBootID(stuck, func() (uint64, error) { return ft, nil }, func() time.Time { return t0 })
	}
	f := newFake()
	f.bootID = id(133_000_000_000_000_000)
	f.mono, f.awake = 30*time.Second, 30*time.Second
	d1 := f.detector(nil)
	f.run(time.Minute) // short session: Mono 90 s
	saved := d1.Snapshot()

	f.reboot(8*time.Hour, id(133_000_288_000_000_000))
	f.mu.Lock()
	f.mono, f.awake = 3*time.Minute, 3*time.Minute // slower boot: Mono already past 90 s
	f.mu.Unlock()
	d2 := f.detector(nil)
	res := d2.Restore(saved)
	if res.SameBoot || res.Jump.Jumped() {
		t.Fatalf("got %+v, want a reboot without a jump", res)
	}
	assertTime(t, "EffectiveNow", d2.EffectiveNow(), f.Wall())
}

// Setting the clock centuries ahead saturates the offset instead of wrapping
// it around, reports the jump once, and recovers when the clock is put back.
func TestHugeClockChangesDoNotOverflowOffset(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	f.setWallTo(time.Date(9000, time.January, 1, 0, 0, 0, 0, time.UTC))
	var reports int
	for range 3 {
		f.run(5 * time.Second)
		if r := d.Tick(); r.Jumped() {
			reports++
			if !r.Forward {
				t.Fatalf("got %+v, want a forward jump", r)
			}
		}
	}
	if reports != 1 {
		t.Fatalf("jump reported %d times, want once", reports)
	}
	if off := d.WallOffset(); off != math.MaxInt64 {
		t.Fatalf("WallOffset = %v, want saturated at the maximum", off)
	}
	assertTime(t, "EffectiveNow", d.EffectiveNow(), t0.Add(15*time.Second))

	f.setWallTo(t0.Add(20 * time.Second))
	if r := d.Tick(); !r.Jumped() || r.Forward {
		t.Fatalf("got %+v, want a backward jump", r)
	}
	if off := d.WallOffset(); off.Abs() > DefaultTolerance {
		t.Fatalf("WallOffset = %v, want about 0", off)
	}
	f.run(5 * time.Second)
	assertNoJump(t, d.Tick())
}

func TestSaturatingArithmetic(t *testing.T) {
	const maxD, minD = time.Duration(math.MaxInt64), time.Duration(math.MinInt64)
	cases := []struct{ a, b, want time.Duration }{
		{1, 2, 3},
		{maxD, 1, maxD},
		{maxD, maxD, maxD},
		{minD, -1, minD},
		{minD, minD, minD},
		{maxD, minD, -1},
		{-5, 3, -2},
	}
	for _, c := range cases {
		if got := addSat(c.a, c.b); got != c.want {
			t.Errorf("addSat(%d, %d) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
	if negSat(minD) != maxD || negSat(maxD) != -maxD || negSat(5) != -5 {
		t.Error("negSat is wrong")
	}
}
