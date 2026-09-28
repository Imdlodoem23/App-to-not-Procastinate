package engine

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
	"github.com/imdlodoem23/centrate/guardian/internal/points"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// Regression tests for the stopped-service check and the clock restore at startup
// (§10.12 steps 8–9, cheat matrix #3, #7, #8, #16).

// earnSome completes a 30-minute block so the balance (the penalty base) is positive.
func earnSome(env *testEnv) {
	env.t.Helper()
	env.create(durationReq(ModeNormal, 30, "tiktok"))
	env.advance(31 * time.Minute)
}

// wantStopPenalty checks that exactly one tamper_detected of kind was written, charging
// the emergency penalty of balance (and voiding the streak).
func wantStopPenalty(t *testing.T, env *testEnv, kind string, balance int64) {
	t.Helper()
	tam := env.eventsOf(EvTamperDetected)
	if len(tam) != 1 {
		t.Fatalf("%d tamper_detected events, want 1 (%s)", len(tam), kind)
	}
	d := mustDecode[TamperDetectedData](t, tam[0])
	pen := points.EmergencyPenalty(balance, points.DefaultPointRules())
	if d.Kind != kind || d.BalanceCorrection != -pen || !d.VoidStreak || tam[0].Points != -pen {
		t.Fatalf("tamper %+v points %d, want %s −%d", d, tam[0].Points, kind, pen)
	}
}

func wantNoTamper(t *testing.T, env *testEnv) {
	t.Helper()
	if tam := env.eventsOf(EvTamperDetected); len(tam) != 0 {
		t.Fatalf("penalized: %+v", mustDecode[TamperDetectedData](t, tam[0]))
	}
}

func removeFiles(t *testing.T, dir string, names ...string) {
	t.Helper()
	for _, n := range names {
		if err := os.Remove(filepath.Join(dir, filepath.FromSlash(n))); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
	}
}

func readFiles(t *testing.T, dir string, names ...string) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	for _, n := range names {
		b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(n)))
		if err != nil {
			t.Fatal(err)
		}
		out[n] = b
	}
	return out
}

