package engine

import (
	"slices"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/awake"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// Keep-awake (docs/ARCHITECTURE.md §5.11, §10.14) with a fake inhibitor.

func kaReq(on bool, minutes *int, display bool) KeepAwakeRequest {
	return KeepAwakeRequest{On: on, DurationMinutes: minutes, Display: display}
}

func mins(n int) *int { return &n }

func (env *testEnv) setKA(req KeepAwakeRequest) KeepAwakeState {
	env.t.Helper()
	res, err := env.e.SetKeepAwake(bg, Request{Scope: "app"}, req)
	if err != nil {
		env.t.Fatalf("SetKeepAwake: %v", err)
	}
	return res.KeepAwake
}

func (env *testEnv) getKA() KeepAwakeState {
	env.t.Helper()
	res, err := env.e.GetKeepAwake(bg)
	if err != nil {
		env.t.Fatalf("GetKeepAwake: %v", err)
	}
	return res.KeepAwake
}

// kaEvents are the keep-awake events of the current epoch.
func (env *testEnv) kaEvents() []store.Event {
	var out []store.Event
	for _, ev := range env.events() {
		switch ev.Type {
		case EvKeepAwakeOn, EvKeepAwakeUpdated, EvKeepAwakeOff:
			out = append(out, ev)
		}
	}
	return out
}

func displayAt(t time.Time) string { return fmtTime(t) }

func strOr(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

// checkKAInvariants mirrors keepAwakeStateSchema.
func checkKAInvariants(t *testing.T, s KeepAwakeState) {
	t.Helper()
	if !s.On {
		if s.Since != nil || s.Until != nil || s.Active || (s.Error != nil && *s.Error != awake.ErrUnsupported) {
			t.Fatalf("off state breaks the invariants: %+v", s)
		}
		return
	}
	if s.Since == nil || (s.Until == nil) != (s.DurationMinutes == nil) {
		t.Fatalf("on state breaks the invariants: %+v", s)
	}
	if s.Active && s.Error != nil {
		t.Fatalf("active with an error: %+v", s)
	}
}

// Every transition of the §5.11 table: one single-event batch each, Δ 0, stateVersion
// bumped; identical requests change nothing and never restart the countdown.
func TestKeepAwakeTransitions(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()

	s := env.getKA()
	if s.On || s.DurationMinutes != nil || !s.Display || s.Active || s.Error != nil {
		t.Fatalf("fresh install %+v", s)
	}
	// Re-sending the default: nothing.
	v0 := env.state().StateVersion
	env.setKA(kaReq(false, nil, true))
	if n := len(env.kaEvents()); n != 0 {
		t.Fatalf("no-op wrote %d events", n)
	}
	if env.state().StateVersion != v0 {
		t.Fatal("a no-op bumped stateVersion")
	}

	// off → on (60 min).
	t0 := env.clk.Wall()
	s = env.setKA(kaReq(true, mins(60), true))
	checkKAInvariants(t, s)
	if !s.On || !s.Active || s.Error != nil || strOr(s.Since) != displayAt(t0) || strOr(s.Until) != displayAt(t0.Add(time.Hour)) {
		t.Fatalf("turned on %+v (since %s until %s)", s, strOr(s.Since), strOr(s.Until))
	}
	if !env.inh.Held() {
		t.Fatal("the inhibitor does not hold")
	}
	v1 := env.state().StateVersion
	if v1 <= v0 {
		t.Fatal("turning on did not bump stateVersion")
	}

	// A retried PUT five minutes later keeps the countdown.
	env.advance(5 * time.Minute)
	s = env.setKA(kaReq(true, mins(60), true))
	if strOr(s.Until) != displayAt(t0.Add(time.Hour)) || len(env.kaEvents()) != 1 {
		t.Fatalf("retry changed until %s or wrote an event", strOr(s.Until))
	}

	// Only the display: until kept.
	s = env.setKA(kaReq(true, mins(60), false))
	if s.Display || strOr(s.Until) != displayAt(t0.Add(time.Hour)) || strOr(s.Since) != displayAt(t0) {
		t.Fatalf("display change %+v", s)
	}
	// Another duration: the countdown restarts now.
	t1 := env.clk.Wall()
	s = env.setKA(kaReq(true, mins(120), false))
	if strOr(s.Until) != displayAt(t1.Add(2*time.Hour)) || strOr(s.Since) != displayAt(t0) {
		t.Fatalf("new duration until %s since %s", strOr(s.Until), strOr(s.Since))
	}
	// «Hasta que lo desactive».
	s = env.setKA(kaReq(true, nil, false))
	checkKAInvariants(t, s)
	if s.Until != nil || s.DurationMinutes != nil || !s.On {
		t.Fatalf("until turned off %+v", s)
	}
	// on → off: duration and display kept.
	s = env.setKA(kaReq(false, nil, false))
	checkKAInvariants(t, s)
	if s.On || s.Active || s.Since != nil || s.Until != nil || s.Display || s.DurationMinutes != nil {
		t.Fatalf("turned off %+v", s)
	}
	if env.inh.Held() {
		t.Fatal("the inhibitor still holds")
	}
	// off → off with another duration: stored.
	s = env.setKA(kaReq(false, mins(30), true))
	if s.On || s.DurationMinutes == nil || *s.DurationMinutes != 30 || !s.Display {
		t.Fatalf("off-to-off %+v", s)
	}

	evs := env.kaEvents()
	types := make([]string, len(evs))
	for i, ev := range evs {
		types[i] = ev.Type
		if ev.Points != 0 || ev.XP != 0 {
			t.Fatalf("%s has Δ %d / XP %d", ev.Type, ev.Points, ev.XP)
		}
	}
	want := []string{EvKeepAwakeOn, EvKeepAwakeUpdated, EvKeepAwakeUpdated, EvKeepAwakeUpdated, EvKeepAwakeOff, EvKeepAwakeUpdated}
	if !slices.Equal(types, want) {
		t.Fatalf("events %v, want %v", types, want)
	}
	on := mustDecode[KeepAwakeData](t, evs[0])
	if !on.KeepAwake.On || strOr(on.KeepAwake.Since) != evs[0].At || on.KeepAwake.Until == nil {
		t.Fatalf("keep_awake_on data %+v", on.KeepAwake)
	}
	off := mustDecode[KeepAwakeOffData](t, evs[4])
	if off.Reason != KeepAwakeOffUser || off.KeepAwake.On || off.KeepAwake.Since != nil || off.KeepAwake.Until != nil || off.KeepAwake.Display {
		t.Fatalf("keep_awake_off data %+v", off)
	}
	// Every change is a single-event batch.
	for _, ev := range evs {
		if !ev.TxEnd {
			t.Fatalf("event %d (%s) is not alone in its batch", ev.Seq, ev.Type)
		}
	}
	all := env.events()
	for i, ev := range all {
		if i > 0 && slices.ContainsFunc(evs, func(k store.Event) bool { return k.Seq == ev.Seq }) && !all[i-1].TxEnd {
			t.Fatalf("event %d (%s) joined a batch", ev.Seq, ev.Type)
		}
	}
	if b := e.state.Ledger.Balance; b != 0 {
		t.Fatalf("balance %d", b)
	}
	if !slices.Equal(env.inh.Holds()[len(env.inh.Holds())-1:], []bool{false}) {
		t.Fatalf("holds %v", env.inh.Holds())
	}
}

// The duration range comes with the keep-awake bounds; the ends are accepted.
func TestKeepAwakeValidation(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	for _, bad := range []int{4, 0, -30, 1441} {
		_, err := e.SetKeepAwake(bg, Request{}, kaReq(true, mins(bad), true))
		d := apiDetails(err)
		if apiCode(err) != "duration_out_of_range" || d["minMinutes"] != 5 || d["maxMinutes"] != 1440 || d["path"] != "durationMinutes" {
			t.Fatalf("%d minutes: %v %v", bad, err, d)
		}
	}
	if len(env.kaEvents()) != 0 || env.inh.Held() {
		t.Fatal("a refused request changed something")
	}
	for _, ok := range []int{5, 1440} {
		env.setKA(kaReq(true, mins(ok), true))
	}
}

// `until` passes on trusted time: keep_awake_off{expired}, released.
func TestKeepAwakeExpiry(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	env.setKA(kaReq(true, mins(30), true))
	env.advance(30*time.Minute - 2*time.Second)
	if s := env.getKA(); !s.On || !s.Active {
		t.Fatalf("ended early %+v", s)
	}
	env.advance(2 * time.Second)
	s := env.getKA()
	checkKAInvariants(t, s)
	if s.On || env.inh.Held() {
		t.Fatalf("not expired %+v", s)
	}
	if s.DurationMinutes == nil || *s.DurationMinutes != 30 || !s.Display {
		t.Fatalf("expiry lost the duration %+v", s)
	}
	offs := env.eventsOf(EvKeepAwakeOff)
	if len(offs) != 1 || mustDecode[KeepAwakeOffData](t, offs[0]).Reason != KeepAwakeOffExpired || offs[0].Points != 0 {
		t.Fatalf("keep_awake_off %v", offs)
	}
	env.advance(time.Minute)
	if len(env.eventsOf(EvKeepAwakeOff)) != 1 {
		t.Fatal("expired twice")
	}
}

// A restart keeps it running with the same until (state.json); a deadline that passed
// while the machine was off expires at startup before the inhibitor ever holds.
func TestKeepAwakeAcrossRestartsAndReboots(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	s := env.setKA(kaReq(true, mins(60), false))
	until := strOr(s.Until)
	env.clk.ServiceRestart(5 * time.Second)
	env.restart()
	if !env.inh.Held() {
		t.Fatal("not held after a restart")
	}
	if got := env.getKA(); !got.On || strOr(got.Until) != until || got.Display {
		t.Fatalf("after restart %+v", got)
	}

	// Rebuilt from the log alone.
	if err := env.e.Stop(); err != nil {
		t.Fatal(err)
	}
	removeFiles(t, env.dir, "state.json", "state.prev.json")
	env.open()
	if got := env.getKA(); !got.On || strOr(got.Until) != until {
		t.Fatalf("after a rebuild %+v", got)
	}

	// The machine is off past the deadline.
	env.shutdown()
	holds := len(env.inh.Holds())
	env.clk.RebootAfter(3 * time.Hour)
	env.open()
	if h := env.inh.Holds()[holds:]; slices.Contains(h, true) {
		t.Fatalf("held after the deadline: %v", h)
	}
	if got := env.getKA(); got.On {
		t.Fatalf("resumed after the deadline %+v", got)
	}
	evs := env.events()
	gs, off := -1, -1
	for i, ev := range evs {
		switch {
		case ev.Type == EvGuardianStarted:
			gs = i
		case ev.Type == EvKeepAwakeOff && mustDecode[KeepAwakeOffData](t, ev).Reason == KeepAwakeOffExpired:
			off = i
		}
	}
	if off < gs || gs < 0 {
		t.Fatalf("keep_awake_off{expired} at %d, guardian_started at %d", off, gs)
	}

	// «Hasta que lo desactive» survives a reboot.
	env.setKA(kaReq(true, nil, true))
	env.shutdown()
	env.clk.RebootAfter(10 * time.Hour)
	env.open()
	if got := env.getKA(); !got.On || !env.inh.Held() {
		t.Fatalf("indefinite keep-awake after a reboot %+v", got)
	}
}

// A wall-clock jump moves the display `until`; expiry stays on trusted time.
func TestKeepAwakeWallJump(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	start := env.clk.Wall()
	env.setKA(kaReq(true, mins(60), true))
	env.clk.JumpWall(2 * time.Hour)
	env.advance(2 * time.Second)
	if got := env.getKA(); strOr(got.Until) != displayAt(start.Add(3*time.Hour)) {
		t.Fatalf("display until %s after a +2 h jump", strOr(got.Until))
	}
	env.advance(60*time.Minute - 6*time.Second)
	if !env.getKA().On {
		t.Fatal("the wall jump ended it early")
	}
	env.advance(6 * time.Second)
	if env.getKA().On {
		t.Fatal("not expired on trusted time")
	}
}

// Safe mode accepts changes (the user must be able to turn it off); frozen mode refuses
// them and never holds.
func TestKeepAwakeModes(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	env.create(durationReq(ModeNormal, 60, "youtube"))
	for range 3 {
		env.e.crash()
		env.clk.ServiceRestart(5 * time.Second)
		env.open()
	}
	e := env.e
	if e.mode != ModeGuardianSafe {
		t.Fatalf("mode %s", e.mode)
	}
	if s := env.setKA(kaReq(true, mins(30), true)); !s.On || !s.Active || !env.inh.Held() {
		t.Fatalf("safe mode %+v", s)
	}
	if s := env.setKA(kaReq(false, mins(30), true)); s.On || env.inh.Held() {
		t.Fatalf("safe mode off %+v", s)
	}
	env.setKA(kaReq(true, mins(30), true))

	// Frozen while on: refused, reported as failed, never held.
	e.mode = ModeGuardianFrozen
	_, err := e.SetKeepAwake(bg, Request{}, kaReq(false, nil, true))
	if apiCode(err) != "read_only" || apiDetails(err)["reason"] != "schema_too_new" {
		t.Fatalf("frozen PUT: %v", err)
	}
	e.keepAwakeHold()
	if env.inh.Held() {
		t.Fatal("held in frozen mode")
	}
	if s := e.keepAwakeWire(); s.Active || s.Error == nil || *s.Error != awake.ErrFailed || !s.On {
		t.Fatalf("frozen state %+v", s)
	}
	e.mode = ModeGuardianSafe
}

// A real downgrade (a newer schema): frozen mode never holds.
func TestKeepAwakeFrozenNeverHolds(t *testing.T) {
	env := newTestEnv(t)
	o := env.options()
	o.SchemaVersion = store.SchemaVersion + 1
	newer, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	if err := newer.Open(); err != nil {
		t.Fatal(err)
	}
	env.e = newer
	env.setKA(kaReq(true, nil, true))
	if err := newer.Stop(); err != nil {
		t.Fatal(err)
	}
	holds := len(env.inh.Holds())
	env.clk.ServiceRestart(time.Second)
	e := env.open()
	if e.mode != ModeGuardianFrozen {
		t.Fatalf("mode %s", e.mode)
	}
	env.advance(10 * time.Second)
	if h := env.inh.Holds()[holds:]; slices.Contains(h, true) || env.inh.Held() {
		t.Fatalf("frozen mode held: %v", h)
	}
	if _, err := e.SetKeepAwake(bg, Request{}, kaReq(true, nil, true)); apiCode(err) != "read_only" {
		t.Fatalf("frozen PUT: %v", err)
	}
	checkKAInvariants(t, env.getKA())
}

// Data deletion keeps a running keep-awake with its since and until.
func TestKeepAwakeSurvivesDataDeletion(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	before := env.setKA(kaReq(true, mins(240), false))
	env.advance(time.Minute)
	if _, err := e.DeleteData(bg, Request{}, DeleteDataRequest{Confirm: "BORRAR"}); err != nil {
		t.Fatal(err)
	}
	after := env.getKA()
	if !after.On || strOr(after.Since) != strOr(before.Since) || strOr(after.Until) != strOr(before.Until) || after.Display || !env.inh.Held() {
		t.Fatalf("after deletion %+v, before %+v", after, before)
	}
	ep := env.eventsOf(EvEpochStarted)
	k := mustDecode[EpochStartedData](t, ep[len(ep)-1]).Kept.KeepAwake
	if k == nil || !k.On || k.Until == nil {
		t.Fatalf("kept.keepAwake %+v", k)
	}
	// The kept configuration survives a rebuild of the new epoch.
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	removeFiles(t, env.dir, "state.json", "state.prev.json")
	env.open()
	if got := env.getKA(); !got.On || strOr(got.Until) != strOr(before.Until) {
		t.Fatalf("rebuilt after deletion %+v", got)
	}
}

// A change of the inhibitor's status bumps stateVersion and shows in /v1/state.
func TestKeepAwakeStatusInState(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	st := env.state()
	if st.KeepAwake == nil || st.KeepAwake.On || st.KeepAwake.Error != nil {
		t.Fatalf("state.keepAwake %+v", st.KeepAwake)
	}
	// Unsupported, reported while off (a probe).
	env.inh.SetUnsupported(true)
	e.Step()
	st2 := env.state()
	if st2.StateVersion <= st.StateVersion || st2.KeepAwake.Error == nil || *st2.KeepAwake.Error != awake.ErrUnsupported {
		t.Fatalf("unsupported: version %d→%d, %+v", st.StateVersion, st2.StateVersion, st2.KeepAwake)
	}
	s := env.setKA(kaReq(true, mins(30), true))
	checkKAInvariants(t, s)
	if s.Active || s.Error == nil || *s.Error != awake.ErrUnsupported {
		t.Fatalf("on but unsupported %+v", s)
	}
	env.inh.SetUnsupported(false)
	e.Step()
	if s := env.getKA(); !s.Active || s.Error != nil {
		t.Fatalf("supported again %+v", s)
	}
	// The mechanism fails while on.
	v := env.state().StateVersion
	env.inh.SetFailing(true)
	e.Step()
	st3 := env.state()
	if st3.StateVersion <= v || st3.KeepAwake.Active || st3.KeepAwake.Error == nil || *st3.KeepAwake.Error != awake.ErrFailed {
		t.Fatalf("failing: version %d→%d, %+v", v, st3.StateVersion, st3.KeepAwake)
	}
	checkKAInvariants(t, *st3.KeepAwake)
	// Nothing else changes: no event, no points.
	if len(env.kaEvents()) != 1 || e.state.Ledger.Balance != 0 {
		t.Fatalf("events %d, balance %d", len(env.kaEvents()), e.state.Ledger.Balance)
	}
}

// Stop releases the inhibition (a clean stop, and so an uninstall).
func TestKeepAwakeReleasedOnStop(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	env.setKA(kaReq(true, nil, true))
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	if env.inh.Held() || !env.inh.Closed() {
		t.Fatal("still held after Stop")
	}
}

// Keep-awake never touches a block's credit, points or enforcement.
func TestKeepAwakeLeavesBlocksAlone(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	b := env.create(durationReq(ModeNormal, 30, "youtube"))
	domains := env.fh.Domains()
	extVer := e.state.Versions.ExtRules
	env.setKA(kaReq(true, mins(30), true))
	env.setKA(kaReq(true, mins(60), false))
	env.setKA(kaReq(false, mins(60), false))
	if e.state.Versions.ExtRules != extVer || !slices.Equal(env.fh.Domains(), domains) {
		t.Fatal("keep-awake changed enforcement")
	}
	env.advance(31 * time.Minute)
	if rec := e.block(b.ID); rec.Status != StatusCompleted || rec.CreditedMs != 30*60*1000 {
		t.Fatalf("block %s credited %d", rec.Status, rec.CreditedMs)
	}
}
