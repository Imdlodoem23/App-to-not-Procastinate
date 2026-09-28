package engine

import (
	"testing"
	"time"
)

// Moving the wall clock forward while the guardian runs shifts the display endsAt by
// the jump (so the app's countdown stays right) and never ends the block early (§4).
func TestClockForwardJumpShiftsEndsAt(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	b := env.create(durationReq(ModeStrict, 60, "youtube"))
	v0 := e.state.Versions
	env.clk.JumpWall(2 * time.Hour)
	e.Step()
	jumps := env.eventsOf(EvClockJump)
	if len(jumps) != 1 {
		t.Fatalf("%d clock_jump events", len(jumps))
	}
	d := mustDecode[ClockJumpData](t, jumps[0])
	if d.Source != "tick" || d.DeltaMs != 2*3600*1000 || d.WallOffsetMs != 2*3600*1000 || jumps[0].WallOffsetMs != d.WallOffsetMs {
		t.Fatalf("clock_jump %+v", d)
	}
	if e.state.Versions.State <= v0.State || e.state.Versions.ExtRules <= v0.ExtRules {
		t.Fatal("a jump must bump both versions")
	}
	s := env.state()
	e0, _ := parseMs(b.EndsAt)
	e1, _ := parseMs(s.Blocks[0].EndsAt)
	if e1-e0 != 2*3600*1000 {
		t.Fatalf("display endsAt moved by %d ms", e1-e0)
	}
	if s.Clock.WallOffsetMs != 2*3600*1000 || s.Clock.LastJump == nil || s.Clock.LastJump.Source != "tick" {
		t.Fatalf("clock %+v", s.Clock)
	}
	// The countdown (display endsAt − wall) is still the real remaining time.
	if rem := e1 - env.clk.Wall().UnixMilli(); rem != 60*msPerMinute {
		t.Fatalf("remaining %d ms", rem)
	}
	env.advance(59 * time.Minute)
	if e.block(b.ID).Status != StatusActive {
		t.Fatal("a forward jump ended the block early")
	}
	env.advance(2 * time.Minute)
	if e.block(b.ID).Status != StatusCompleted {
		t.Fatal("the block did not end at its real end")
	}
}

// Moving the clock back never lengthens nor shortens the block in real time.
func TestClockBackwardJumpDoesNotEndEarly(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	b := env.create(durationReq(ModeNormal, 30, "youtube"))
	env.advance(5 * time.Minute)
	env.clk.JumpWall(-3 * time.Hour)
	e.Step()
	s := env.state()
	e1, _ := parseMs(s.Blocks[0].EndsAt)
	if rem := e1 - env.clk.Wall().UnixMilli(); rem != 25*msPerMinute {
		t.Fatalf("remaining %d ms after a backward jump", rem)
	}
	env.advance(24 * time.Minute)
	if e.block(b.ID).Status != StatusActive {
		t.Fatal("ended early")
	}
	env.advance(2 * time.Minute)
	if e.block(b.ID).Status != StatusCompleted {
		t.Fatal("did not end at its real end")
	}
	// Credit is real awake time: 30 minutes, not 30 minus or plus the jump.
	d := mustDecode[BlockCompletedData](t, env.eventsOf(EvBlockCompleted)[0])
	if d.CreditedMinutes != 30 {
		t.Fatalf("credited %d", d.CreditedMinutes)
	}
}

// A clock change made while the guardian is stopped (same boot) is reported as a
// restore jump and does not end blocks early (§10.2).
func TestClockJumpWhileStoppedSameBoot(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	b := env.create(durationReq(ModeNormal, 60, "youtube"))
	if err := env.e.Stop(); err != nil {
		t.Fatal(err)
	}
	env.clk.JumpWall(5 * time.Hour)
	env.clk.ServiceRestart(20 * time.Second)
	e := env.open()
	jumps := env.eventsOf(EvClockJump)
	if len(jumps) != 1 || mustDecode[ClockJumpData](t, jumps[0]).Source != "restore" {
		t.Fatalf("jumps %v", types(jumps))
	}
	if e.block(b.ID).Status != StatusActive {
		t.Fatal("the jump ended the block")
	}
	started := mustDecode[GuardianStartedData](t, env.eventsOf(EvGuardianStarted)[1])
	if !started.SameBoot || started.DowntimeMs == nil || *started.DowntimeMs != 20000 || started.UncleanShutdown {
		t.Fatalf("guardian_started %+v", started)
	}
	if g, err := e.GetBlock(bg, b.ID); err != nil || g.Progress.DowntimeMs != 20000 {
		t.Fatalf("block downtime %+v %v", g.Progress, err)
	}
}