func writeFiles(t *testing.T, dir string, files map[string][]byte) {
	t.Helper()
	for n, b := range files {
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(n)), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

var snapshotFiles = []string{"state.json", "state.prev.json", "run/clock.json"}

// Deleting every clock snapshot and moving the clock forward while stopped used to
// restart T from the wall clock with nothing to catch it: the hardcore block ended at
// once, for free. The last logged event bounds the stop now: T resumes like after a
// reboot (boot hold, immediate calibration) and the unmeasured stop is priced.
func TestMissingClockSnapshotIsPriced(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	earnSome(env)
	b := env.create(durationReq(ModeHardcore, 240, "youtube"))
	env.advance(10 * time.Minute)
	balance := e.state.Ledger.Balance
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	removeFiles(t, env.dir, snapshotFiles...)
	env.clk.JumpWall(6 * time.Hour)
	env.clk.ServiceRestart(30 * time.Second)
	e = env.open()

	wantStopPenalty(t, env, "service_stopped", balance)
	if e.block(b.ID).Status != StatusActive {
		t.Fatal("the block ended at startup")
	}
	// Before any turn (a query would already calibrate): unverified, held, restore jump.
	if e.trust() != TrustUnverified || e.bootHoldUntil() == nil || e.state.Clock.Restore == nil {
		t.Fatalf("clock after an unmeasured stop: trust %s, hold %v, restore %+v", e.trust(), e.bootHoldUntil(), e.state.Clock.Restore)
	}
	e.Step() // the immediate calibration answers the real time
	jumps := env.eventsOf(EvClockJump)
	last := mustDecode[ClockJumpData](t, jumps[len(jumps)-1])
	if last.Source != "calibrate" || last.DeltaMs < 6*3600*1000-2000 {
		t.Fatalf("calibration %+v", last)
	}
	if e.block(b.ID).Status != StatusActive {
		t.Fatal("the block ended after the calibration")
	}
	// It runs to its real end: 230 minutes were left, 30 s of them passed while down.
	env.advance(229 * time.Minute)
	if e.block(b.ID).Status != StatusActive {
		t.Fatal("ended early")
	}
	env.advance(2 * time.Minute)
	if e.block(b.ID).Status != StatusCompleted {
		t.Fatal("did not end at its real end")
	}
}

// Putting back an older sealed snapshot from a previous boot used to make a same-boot
// stop look like a reboot (never priced). The snapshots carry their log position now:
// the newest wins, and one older than the log from another boot is an unmeasured stop.
func TestReplayedClockSnapshotIsPriced(t *testing.T) {
	for _, c := range []struct {
		name  string
		files []string
	}{
		{"clock file only", []string{"run/clock.json"}},
		{"every snapshot file", snapshotFiles},
	} {
		t.Run(c.name, func(t *testing.T) {
			env := newTestEnv(t)
			env.open()
			earnSome(env)
			env.shutdown()
			old := readFiles(t, env.dir, c.files...) // copies from the first boot
			env.clk.RebootAfter(time.Hour)
			e := env.open()
			b := env.create(durationReq(ModeHardcore, 240, "youtube"))
			balance := e.state.Ledger.Balance
			if err := e.Stop(); err != nil {
				t.Fatal(err)
			}
			writeFiles(t, env.dir, old)
			env.fh.Tamper(nil)
			env.clk.ServiceRestart(2 * time.Hour)
			e = env.open()
			wantStopPenalty(t, env, "service_stopped", balance)
			if e.block(b.ID).Status != StatusActive || len(env.fh.Domains()) == 0 {
				t.Fatal("the block is not enforced")
			}
		})
	}
}

// Three unclean starts put the guardian in safe mode, which used to skip the check:
// crash it twice, then crash it again and keep it stopped. Safe mode is no exemption.
func TestStopPricedInSafeMode(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	earnSome(env)
	env.create(durationReq(ModeHardcore, 240, "youtube"))
	balance := e.state.Ledger.Balance
	for range 2 {
		env.e.crash()
		env.clk.ServiceRestart(2 * time.Second)
		env.open()
	}
	env.e.crash()
	env.fh.Tamper(nil)
	env.clk.ServiceRestart(4 * time.Minute)
	e = env.open()
	if e.mode != ModeGuardianSafe {
		t.Fatalf("mode %s", e.mode)
	}
	wantStopPenalty(t, env, "service_stopped", balance)
}

// A manual stop during a block followed by a reboot used to be free. The OS shutdown
// notice writes the planned-stop marker «shutdown» (valid at any age across the
// reboot); a clean stop without it was a manual one, also when the clean-shutdown
// marker is deleted afterwards (run/clock.json seals the clean stop). A crash before a
// reboot and macOS (no shutdown notice) are not priced.
func TestStopThenRebootIsPriced(t *testing.T) {
	cases := []struct {
		name     string
		platform catalog.Platform
		stop     func(env *testEnv)
		penalty  bool
	}{
		{"manual stop", "", func(env *testEnv) {
			if err := env.e.Stop(); err != nil {
				env.t.Fatal(err)
			}
		}, true},
		{"manual stop, clean marker deleted", "", func(env *testEnv) {
			if err := env.e.Stop(); err != nil {
				env.t.Fatal(err)
			}
			removeFiles(env.t, env.dir, "run/clean-shutdown")
		}, true},
		{"OS shutdown", "", func(env *testEnv) { env.shutdown() }, false},
		{"crash", "", func(env *testEnv) { env.e.crash() }, false},
		{"manual stop on macOS", catalog.PlatformMac, func(env *testEnv) {
			if err := env.e.Stop(); err != nil {
				env.t.Fatal(err)
			}
		}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			env := newTestEnv(t)
			env.platform = c.platform
			e := env.open()
			earnSome(env)
			env.create(durationReq(ModeStrict, 60, "youtube"))
			balance := e.state.Ledger.Balance
			c.stop(env)
			env.fh.Tamper([]string{"example.org"})
			env.clk.Advance(30 * time.Minute) // the stop, then 30 minutes until the reboot
			env.clk.RebootAfter(time.Hour)    // the shutdown marker expires meanwhile
			env.open()
			if c.penalty {
				wantStopPenalty(t, env, "service_stopped", balance)
			} else {
				wantNoTamper(t, env)
			}
		})
	}
}

