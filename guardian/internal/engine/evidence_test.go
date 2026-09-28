package engine

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/points"
)

// Regression tests for the review of the startup evidence (§10.12 steps 4–9, §10.2,
// §10.10, §16.3): planned stops, service managers without a shutdown notice, evidence
// that fails to commit, state rebuilt from the log and sustained hosts tampering.

// An «update» marker used to exempt the hosts check as well: prepare-update,
// cleanup-hosts, a short stop and a new binary still cost the section change.
func TestUpdateMarkerNeverExemptsHostsChange(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	earnSome(env)
	env.create(durationReq(ModeHardcore, 60, "youtube"))
	balance := e.state.Ledger.Balance
	if err := e.st.MarkPlannedStop(plannedUpdate); err != nil {
		t.Fatal(err)
	}
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	env.fh.Tamper(nil) // cleanup-hosts
	env.clk.ServiceRestart(time.Minute)
	env.binary = "test-binary-2"
	env.open()
	wantStopPenalty(t, env, "hosts_changed_while_stopped", balance)
}

// An update that needs a reboot is exempt when the binary changed; the same marker with
// the same binary is a manual stop before a reboot. The service manager is named (one
// that reports OS shutdowns): left unnamed, the host's platform decides.
func TestUpdateMarkerAcrossReboot(t *testing.T) {
	for _, c := range []struct {
		name    string
		updated bool
		penalty bool
	}{
		{"new binary", true, false},
		{"same binary", false, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			env := newTestEnv(t)
			env.serviceManager = "windows-service"
			e := env.open()
			earnSome(env)
			env.create(durationReq(ModeStrict, 60, "youtube"))
			balance := e.state.Ledger.Balance
			if err := e.st.MarkPlannedStop(plannedUpdate); err != nil {
				t.Fatal(err)
			}
			if err := e.Stop(); err != nil {
				t.Fatal(err)
			}
			env.clk.RebootAfter(time.Hour)
			if c.updated {
				env.binary = "test-binary-2"
			}
			env.open()
			if c.penalty {
				wantStopPenalty(t, env, "service_stopped", balance)
			} else {
				wantNoTamper(t, env)
			}
		})
	}
}

// SysV, OpenRC, upstart and launchd send a plain stop at an OS shutdown and no
// «shutdown» marker is ever written there: a clean stop and a reboot used to be priced
// as a manual stop. The named manager decides, whatever the host running the test (the
// platform, the host's by default, used to overrule it on a Mac).
func TestRebootWithoutShutdownNotice(t *testing.T) {
	for _, c := range []struct {
		manager string
		penalty bool
	}{
		{"unix-systemv", false},
		{"linux-openrc", false},
		{"linux-upstart", false},
		{"darwin-launchd", false},
		{"interactive", false},
		{"linux-systemd", true},
		{"windows-service", true},
	} {
		t.Run(c.manager, func(t *testing.T) {
			env := newTestEnv(t)
			env.serviceManager = c.manager
			e := env.open()
			earnSome(env)
			env.create(durationReq(ModeStrict, 60, "youtube"))
			balance := e.state.Ledger.Balance
			if err := e.Stop(); err != nil { // the plain stop an OS shutdown sends
				t.Fatal(err)
			}
			env.clk.RebootAfter(3 * 24 * time.Hour)
			env.open()
			if c.penalty {
				wantStopPenalty(t, env, "service_stopped", balance)
			} else {
				wantNoTamper(t, env)
			}
		})
	}
}

