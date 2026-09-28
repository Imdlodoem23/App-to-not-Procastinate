package clock

import (
	"encoding/json"
	"testing"
	"time"
)

func TestBackoffSequence(t *testing.T) {
	var b Backoff
	want := []time.Duration{15 * time.Second, 30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 5 * time.Minute, 5 * time.Minute}
	for i, w := range want {
		if got := b.Next(); got != w {
			t.Fatalf("attempt %d: %v, want %v", i+1, got, w)
		}
	}
	if b.Failures() != len(want) {
		t.Fatalf("Failures = %d", b.Failures())
	}
	b.Reset()
	if b.Failures() != 0 || b.Next() != CalibrateRetryMin {
		t.Fatal("Reset must start over")
	}
	c := Backoff{Min: time.Second, Max: 3 * time.Second}
	for i, w := range []time.Duration{time.Second, 2 * time.Second, 3 * time.Second, 3 * time.Second} {
		if got := c.Next(); got != w {
			t.Fatalf("custom attempt %d: %v, want %v", i+1, got, w)
		}
	}
}

func TestScheduleConstantsMatchContract(t *testing.T) {
	// docs/ARCHITECTURE.md §10.2.
	if CalibrateAfterBoot != time.Minute || CalibrateAfterJump != 10*time.Second || CalibrateEvery != 30*time.Minute ||
		CalibrateRetryMin != 15*time.Second || CalibrateRetryMax != 5*time.Minute || BootHoldMax != 2*time.Minute {
		t.Fatal("calibration schedule differs from the contract")
	}
}

func TestRestoreJumpRules(t *testing.T) {
	saved := t0
	restored := t0.Add(3 * time.Hour)
	j := RestoreJump{SavedT: saved, RestoredT: restored}
	if j.IsZero() || !(RestoreJump{}).IsZero() {
		t.Fatal("IsZero")
	}
	for _, c := range []struct {
		at      time.Time
		crossed bool
	}{
		{saved, false},
		{saved.Add(time.Millisecond), true},
		{restored, true},
		{restored.Add(time.Millisecond), false},
	} {
		if got := j.Crossed(c.at); got != c.crossed {
			t.Errorf("Crossed(%v) = %v", c.at.Sub(saved), got)
		}
	}
	if (RestoreJump{}).Crossed(saved.Add(time.Hour)) {
		t.Error("no jump crosses nothing")
	}
	end := restored.Add(time.Hour)
	if got := j.Shift(restored, end, 2*time.Hour); !got.Equal(end.Add(-2 * time.Hour)) {
		t.Errorf("created at RestoredT: %v", got)
	}
	if got := j.Shift(restored.Add(-time.Millisecond), end, 2*time.Hour); !got.Equal(end) {
		t.Errorf("created before the restore must not move: %v", got)
	}
	if got := j.Shift(restored, end, 0); !got.Equal(end) {
		t.Errorf("no correction: %v", got)
	}
	if got := (RestoreJump{}).Shift(restored, end, time.Hour); !got.Equal(end) {
		t.Errorf("no jump: %v", got)
	}
	raw, err := json.Marshal(j)
	if err != nil {
		t.Fatal(err)
	}
	var back RestoreJump
	if err := json.Unmarshal(raw, &back); err != nil || !back.SavedT.Equal(saved) || !back.RestoredT.Equal(restored) {
		t.Fatalf("JSON round trip: %s -> %+v, %v", raw, back, err)
	}
}

// The §4 scenario end to end: the wall clock is moved 2 h ahead while the
// machine is off; the reboot restore trusts it, a block created afterwards
// ends 2 h early in real time unless the calibration Correction shifts it.
func TestRestoreJumpAndCalibrationCorrection(t *testing.T) {
	f := newFake()
	d := f.detector(nil)
	f.run(10 * time.Minute)
	snap := d.Snapshot()

	f.reboot(time.Hour, "boot-b")
	f.setWall(2 * time.Hour) // moved while off
	real := f.Wall().Add(-2 * time.Hour)

	d2 := f.detector(nil)
	res := d2.Restore(snap)
	if res.SameBoot || res.Restore.IsZero() {
		t.Fatalf("restore = %+v", res)
	}
	assertTime(t, "SavedT", res.Restore.SavedT, snap.Trusted)
	assertTime(t, "RestoredT", res.Restore.RestoredT, d2.EffectiveNow())
	if ahead := d2.EffectiveNow().Sub(real); ahead != 2*time.Hour {
		t.Fatalf("T ahead by %v, want 2h", ahead)
	}

	created := d2.EffectiveNow()
	endsAt := created.Add(time.Hour) // «1 hora» promised
	f.run(5 * time.Minute)
	real = real.Add(5 * time.Minute)

	r := d2.Calibrate(real)
	if r.Correction < 2*time.Hour-time.Second || r.Correction > 2*time.Hour+time.Second {
		t.Fatalf("Correction = %v, want 2h", r.Correction)
	}
	if r.Delta != r.Correction || r.TrustedShift != 0 {
		t.Fatalf("result = %+v", r)
	}
	endsAt = res.Restore.Shift(created, endsAt, r.Correction)
	if remaining := endsAt.Sub(d2.EffectiveNow()); remaining < 55*time.Minute-time.Second || remaining > 55*time.Minute+time.Second {
		t.Fatalf("remaining after the correction = %v, want 55 min", remaining)
	}
	// Same boot: no restore jump.
	s2 := d2.Snapshot()
	d3 := f.detector(nil)
	if res := d3.Restore(s2); !res.SameBoot || !res.Restore.IsZero() {
		t.Fatalf("same-boot restore = %+v", res)
	}
	// A Resync forward is not a Correction.
	d3.baseWall = d3.baseWall.Add(-time.Hour)
	if r := d3.Resync(real.Add(5 * time.Minute)); r.Correction != 0 || r.TrustedShift <= 0 {
		t.Fatalf("resync forward = %+v", r)
	}
}