// Stopping the service shortly before a schedule's window and starting it after the
// window ended used to skip the occurrence for free (and the 10-minute freeze with it).
// An occurrence whose window overlapped the stop is priced like a block; a stop that
// missed every window is not.
func TestStopDuringScheduleWindowIsPriced(t *testing.T) {
	for _, c := range []struct {
		name    string
		down    time.Duration
		penalty bool
	}{
		{"window skipped", 2 * time.Hour, true},
		{"before the window", 3 * time.Minute, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			env := newTestEnv(t)
			e := env.open()
			earnSome(env) // 10:31
			tg := emptyTargets()
			tg.ServiceIDs = []string{"youtube"}
			sch, err := e.CreateSchedule(bg, Request{Scope: "app"}, ScheduleInput{
				Name: "Mañana", Enabled: true, Days: []int{1, 2, 3, 4, 5, 6, 7}, Start: "10:50", End: "12:00",
				Timezone: "UTC", Targets: tg, Allow: emptyAllow(), Mode: ModeHardcore, AcknowledgeNoEmergency: true,
			})
			if err != nil {
				t.Fatal(err)
			}
			env.advance(11 * time.Minute) // 10:42
			if err := e.DeleteSchedule(bg, Request{Scope: "app"}, sch.Schedule.ID); apiCode(err) != "schedule_starting_soon" {
				t.Fatalf("delete within the freeze: %v", err)
			}
			balance := e.state.Ledger.Balance
			if err := e.Stop(); err != nil {
				t.Fatal(err)
			}
			env.clk.ServiceRestart(c.down)
			env.open()
			if c.penalty {
				wantStopPenalty(t, env, "service_stopped", balance)
			} else {
				wantNoTamper(t, env)
			}
		})
	}
}

// The snapshot of a crashed guardian can be up to snapshotMaxAge old, which counted as
// downtime: a crash restart after 61 s looked like an 89-second stop. A crash is given
// that allowance; a longer crash stop is still priced, and a clean stop (its snapshot
// is taken at the stop) is measured exactly, also with its marker deleted.
func TestCrashRestartAllowance(t *testing.T) {
	for _, c := range []struct {
		name       string
		crash      bool
		dropMarker bool
		down       time.Duration
		penalty    bool
	}{
		{"crash restart", true, false, 61 * time.Second, false},
		{"crash kept down", true, false, 2 * time.Minute, true},
		{"clean stop", false, false, 61 * time.Second, true},
		{"clean stop, marker deleted", false, true, 61 * time.Second, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			env := newTestEnv(t)
			e := env.open()
			earnSome(env)
			env.create(durationReq(ModeNormal, 60, "youtube")) // saved now
			env.advance(28 * time.Second)                      // tick-only changes: not saved yet
			balance := e.state.Ledger.Balance
			if c.crash {
				e.crash()
			} else if err := e.Stop(); err != nil {
				t.Fatal(err)
			}
			if c.dropMarker {
				removeFiles(t, env.dir, "run/clean-shutdown")
			}
			env.clk.ServiceRestart(c.down)
			env.open()
			if c.penalty {
				wantStopPenalty(t, env, "service_stopped", balance)
			} else {
				wantNoTamper(t, env)
			}
		})
	}
}

// A calibration correction lost with state.json and run/clock.json (a crash right after
// its batch) used to resume the uncorrected clock with the deadlines already moved
// back: the block ended early and no later calibration brought it back. The replayed
// correction is applied to the restored clock again, and only once.
func TestCalibrationCorrectionSurvivesCrash(t *testing.T) {
	env := newTestEnv(t)
	ffs := newFaultFS()
	env.fs = ffs
	env.open()
	env.shutdown()
	env.net.SetOffline(true)
	env.clk.RebootAfter(5 * time.Minute)
	env.clk.JumpWall(3 * time.Hour)
	e := env.open()
	env.advance(10 * time.Minute) // offline: T runs 3 h ahead
	b := env.create(durationReq(ModeNormal, 180, "youtube"))
	promised := env.clk.Real().Add(180 * time.Minute)

	env.net.SetOffline(false)
	ffs.setFailSnapshots(true)
	env.clk.Advance(5 * time.Minute) // the backoff retry answers: T moves back 3 h
	e.Step()
	cal := env.eventsOf(EvClockJump)
	if d := mustDecode[ClockJumpData](t, cal[len(cal)-1]); d.Source != "calibrate" || len(d.ShiftedBlockIDs) != 1 {
		t.Fatalf("correction %+v", d)
	}
	e.crash()
	ffs.setFailSnapshots(false)
	env.clk.ServiceRestart(5 * time.Second)
	e = env.open()
	if rec := e.block(b.ID); rec.Status != StatusActive || e.state.Clock.Restore != nil {
		t.Fatalf("after the crash: %s, restore %+v", rec.Status, e.state.Clock.Restore)
	}
	if got := e.now + e.wallOffsetMs(); abs(got-env.clk.Wall().UnixMilli()) > 1000 {
		t.Fatal("T + W no longer reads the wall clock")
	}
	if abs(e.now-env.clk.Real().UnixMilli()) > 1000 {
		t.Fatalf("T is %d ms from real time after the restart", e.now-env.clk.Real().UnixMilli())
	}
	left := promised.Sub(env.clk.Real())
	env.advance(left - time.Minute) // a later calibration shifts nothing again
	if e.block(b.ID).Status != StatusActive {
		t.Fatal("the block ended before its promised real end")
	}
	env.advance(2 * time.Minute)
	if e.block(b.ID).Status != StatusCompleted {
		t.Fatal("the block did not end at its promised real end")
	}
	if n := len(env.eventsOf(EvClockJump)); n != len(cal) {
		t.Fatalf("%d clock jumps after the restart, want none", n-len(cal))
	}
}