// The stop penalty used to be committed after other startup batches had refreshed
// run/clock.json, and dropped when its append failed: a full disk at the start, or a
// crash between the first startup batch and the penalty, made the stop free. It is the
// first batch now, retried until it commits, and the snapshots wait for it.
func TestStopPenaltySurvivesFailedAppend(t *testing.T) {
	for _, c := range []struct {
		name string
		// then: what happens after the failed start, before appends work again.
		then func(env *testEnv)
		// retryLive: appends work again while that run is still running.
		retryLive bool
	}{
		{"clean restart", func(env *testEnv) {
			env.advance(time.Minute)
			if err := env.e.Stop(); err != nil {
				env.t.Fatal(err)
			}
			env.clk.ServiceRestart(5 * time.Second)
		}, false},
		{"crash", func(env *testEnv) {
			env.advance(time.Minute)
			env.e.crash()
			env.clk.ServiceRestart(5 * time.Second)
		}, false},
		{"retried while running", func(env *testEnv) {}, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			env := newTestEnv(t)
			ffs := newFaultFS()
			env.fs = ffs
			e := env.open()
			earnSome(env)
			env.create(durationReq(ModeHardcore, 240, "youtube"))
			balance := e.state.Ledger.Balance
			if err := e.Stop(); err != nil {
				t.Fatal(err)
			}
			env.clk.JumpWall(time.Hour) // a restore jump to log as well
			env.clk.ServiceRestart(2 * time.Hour)
			ffs.setFailAppend(true)
			e = env.open()
			if n := len(env.eventsOf(EvTamperDetected)); n != 0 {
				t.Fatalf("%d tamper events with a failing log", n)
			}
			if len(e.critical) == 0 {
				t.Fatal("the stop penalty is not pending")
			}
			c.then(env)
			ffs.setFailAppend(false)
			if c.retryLive {
				env.advance(10 * time.Second)
			} else {
				e = env.open()
			}
			wantStopPenalty(t, env, "service_stopped", balance)
			if len(env.e.critical) != 0 {
				t.Fatal("still pending")
			}
			jumps := env.eventsOf(EvClockJump)
			if len(jumps) == 0 || mustDecode[ClockJumpData](t, jumps[0]).Source != "restore" {
				t.Fatalf("restore jump not logged: %v", types(jumps))
			}
			if a, ok, _ := env.anchor.Load(); !ok || a.Balance != env.e.state.Ledger.Balance {
				t.Fatal("anchor not moved after the penalty")
			}
			// Logged once: the next start does not price it again.
			env.clk.ServiceRestart(5 * time.Second)
			env.restart()
			wantStopPenalty(t, env, "service_stopped", balance)
		})
	}
}

// A rollback correction whose append failed used to be laundered: the anchor was moved
// to the rolled-back balance anyway. The anchor waits for the correction now.
func TestRollbackCorrectionNotLaundered(t *testing.T) {
	env := newTestEnv(t)
	ffs := newFaultFS()
	env.fs = ffs
	e := env.open()
	earnSome(env)
	env.create(durationReq(ModeStrict, 120, "youtube"))
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(t.TempDir(), "copy")
	if err := os.CopyFS(backup, os.DirFS(env.dir)); err != nil {
		t.Fatal(err)
	}
	e = env.open()
	before := e.state.Ledger.Balance
	attApp(t, env, "youtube")
	after := e.state.Ledger.Balance
	if after >= before {
		t.Fatalf("attempt did not cost: %d → %d", before, after)
	}
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	// The old folder is put back.
	if err := os.RemoveAll(env.dir); err != nil {
		t.Fatal(err)
	}
	if err := os.CopyFS(env.dir, os.DirFS(backup)); err != nil {
		t.Fatal(err)
	}
	restorePerms(t, env.dir)
	env.clk.ServiceRestart(5 * time.Second)
	ffs.setFailAppend(true)
	e = env.open()
	if n := len(env.eventsOf(EvTamperDetected)); n != 0 {
		t.Fatalf("%d tamper events with a failing log", n)
	}
	if a, _, _ := env.anchor.Load(); a.Balance != after {
		t.Fatalf("anchor moved to %d before the correction was logged (want %d)", a.Balance, after)
	}
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	ffs.setFailAppend(false)
	env.clk.ServiceRestart(5 * time.Second)
	e = env.open()
	tam := env.eventsOf(EvTamperDetected)
	if len(tam) != 1 || mustDecode[TamperDetectedData](t, tam[0]).Kind != "ledger_rollback" {
		t.Fatalf("tamper %v", types(tam))
	}
	if e.state.Ledger.Balance != after {
		t.Fatalf("balance %d, want %d", e.state.Ledger.Balance, after)
	}
	if a, _, _ := env.anchor.Load(); a.Balance != after {
		t.Fatalf("anchor %d", a.Balance)
	}
}

