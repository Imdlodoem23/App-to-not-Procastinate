package clock

import (
	"encoding/json"
	"errors"
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