func abs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

// A crash between the append of an idempotent request and the state write used to lose
// its record: the retry with the same key ran the mutation again. The replayed events'
// req fingerprints are kept as records without a response, so the retry is refused
// (also after a later restart), and a new key is still a new intention.
func TestIdempotencyAfterLostStateWrite(t *testing.T) {
	env := newTestEnv(t)
	ffs := newFaultFS()
	env.fs = ffs
	e := env.open()
	b := env.create(durationReq(ModeNormal, 60, "youtube"))
	path := "/v1/blocks/" + b.ID + "/extend"
	idem := func(key string) *Idempotency {
		return &Idempotency{Lookup: "lk-" + key, Scope: "app", Method: "POST", Path: path, RequestHash: "h",
			Req: store.ReqFingerprint("app", "POST", path, key)}
	}
	extend := func(e *Engine, key string) error {
		_, err := e.ExtendBlock(bg, Request{Scope: "app", Idem: idem(key)}, b.ID, ExtendBlockRequest{AddMinutes: 10})
		return err
	}
	ffs.setFailSnapshots(true)
	if err := extend(e, "k1"); err != nil {
		t.Fatal(err)
	}
	e.crash()
	ffs.setFailSnapshots(false)
	env.clk.ServiceRestart(time.Second)
	e = env.open()
	for i := range 2 {
		err := extend(e, "k1")
		if apiCode(err) != "idempotency_conflict" || apiDetails(err)["reason"] != "response_lost" {
			t.Fatalf("retry %d: %v", i, err)
		}
		if n := len(env.eventsOf(EvBlockExtended)); n != 1 {
			t.Fatalf("block_extended %d times", n)
		}
		e = env.restart()
	}
	if err := extend(e, "k2"); err != nil {
		t.Fatalf("a new key: %v", err)
	}
	if rec := e.block(b.ID); rec.ExtendedMinutes != 20 {
		t.Fatalf("extended %d minutes", rec.ExtendedMinutes)
	}
}

// In one boot, an older run/clock.json put back loses to the newer snapshot in
// state.json: the stop is measured exactly (a 20-second restart stays free), not from
// the old file.
func TestNewestClockSnapshotWins(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	earnSome(env)
	old := readFiles(t, env.dir, "run/clock.json")
	env.create(durationReq(ModeNormal, 60, "youtube"))
	env.advance(10 * time.Minute)
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	writeFiles(t, env.dir, old)
	env.clk.ServiceRestart(20 * time.Second)
	env.open()
	wantNoTamper(t, env)
	started := env.eventsOf(EvGuardianStarted)
	if d := mustDecode[GuardianStartedData](t, started[len(started)-1]); !d.SameBoot || d.DowntimeMs == nil || *d.DowntimeMs != 20000 {
		t.Fatalf("guardian_started %+v", d)
	}
}

// commit writes run/clock.json before the append, so a power loss right after a batch
// (state.json not written yet) leaves a snapshot as new as the log: the next boot is an
// ordinary reboot after a crash, not an unmeasured stop.
func TestPowerLossAfterCommitIsNoTamper(t *testing.T) {
	env := newTestEnv(t)
	ffs := newFaultFS()
	env.fs = ffs
	e := env.open()
	earnSome(env)
	ffs.mu.Lock()
	ffs.failState = true
	ffs.mu.Unlock()
	b := env.create(durationReq(ModeHardcore, 60, "youtube"))
	e.crash()
	ffs.mu.Lock()
	ffs.failState = false
	ffs.mu.Unlock()
	env.clk.RebootAfter(time.Minute)
	e = env.open()
	wantNoTamper(t, env)
	if e.block(b.ID).Status != StatusActive || e.state.Clock.Restore == nil {
		t.Fatal("the block or the restore jump was lost")
	}
}