// restorePerms keeps the copied tree private (os.CopyFS keeps the mode bits of the
// source, but the store checks directory modes on some systems).
func restorePerms(t *testing.T, dir string) {
	t.Helper()
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return os.Chmod(p, 0o700)
		}
		return os.Chmod(p, 0o600)
	})
}

// replaceStateFiles puts unsealed garbage in both state generations (state rebuilt
// from the log at the next start).
func replaceStateFiles(t *testing.T, dir string) {
	t.Helper()
	writeFiles(t, dir, map[string][]byte{"state.json": []byte("garbage"), "state.prev.json": []byte("garbage")})
}

// Resurrection used to depend on state.json alone: replacing it after a reboot with the
// BIOS clock ahead lost the restore jump and the unverified completions. The restore jump
// is logged on every reboot and rebuilt by its reducer now.
func TestResurrectionSurvivesStateRebuild(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	a := env.create(durationReq(ModeHardcore, 60, "youtube"))
	env.advance(30 * time.Minute)
	env.shutdown()
	env.net.SetOffline(true)
	env.clk.RebootAfter(5 * time.Minute)
	env.clk.JumpWall(3 * time.Hour)
	e := env.open()
	env.advance(3 * time.Minute)
	if e.block(a.ID).Status != StatusCompleted || len(e.state.Clock.Unverified) != 1 {
		t.Fatalf("status %s, unverified %d", e.block(a.ID).Status, len(e.state.Clock.Unverified))
	}
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	replaceStateFiles(t, env.dir)
	env.clk.ServiceRestart(10 * time.Second)
	e = env.open()
	if e.state.Clock.Restore == nil || len(e.state.Clock.Unverified) != 1 {
		t.Fatalf("rebuilt: restore %+v, unverified %d", e.state.Clock.Restore, len(e.state.Clock.Unverified))
	}
	env.net.SetOffline(false)
	env.advance(2 * time.Minute)
	jumps := env.eventsOf(EvClockJump)
	last := mustDecode[ClockJumpData](t, jumps[len(jumps)-1])
	if last.Source != "calibrate" || len(last.ReactivatedBlockIDs) != 1 || last.ReactivatedBlockIDs[0] != a.ID {
		t.Fatalf("calibration %+v", last)
	}
	if e.block(a.ID).Status != StatusActive {
		t.Fatal("the block was not resurrected")
	}
}

// The open day lived only in state.json: deleting the state files skipped the
// day_closed catch-up. It is derived from the log now.
func TestOpenDayRebuiltFromLog(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	day := e.localDay(e.now)
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	removeFiles(t, env.dir, "state.json", "state.prev.json")
	env.clk.ServiceRestart(20 * time.Hour)
	e = env.open()
	dc := env.eventsOf(EvDayClosed)
	if len(dc) != 1 || mustDecode[DayClosedData](t, dc[0]).Day != day {
		t.Fatalf("day_closed %v", types(dc))
	}
	if lc := e.state.Ledger.LastClosedDay; lc == nil || *lc != day {
		t.Fatalf("lastClosedDay %v", lc)
	}
}

// Materialized schedule occurrences lived only in state.json: a rebuild forgot the one
// whose block an emergency cancelled and materialized it again. block_created{schedule}
// marks it in its reducer now.
func TestMaterializedOccurrenceRebuiltFromLog(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	tg := emptyTargets()
	tg.ServiceIDs = []string{"youtube"}
	_, err := e.CreateSchedule(bg, Request{Scope: "app"}, ScheduleInput{
		Name: "Mañana", Enabled: true, Days: []int{1, 2, 3, 4, 5, 6, 7}, Start: "10:30", End: "12:00",
		Timezone: "UTC", Targets: tg, Allow: emptyAllow(), Mode: ModeStrict,
	})
	if err != nil {
		t.Fatal(err)
	}
	env.advance(35 * time.Minute)
	if len(env.eventsOf(EvBlockCreated)) != 1 {
		t.Fatal("occurrence not materialized")
	}
	want := make(map[string]bool)
	for k := range e.state.Schedules.Materialized {
		want[k] = true
	}
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	replaceStateFiles(t, env.dir)
	env.clk.ServiceRestart(10 * time.Second)
	e = env.open()
	for k := range want {
		if _, ok := e.state.Schedules.Materialized[k]; !ok {
			t.Fatalf("occurrence %s forgotten by the rebuild", k)
		}
	}
	if n := len(env.eventsOf(EvBlockCreated)); n != 1 {
		t.Fatalf("%d block_created", n)
	}
}