// BIOS clock moved forward, reboot (§10.2, cheat #8): the boot hold keeps the crossed
// block enforced while offline; once completed unverified, a calibration resurrects it
// and reverts its points; a block created while T ran ahead is shifted back so it lasts
// exactly what it promised.
func TestCalibrationResurrectsAndShifts(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	a := env.create(durationReq(ModeNormal, 60, "youtube"))
	env.advance(30 * time.Minute)
	if err := env.e.Stop(); err != nil {
		t.Fatal(err)
	}
	env.net.SetOffline(true)
	env.clk.RebootAfter(5 * time.Minute)
	env.clk.JumpWall(3 * time.Hour) // the BIOS clock is 3 h ahead
	e := env.open()

	s := env.state()
	if s.Clock.Trust != TrustUnverified || s.Clock.BootHoldUntil == nil {
		t.Fatalf("clock after reboot %+v", s.Clock)
	}
	if e.block(a.ID).Status != StatusActive {
		t.Fatal("the boot hold must keep the crossed block enforced")
	}
	env.advance(3 * time.Minute) // the hold ends after 120 s without a time check
	rec := e.block(a.ID)
	if rec.Status != StatusCompleted || len(e.state.Clock.Unverified) != 1 {
		t.Fatalf("status %s, unverified %d", rec.Status, len(e.state.Clock.Unverified))
	}
	balance := e.state.Ledger.Balance
	if balance <= 0 {
		t.Fatalf("completion granted %d", balance)
	}
	b := env.create(durationReq(ModeNormal, 30, "instagram"))
	bRec := e.block(b.ID)
	bSpan := bRec.EndsAt - bRec.StartsAt

	env.net.SetOffline(false)
	env.clk.Advance(5 * time.Minute) // the backoff retry comes within 5 min
	e.Step()
	cal := env.eventsOf(EvClockJump)
	last := mustDecode[ClockJumpData](t, cal[len(cal)-1])
	if last.Source != "calibrate" || last.DeltaMs < 3*3600*1000-2000 {
		t.Fatalf("calibration jump %+v", last)
	}
	if len(last.ReactivatedBlockIDs) != 1 || last.ReactivatedBlockIDs[0] != a.ID {
		t.Fatalf("reactivated %v", last.ReactivatedBlockIDs)
	}
	if len(last.ShiftedBlockIDs) != 1 || last.ShiftedBlockIDs[0] != b.ID {
		t.Fatalf("shifted %v", last.ShiftedBlockIDs)
	}
	if re := env.eventsOf(EvBlockReactivated); len(re) != 1 || re[0].Points != -balance {
		t.Fatalf("block_reactivated %v", re)
	}
	if e.block(a.ID).Status != StatusActive || e.state.Ledger.Balance != 0 {
		t.Fatalf("a %s, balance %d", e.block(a.ID).Status, e.state.Ledger.Balance)
	}
	if e.trust() != TrustVerified || e.state.Clock.Restore != nil || len(e.state.Clock.Unverified) != 0 {
		t.Fatal("calibration must verify the clock and clear the restore jump")
	}
	// b still lasts exactly what it promised, measured in real time.
	if bRec.EndsAt-bRec.StartsAt != bSpan {
		t.Fatal("shift changed the span")
	}
	if rem := bRec.EndsAt - e.now; rem > 25*msPerMinute+1000 || rem < 25*msPerMinute-1000 {
		t.Fatalf("b remaining %d ms, want about 25 min", rem)
	}
	// a runs until its promised real end: 30 min were left at the stop, and 5 min 20 s
	// off, 3 min of hold and 5 min until the check passed since.
	if rem := e.block(a.ID).EndsAt - e.now; rem < 16*msPerMinute+30000 || rem > 16*msPerMinute+50000 {
		t.Fatalf("a remaining %d ms", rem)
	}
	env.advance(16 * time.Minute)
	if e.block(a.ID).Status != StatusActive {
		t.Fatal("a ended early after resurrection")
	}
	env.advance(10 * time.Minute)
	if e.block(a.ID).Status != StatusCompleted || e.block(b.ID).Status != StatusCompleted {
		t.Fatal("blocks did not complete")
	}
}

// A completion the restore jump did not cross is never resurrected.
func TestResurrectionOnlyForCrossedCompletions(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	a := env.create(durationReq(ModeNormal, 10, "youtube"))
	env.advance(11 * time.Minute) // completes verified before the reboot
	if err := env.e.Stop(); err != nil {
		t.Fatal(err)
	}
	env.clk.RebootAfter(time.Minute)
	env.clk.JumpWall(2 * time.Hour)
	e := env.open()
	env.advance(time.Minute)
	if len(env.eventsOf(EvBlockReactivated)) != 0 || e.block(a.ID).Status != StatusCompleted {
		t.Fatal("a completion before the reboot was resurrected")
	}
}