// A locked hosts file (chattr +i, a deny ACE) used to be a free way to switch the hosts
// layer off: only status «locked». It is reported at once and priced once per block
// when it lasts.
func TestLockedHostsPriced(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	earnSome(env)
	env.create(durationReq(ModeHardcore, 60, "youtube"))
	balance := e.state.Ledger.Balance
	env.fh.SetApplyErr(fs.ErrPermission)
	env.fh.Tamper(nil)
	env.advance(40 * time.Second)
	tam := env.eventsOf(EvTamperDetected)
	if len(tam) == 0 {
		t.Fatal("lock not reported")
	}
	for _, ev := range tam {
		if ev.Points != 0 {
			t.Fatalf("priced before the grace: %+v", mustDecode[TamperDetectedData](t, ev))
		}
	}
	env.advance(hostsSustainedAfter + 10*time.Second)
	env.advance(5 * time.Minute)
	var priced []TamperDetectedData
	for _, ev := range env.eventsOf(EvTamperDetected) {
		if ev.Points != 0 {
			priced = append(priced, mustDecode[TamperDetectedData](t, ev))
		}
	}
	pen := points.EmergencyPenalty(balance, points.DefaultPointRules())
	if len(priced) != 1 || priced[0].Kind != "hosts_locked" || priced[0].BalanceCorrection != -pen || !priced[0].VoidStreak {
		t.Fatalf("priced %+v, want one hosts_locked −%d", priced, pen)
	}
	locked := false
	for _, ev := range env.eventsOf(EvTamperDetected) {
		if mustDecode[TamperDetectedData](t, ev).Kind == "hosts_locked" && ev.Points == 0 {
			locked = true
		}
	}
	if !locked {
		t.Fatal("tamper_detected{hosts_locked} not reported when the lock was found")
	}
}

// A script that strips the section whenever it reappears used to push the re-apply
// minutes away (doubling backoff) at no cost: the contested retry is a fixed 10 s now,
// and a contest that lasts is priced once per block.
func TestContestedHostsPriced(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	earnSome(env)
	env.create(durationReq(ModeHardcore, 60, "youtube"))
	balance := e.state.Ledger.Balance
	notice := func() {
		t.Helper()
		if err := e.exec(bg, func() { e.timeStep(); e.onHostsChanged(); e.afterTurn() }); err != nil {
			t.Fatal(err)
		}
	}
	var lateApplies int
	for i := range 60 { // 5 minutes, a strip every 5 s
		if i == 30 {
			lateApplies = env.fh.Applies()
		}
		env.fh.Tamper(nil)
		notice()
		env.advance(5 * time.Second)
	}
	// Contested from the 5th strip on: re-applied every 10 s (15 times in 150 s), not
	// minutes apart.
	if n := env.fh.Applies() - lateApplies; n < 12 {
		t.Fatalf("%d re-applies in the last 150 s: the backoff grew", n)
	}
	var priced []TamperDetectedData
	for _, ev := range env.eventsOf(EvTamperDetected) {
		if ev.Points != 0 {
			priced = append(priced, mustDecode[TamperDetectedData](t, ev))
		}
	}
	pen := points.EmergencyPenalty(balance, points.DefaultPointRules())
	if len(priced) != 1 || priced[0].Kind != "hosts" || priced[0].BalanceCorrection != -pen || !priced[0].VoidStreak {
		t.Fatalf("priced %+v, want one hosts −%d", priced, pen)
	}
}
