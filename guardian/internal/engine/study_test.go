package engine

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/points"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

// openWith opens an Engine on the directory with modified options.
func (env *testEnv) openWith(mod func(*Options)) *Engine {
	env.t.Helper()
	o := env.options()
	mod(&o)
	e, err := New(o)
	if err != nil {
		env.t.Fatalf("New: %v", err)
	}
	if err := e.Open(); err != nil {
		env.t.Fatalf("Open: %v", err)
	}
	env.e = e
	env.t.Cleanup(func() { _ = e.Stop() })
	return e
}

// setPolicy sets the punishment policy in force (what settings.punishment holds).
func (env *testEnv) setPolicy(level string, minutes int) {
	_ = env.e.exec(bg, func() {
		env.e.state.Settings.Punishment = PunishmentPolicy{Level: level, Minutes: minutes}
	})
}

// studyApp is the app side of one session: heartbeats with an increasing seq.
type studyApp struct {
	env *testEnv
	id  string
	seq int64
}

func (env *testEnv) startStudy(minutes int64, pomo *PomodoroSpec) (*studyApp, StudySession) {
	env.t.Helper()
	res, err := env.e.StartStudy(bg, Request{Scope: "app"}, StartStudyRequest{Task: "mates", PlannedMinutes: minutes, Pomodoro: pomo, Camera: true})
	if err != nil {
		env.t.Fatalf("StartStudy: %v", err)
	}
	return &studyApp{env: env, id: res.Session.ID}, res.Session
}

func (a *studyApp) beatWith(focusedMs, warnings int64) (HeartbeatResponse, error) {
	a.seq++
	return a.env.e.StudyHeartbeat(bg, Request{Scope: "app"}, a.id, HeartbeatRequest{
		Seq: a.seq, State: "focused", FocusedMsSinceLast: focusedMs, WarningsSinceLast: warnings, CameraOn: true,
	})
}

func (a *studyApp) beat(focusedMs int64) HeartbeatResponse {
	a.env.t.Helper()
	res, err := a.beatWith(focusedMs, 0)
	if err != nil {
		a.env.t.Fatalf("heartbeat: %v", err)
	}
	return res
}

// study lets d pass (awake) with a fully focused heartbeat every 15 s.
func (a *studyApp) study(d time.Duration) {
	a.env.t.Helper()
	const every = 15 * time.Second
	for d >= every {
		a.env.advance(every)
		a.beat(every.Milliseconds())
		d -= every
	}
	a.env.advance(d)
}

// idle lets d pass (awake) with a heartbeat claiming nothing every 15 s: the app is
// alive but reports no focus (breaks, pauses).
func (a *studyApp) idle(d time.Duration) {
	a.env.t.Helper()
	const every = 15 * time.Second
	for d >= every {
		a.env.advance(every)
		a.beat(0)
		d -= every
	}
	a.env.advance(d)
}

func (a *studyApp) strike(cause string) StrikeResponse {
	a.env.t.Helper()
	res, err := a.env.e.StudyStrike(bg, Request{Scope: "app"}, a.id, StrikeRequest{Cause: cause})
	if err != nil {
		a.env.t.Fatalf("strike: %v", err)
	}
	return res
}

func (a *studyApp) rec() *studyRec { return a.env.e.studySession(a.id) }

// ended returns the study_ended data of the session (failing if there is none).
func (a *studyApp) ended() (StudyEndedData, store.Event) {
	a.env.t.Helper()
	for _, ev := range a.env.eventsOf(EvStudyEnded) {
		d := mustDecode[StudyEndedData](a.env.t, ev)
		if d.SessionID == a.id {
			return d, ev
		}
	}
	a.env.t.Fatalf("no study_ended for %s: %v", a.id, types(a.env.events()))
	return StudyEndedData{}, store.Event{}
}

// focusLogged sums the focus_minutes of the session (per day when day != "").
func (a *studyApp) focusLogged(day string) int64 {
	var sum int64
	for _, ev := range a.env.eventsOf(EvFocusMinutes) {
		d := mustDecode[FocusMinutesData](a.env.t, ev)
		if d.SessionID == a.id && (day == "" || ev.Day == day) {
			sum += d.Minutes
		}
	}
	return sum
}

// lastBatch returns the types of the events of the last batch.
func (env *testEnv) lastBatch() []string {
	evs := env.events()
	i := len(evs) - 1
	for i > 0 && !evs[i-1].TxEnd {
		i--
	}
	return types(evs[i:])
}

func sumPoints(evs []store.Event) int64 {
	var s int64
	for _, ev := range evs {
		s += ev.Points
	}
	return s
}

func pointRules() points.PointRules { return points.DefaultPointRules() }

// ---------------------------------------------------------------------------------------
// Start, validation, snapshot
// ---------------------------------------------------------------------------------------

func TestStudyStartValidationAndSnapshot(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	start := func(req StartStudyRequest) error {
		_, err := e.StartStudy(bg, Request{}, req)
		return err
	}
	bad := []struct {
		req         StartStudyRequest
		path, issue string
	}{
		{StartStudyRequest{Task: strings.Repeat("a", limits().TaskMaxLength+1), PlannedMinutes: 25}, "task", "length"},
		{StartStudyRequest{Task: "a‮b", PlannedMinutes: 25}, "task", "pattern"},
		{StartStudyRequest{PlannedMinutes: int64(studyRules().PlannedMinutes.Min) - 1}, "plannedMinutes", "range"},
		{StartStudyRequest{PlannedMinutes: int64(studyRules().PlannedMinutes.Max) + 1}, "plannedMinutes", "range"},
		{StartStudyRequest{PlannedMinutes: 25, Pomodoro: &PomodoroSpec{WorkMinutes: 4, BreakMinutes: 5}}, "pomodoro.workMinutes", "range"},
		{StartStudyRequest{PlannedMinutes: 25, Pomodoro: &PomodoroSpec{WorkMinutes: 25, BreakMinutes: 61}}, "pomodoro.breakMinutes", "range"},
	}
	for _, c := range bad {
		err := start(c.req)
		if apiCode(err) != "validation_failed" || apiDetails(err)["path"] != c.path || apiDetails(err)["issue"] != c.issue {
			t.Fatalf("%s: %v %v", c.path, err, apiDetails(err))
		}
	}
	if len(env.eventsOf(EvStudyStarted)) != 0 {
		t.Fatal("an invalid request logged a session")
	}

	idem := &Idempotency{Lookup: "s1", Scope: "app", Method: "POST", Path: "/v1/study/sessions", RequestHash: "h", Req: "0123456789abcdef0123456789abcdef"}
	req := StartStudyRequest{Task: "historia", PlannedMinutes: 25, Camera: true}
	res, err := e.StartStudy(bg, Request{Scope: "app", Idem: idem}, req)
	if err != nil {
		t.Fatal(err)
	}
	s := res.Session
	now := e.now
	def := embedded.API().DefaultSettings.Punishment
	if s.Status != "active" || s.Phase != "work" || s.Task != "historia" || !s.Camera || s.Policy != def ||
		s.PausesLeft != int64(studyRules().MaxPausesPerWindow) || s.LastHeartbeatAt != nil || s.EndedAt != nil ||
		s.StartedAt != fmtMs(now) || s.PlannedEndsAt != fmtMs(now+25*msPerMinute) || s.PhaseEndsAt == nil ||
		*s.PhaseEndsAt != s.PlannedEndsAt || s.CooldownUntil != nil || s.NextPauseAvailableAt != nil {
		t.Fatalf("session %+v", s)
	}
	started := env.eventsOf(EvStudyStarted)
	if len(started) != 1 || started[0].Req == nil || *started[0].Req != idem.Req || started[0].Points != 0 {
		t.Fatalf("study_started %+v", started)
	}
	if snap := mustDecode[StudyStartedData](t, started[0]).Session; snap.ID != s.ID || snap.Policy != def || snap.PlannedEndsAt != s.PlannedEndsAt {
		t.Fatalf("snapshot %+v", snap)
	}
	// A retry with the same key replays the stored body; a new start is refused.
	_, err = e.StartStudy(bg, Request{Scope: "app", Idem: idem}, req)
	var rep *ReplayedResponse
	body, _ := EncodeResponse(res)
	if !errors.As(err, &rep) || rep.Status != 201 || !bytes.Equal(rep.Body, body) {
		t.Fatalf("replay %v", err)
	}
	if err := start(req); apiCode(err) != "study_already_active" || apiDetails(err)["sessionId"] != s.ID {
		t.Fatalf("second session: %v", err)
	}
	cur, err := e.CurrentStudy(bg)
	if err != nil || cur.Session == nil || cur.Session.ID != s.ID {
		t.Fatalf("current %+v %v", cur, err)
	}
	if st := env.state(); st.Study == nil || st.Study.ID != s.ID || st.Recent.EndedStudy != nil {
		t.Fatalf("state.study %+v", st.Study)
	}
	d, err := e.GetStudySession(bg, s.ID)
	if err != nil || d.Summary != nil || d.Session.ID != s.ID {
		t.Fatalf("detail %+v %v", d, err)
	}
	if _, err := e.GetStudySession(bg, "stu_0000000000000000000000"); apiCode(err) != "not_found" {
		t.Fatalf("unknown session: %v", err)
	}
	// The wire has every list and timestamp in the contract format.
	raw, _ := json.Marshal(cur.Session)
	for _, k := range []string{`"pomodoro":null`, `"endedAt":null`, `"achieved":null`, `"policy":{"level":"distractions"`} {
		if !strings.Contains(string(raw), k) {
			t.Fatalf("%s lacks %s", raw, k)
		}
	}
}

// ---------------------------------------------------------------------------------------
// §15: a 60-minute session with heartbeats every 15 s at any phase logs exactly 60
// ---------------------------------------------------------------------------------------

func TestStudySixtyMinutesAtAnyPhase(t *testing.T) {
	// tick: first tick after the start (ms, on the 2 s grid); hb: phase of the app's 15 s
	// heartbeat grid, on which it measures focus; each heartbeat then reaches the guardian
	// up to 2 s late (a different delay each time); final: the last heartbeat, sent this
	// long after the planned end (-1: none, the grace runs out).
	cases := []struct{ tick, hb, final int64 }{
		{0, 0, 0}, {1, 7, 1500}, {999, 7503, -1}, {1999, 14999, 1999},
		{500, 1000, 0}, {1500, 12345, -1}, {1234, 5, 700}, {1, 14000, 2000},
	}
	const plannedMin = 60
	planned := int64(plannedMin) * msPerMinute
	for _, c := range cases {
		t.Run(fmt.Sprintf("tick%d_hb%d_final%d", c.tick, c.hb, c.final), func(t *testing.T) {
			env := newTestEnv(t)
			e := env.open()
			app, _ := env.startStudy(plannedMin, nil)
			type step struct {
				at     int64 // delivery (tick) time since the start
				hb     bool
				report int64 // focusedMsSinceLast the app measured
				final  bool
			}
			var steps []step
			for at := c.tick; at <= planned+30_000; at += tickInterval.Milliseconds() {
				if at > 0 {
					steps = append(steps, step{at: at})
				}
			}
			var measured, delivered int64
			for k := int64(1); c.hb+15_000*k <= planned; k++ {
				m := c.hb + 15_000*k
				delay := (k*7919 + c.tick*104_729 + c.hb) % tickInterval.Milliseconds()
				steps = append(steps, step{at: m + delay, hb: true, report: m - measured})
				measured, delivered = m, m+delay
			}
			if c.final >= 0 {
				// One client sends in order: the final heartbeat follows the last regular one.
				steps = append(steps, step{at: max(planned+c.final, delivered+1), hb: true, report: planned + c.final - measured, final: true})
			}
			slices.SortStableFunc(steps, func(a, b step) int { return cmp.Compare(a.at, b.at) })
			var now, accepted int64
			done := false
			for _, s := range steps {
				env.clk.Advance(time.Duration(s.at-now) * time.Millisecond)
				now = s.at
				if !s.hb {
					e.Step()
					continue
				}
				if done {
					continue
				}
				res := app.beat(s.report)
				// Every measured interval before the planned end is accepted in full: the
				// unclaimed time is subtracted, never reset, so delivery delays lose nothing.
				if want := min(s.report, min(now, planned)-accepted); res.AcceptedFocusMs != want || (!s.final && now <= planned && want != s.report) {
					t.Fatalf("at %d accepted %d, want %d (report %d)", now, res.AcceptedFocusMs, want, s.report)
				}
				accepted += res.AcceptedFocusMs
				done = res.Session.Status != "active"
			}
			// With a final heartbeat every eligible millisecond is accepted, unless the last
			// regular heartbeat (measured before the planned end) arrives after it: §10.4
			// takes the first heartbeat of the grace as the last one, and the end rounding
			// absorbs the unclaimed tail (< 30 s), as the minutes checked below show.
			if exact := measured == planned || delivered < planned; c.final >= 0 && exact && accepted != planned {
				t.Fatalf("accepted %d of %d", accepted, planned)
			}
			if accepted < planned-15_000 {
				t.Fatalf("accepted %d of %d", accepted, planned)
			}
			d, ev := app.ended()
			bonus := int64(pointRules().CleanSessionBonus)
			perMin := int64(pointRules().StudyPointsPerFocusMinute)
			if d.Outcome != "completed" || d.FocusedMinutes != plannedMin || d.ActiveMinutes != plannedMin ||
				d.WorkMinutes != plannedMin || d.FocusPct != 100 || d.CleanBonus != bonus || ev.Points != bonus ||
				d.PointsTotal != plannedMin*perMin+bonus || !ev.TxEnd {
				t.Fatalf("study_ended %+v points %d", d, ev.Points)
			}
			if got := app.focusLogged(""); got != plannedMin {
				t.Fatalf("focus_minutes sum %d", got)
			}
			if b := e.state.Ledger.Balance; b != plannedMin*perMin+bonus {
				t.Fatalf("balance %d", b)
			}
			if e.state.Ledger.XP != plannedMin*int64(pointRules().XPPerFocusMinute) {
				t.Fatalf("xp %d", e.state.Ledger.XP)
			}
		})
	}
}

// ---------------------------------------------------------------------------------------
// Heartbeats
// ---------------------------------------------------------------------------------------

func TestStudyHeartbeatAcceptance(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	app, _ := env.startStudy(30, nil)

	// Nothing is eligible yet; then only the work-phase awake time since the start.
	if r := app.beat(5000); r.AcceptedFocusMs != 0 || r.Duplicate || r.HeartbeatDeadlineMs != int64(studyRules().HeartbeatTimeoutMs) {
		t.Fatalf("first %+v", r)
	}
	env.advance(10 * time.Second)
	if r := app.beat(15000); r.AcceptedFocusMs != 10000 {
		t.Fatalf("capped by eligible time: %+v", r)
	}
	// A repeated or older seq is a no-op.
	for _, seq := range []int64{app.seq, app.seq - 1} {
		r, err := e.StudyHeartbeat(bg, Request{}, app.id, HeartbeatRequest{Seq: seq, State: "focused", FocusedMsSinceLast: 9000})
		if err != nil || !r.Duplicate || r.AcceptedFocusMs != 0 || r.Session.LastHeartbeatSeq != app.seq {
			t.Fatalf("duplicate %d: %+v %v", seq, r, err)
		}
	}
	// Warnings add up; the flush comes at focusFlushMinutes whole minutes.
	env.advance(5 * time.Second)
	if _, err := app.beatWith(5000, 2); err != nil {
		t.Fatal(err)
	}
	app.study(4*time.Minute + 45*time.Second) // 5:00 accepted
	fm := env.eventsOf(EvFocusMinutes)
	if len(fm) != 1 || mustDecode[FocusMinutesData](t, fm[0]).Minutes != int64(studyRules().FocusFlushMinutes) ||
		fm[0].Points != int64(studyRules().FocusFlushMinutes)*int64(pointRules().StudyPointsPerFocusMinute) {
		t.Fatalf("flush %v", types(fm))
	}
	env.advance(15 * time.Second)
	r, err := app.beatWith(15000, 3)
	if err != nil {
		t.Fatal(err)
	}
	if r.Session.Warnings != 5 || r.Session.LastHeartbeatAt == nil || *r.Session.LastHeartbeatAt != fmtMs(e.now) || r.Session.LastHeartbeatSeq != app.seq {
		t.Fatalf("session %+v", r.Session)
	}
	app.study(time.Minute + 15*time.Second) // 6:30 accepted, 5 logged
	st := env.state()
	if st.Points.PendingFocusMinutes != 1 || st.Study.FocusedMinutes != 6 || st.Study.ActiveMinutes != 6 {
		t.Fatalf("pending %d focused %d active %d", st.Points.PendingFocusMinutes, st.Study.FocusedMinutes, st.Study.ActiveMinutes)
	}
	// Unclaimed eligible time is capped: 11 min alive without claiming, then a claim.
	app.idle(11 * time.Minute)
	if r := app.beat(int64(limits().HeartbeatMaxFocusMs)); r.AcceptedFocusMs != int64(limits().HeartbeatMaxFocusMs) {
		t.Fatalf("cap %+v", r.AcceptedFocusMs)
	}
	env.advance(4 * time.Second)
	if r := app.beat(int64(limits().HeartbeatMaxFocusMs)); r.AcceptedFocusMs != 4000 {
		t.Fatalf("after the cap %+v", r.AcceptedFocusMs)
	}

	// Validation and unknown sessions.
	for _, c := range []struct {
		req         HeartbeatRequest
		path, issue string
	}{
		{HeartbeatRequest{Seq: 0, State: "focused"}, "seq", "range"},
		{HeartbeatRequest{Seq: 99, State: "sleepy"}, "state", "enum"},
		{HeartbeatRequest{Seq: 99, State: "doubt", FocusScore: ptr(int64(101))}, "focusScore", "range"},
		{HeartbeatRequest{Seq: 99, State: "away", FocusedMsSinceLast: int64(limits().HeartbeatMaxFocusMs) + 1}, "focusedMsSinceLast", "range"},
		{HeartbeatRequest{Seq: 99, State: "break", WarningsSinceLast: int64(limits().HeartbeatMaxWarnings) + 1}, "warningsSinceLast", "range"},
	} {
		_, err := e.StudyHeartbeat(bg, Request{}, app.id, c.req)
		if apiCode(err) != "validation_failed" || apiDetails(err)["path"] != c.path || apiDetails(err)["issue"] != c.issue {
			t.Fatalf("%s: %v", c.path, err)
		}
	}
	if _, err := e.StudyHeartbeat(bg, Request{}, "stu_0000000000000000000000", HeartbeatRequest{Seq: 1, State: "focused"}); apiCode(err) != "not_found" {
		t.Fatalf("unknown: %v", err)
	}
}

// ---------------------------------------------------------------------------------------
// Pomodoro
// ---------------------------------------------------------------------------------------

func TestStudyPomodoroPhases(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	var preset embedded.PomodoroPreset
	for _, p := range embedded.Rules().PomodoroPresets {
		if p.ID == "25-5" {
			preset = p
		}
	}
	planned := int64(preset.Cycles*(preset.WorkMinutes+preset.BreakMinutes) - preset.BreakMinutes)
	work := int64(preset.Cycles * preset.WorkMinutes)
	pomo := &PomodoroSpec{WorkMinutes: int64(preset.WorkMinutes), BreakMinutes: int64(preset.BreakMinutes)}
	app, s := env.startStudy(planned, pomo)
	t0 := e.now
	if s.Phase != "work" || *s.PhaseEndsAt != fmtMs(t0+int64(preset.WorkMinutes)*msPerMinute) {
		t.Fatalf("first phase %+v", s)
	}
	app.study(time.Duration(preset.WorkMinutes) * time.Minute)
	st := env.state().Study
	if st.Phase != "break" || *st.PhaseEndsAt != fmtMs(e.now+int64(preset.BreakMinutes)*msPerMinute) {
		t.Fatalf("break %+v", st)
	}
	// Breaks never strike, and claim nothing.
	if r := app.strike("phone"); r.Counted || r.Reason == nil || *r.Reason != "not_in_work_phase" || r.StrikeNumber != 0 || r.PointsDelta != 0 {
		t.Fatalf("strike in a break %+v", r)
	}
	env.advance(15 * time.Second)
	if r := app.beat(15000); r.AcceptedFocusMs != 0 {
		t.Fatalf("break focus accepted %d", r.AcceptedFocusMs)
	}
	// The app claims full focus throughout; only work time is accepted.
	app.study(time.Duration(planned)*time.Minute - time.Duration(preset.WorkMinutes)*time.Minute - 30*time.Second)
	env.advance(16 * time.Second) // the planned end passes; the app sees it and sends the last heartbeat
	final := app.beat(16000)
	if final.Session.Status != "completed" {
		t.Fatalf("not completed by the final heartbeat: %+v", final.Session)
	}
	d, _ := app.ended()
	if d.PlannedMinutes != planned || d.ActiveMinutes != planned || d.WorkMinutes != work || d.FocusedMinutes != work ||
		d.FocusPct != 100 || d.CleanBonus != int64(pointRules().CleanSessionBonus) {
		t.Fatalf("summary %+v", d)
	}
}

// ---------------------------------------------------------------------------------------
// Pauses
// ---------------------------------------------------------------------------------------

func TestStudyPauses(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	app, _ := env.startStudy(120, nil)
	pause := func() (StudySession, error) {
		r, err := e.PauseStudy(bg, Request{}, app.id)
		return r.Session, err
	}
	resume := func() (StudySession, error) {
		r, err := e.ResumeStudy(bg, Request{}, app.id)
		return r.Session, err
	}
	app.study(time.Minute)
	firstWall := env.clk.Wall()
	s, err := pause()
	firstAwake := e.awakeNow
	pauseMs := int64(studyRules().PauseMs)
	if err != nil || s.Status != "paused" || s.Phase != "paused" || *s.PhaseEndsAt != fmtMs(e.now+pauseMs) || s.PausesLeft != 1 {
		t.Fatalf("pause %+v %v", s, err)
	}
	if _, err := pause(); apiCode(err) != "already_paused" {
		t.Fatalf("pause twice: %v", err)
	}
	// Paused time is not active time and strikes do not count.
	app.idle(2 * time.Minute)
	if r := app.strike("no_face"); r.Counted || *r.Reason != "not_in_work_phase" {
		t.Fatalf("strike while paused %+v", r)
	}
	if s, err = resume(); err != nil || s.Status != "active" || s.ActiveMinutes != 1 {
		t.Fatalf("resume %+v %v", s, err)
	}
	if _, err := resume(); apiCode(err) != "not_paused" {
		t.Fatalf("resume twice: %v", err)
	}
	// The second pause auto-resumes after pauseMs.
	app.study(time.Minute)
	if s, err = pause(); err != nil || s.PausesLeft != 0 || s.NextPauseAvailableAt == nil {
		t.Fatalf("second pause %+v %v", s, err)
	}
	app.idle(time.Duration(pauseMs)*time.Millisecond + 4*time.Second)
	auto := env.eventsOf(EvStudyResumed)
	if len(auto) != 2 || !mustDecode[StudyResumedData](t, auto[1]).Auto || mustDecode[StudyResumedData](t, auto[0]).Auto {
		t.Fatalf("auto-resume %v", types(auto))
	}
	if cur := env.state().Study; cur.Status != "active" || cur.ActiveMinutes != 2 {
		t.Fatalf("after auto-resume %+v", cur)
	}
	// Two pauses within the last hour of awake time: the third waits.
	window := time.Duration(studyRules().PauseWindowMs) * time.Millisecond
	wantNext := fmtTime(firstWall.Add(window))
	_, err = pause()
	if apiCode(err) != "pause_quota_exhausted" || apiDetails(err)["nextPauseAt"] != wantNext {
		t.Fatalf("third pause: %v %v (want %s)", err, apiDetails(err), wantNext)
	}
	// Suspended time is not awake time: the window does not move.
	env.clk.Suspend(30 * time.Minute)
	app.beat(0)
	_, err = pause()
	if apiCode(err) != "pause_quota_exhausted" || apiDetails(err)["nextPauseAt"] != fmtTime(firstWall.Add(window+30*time.Minute)) {
		t.Fatalf("after a suspend: %v %v", err, apiDetails(err))
	}
	if cur := env.state().Study; cur.NextPauseAvailableAt == nil || *cur.NextPauseAvailableAt != apiDetails(err)["nextPauseAt"] {
		t.Fatalf("nextPauseAvailableAt %+v", cur.NextPauseAvailableAt)
	}
	// Once the first pause leaves the window, one pause is available again.
	app.study(window - (e.awakeNow - firstAwake) + 15*time.Second)
	if s, err = pause(); err != nil || s.PausesLeft != 0 {
		t.Fatalf("pause after the window: %+v %v", s, err)
	}
	// A pause whose end passed during a suspend resumes at wake-up.
	env.clk.Suspend(time.Duration(pauseMs+60_000) * time.Millisecond)
	e.Step()
	if cur := env.state().Study; cur.Status != "active" {
		t.Fatalf("not resumed after a suspend %+v", cur)
	}
}

// ---------------------------------------------------------------------------------------
// Strikes and punishments
// ---------------------------------------------------------------------------------------

func TestStudyThreeStrikesPunish(t *testing.T) {
	for _, level := range []string{"distractions", "whitelist", "nuclear"} {
		t.Run(level, func(t *testing.T) {
			env := newTestEnv(t)
			e := env.open()
			env.setPolicy(level, 15)
			app, s := env.startStudy(60, nil)
			if s.Policy.Level != level || s.Policy.Minutes != 15 {
				t.Fatalf("policy %+v", s.Policy)
			}
			// A later settings change never affects the snapshot.
			env.setPolicy("distractions", 120)
			app.study(time.Minute)
			strikePen := int64(pointRules().StrikePenalty)

			idem := &Idempotency{Lookup: "k-" + level, Scope: "app", Method: "POST", Path: "/v1/study/sessions/" + app.id + "/strike", RequestHash: "h", Req: "00112233445566778899aabbccddeeff"}
			r1, err := e.StudyStrike(bg, Request{Scope: "app", Idem: idem}, app.id, StrikeRequest{Cause: "no_face"})
			cool := int64(studyRules().StrikeCooldownMs)
			if err != nil || !r1.Counted || r1.Reason != nil || r1.StrikeNumber != 1 || r1.PointsDelta != -strikePen ||
				r1.PunishmentPointsDelta != 0 || r1.Punishment != nil || r1.CooldownUntil == nil || *r1.CooldownUntil != fmtMs(e.now+cool) {
				t.Fatalf("strike 1 %+v %v", r1, err)
			}
			_, err = e.StudyStrike(bg, Request{Scope: "app", Idem: idem}, app.id, StrikeRequest{Cause: "no_face"})
			var rep *ReplayedResponse
			body, _ := EncodeResponse(r1)
			if !errors.As(err, &rep) || !bytes.Equal(rep.Body, body) || len(env.eventsOf(EvStrike)) != 1 {
				t.Fatalf("strike replay: %v", err)
			}
			// The 60 s margin, on awake time: a suspend does not shorten it.
			if r := app.strike("phone"); r.Counted || *r.Reason != "cooldown" || r.StrikeNumber != 1 || r.CooldownUntil == nil {
				t.Fatalf("cooldown %+v", r)
			}
			env.clk.Suspend(2 * time.Minute)
			app.beat(0)
			if r := app.strike("phone"); r.Counted || *r.Reason != "cooldown" {
				t.Fatalf("cooldown after a suspend %+v", r)
			}
			app.study(time.Minute)
			if r := app.strike("doubt_timeout"); !r.Counted || r.StrikeNumber != 2 {
				t.Fatalf("strike 2 %+v", r)
			}
			app.study(time.Minute)
			r3 := app.strike("distraction_app")
			punPen := int64(pointRules().PunishmentPenalty)
			if !r3.Counted || r3.StrikeNumber != 3 || r3.PointsDelta != -strikePen-punPen || r3.PunishmentPointsDelta != -punPen ||
				r3.Session.Status != "punished" || r3.Session.Phase != "ended" || r3.CooldownUntil != nil || r3.Punishment == nil {
				t.Fatalf("strike 3 %+v", r3)
			}
			p := r3.Punishment
			if p.Level != level || p.Minutes != 15 || p.Cause != "three_strikes" || p.Task != "mates" || p.SessionID == nil ||
				*p.SessionID != app.id || p.Status != "active" || p.EndsAt != fmtMs(e.now+15*msPerMinute) {
				t.Fatalf("punishment %+v", p)
			}
			batch := env.lastBatch()
			want := []string{EvStrike, EvFocusMinutes, EvStudyEnded, EvBlockCreated, EvPunishmentStarted}
			if !slices.Equal(batch, want) {
				t.Fatalf("batch %v, want %v", batch, want)
			}
			created := env.eventsOf(EvBlockCreated)
			blk := mustDecode[BlockCreatedData](t, created[len(created)-1])
			if blk.Source != "punishment" || blk.Block.Kind != KindPunishment || blk.Block.Mode != ModeStrict ||
				blk.Block.PunishmentID == nil || *blk.Block.PunishmentID != p.ID {
				t.Fatalf("block %+v", blk)
			}
			if level == "whitelist" {
				if !blk.Block.WhitelistOnly || len(blk.Block.Targets.CategoryIDs) != 0 {
					t.Fatalf("whitelist block %+v", blk.Block)
				}
			} else if blk.Block.WhitelistOnly || !slices.Equal(blk.Block.Targets.CategoryIDs, e.cat.CategoryIDs()) {
				t.Fatalf("distractions block %+v", blk.Block)
			}
			st := env.state()
			if st.NuclearActive != (level == "nuclear") || len(st.Punishments) != 1 || st.Study != nil {
				t.Fatalf("state nuclear %v punishments %d study %v", st.NuclearActive, len(st.Punishments), st.Study)
			}
			d, _ := app.ended()
			focus := app.focusLogged("")
			perMin := int64(pointRules().StudyPointsPerFocusMinute)
			if d.Outcome != "punished" || d.Strikes != 3 || d.CleanBonus != 0 || focus != 3 ||
				d.PointsTotal != focus*perMin-3*strikePen-punPen {
				t.Fatalf("summary %+v focus %d", d, focus)
			}
			if rec := st.Recent.EndedStudy; rec == nil || rec.Summary == nil || rec.Summary.PointsTotal != d.PointsTotal || rec.Session.Status != "punished" {
				t.Fatalf("recent.endedStudy %+v", rec)
			}
			// Every points event is in the ledger.
			if e.state.Ledger.Balance != sumPoints(env.events()) {
				t.Fatalf("balance %d vs %d", e.state.Ledger.Balance, sumPoints(env.events()))
			}
			// The session is over: mutations are refused, …/end returns the summary.
			_, err = e.StudyHeartbeat(bg, Request{}, app.id, HeartbeatRequest{Seq: 999, State: "focused"})
			if apiCode(err) != "study_not_active" || apiDetails(err)["status"] != "punished" {
				t.Fatalf("heartbeat after: %v", err)
			}
			for _, f := range []func() error{
				func() error {
					_, err := e.StudyStrike(bg, Request{}, app.id, StrikeRequest{Cause: "phone"})
					return err
				},
				func() error { _, err := e.PauseStudy(bg, Request{}, app.id); return err },
				func() error { _, err := e.ResumeStudy(bg, Request{}, app.id); return err },
			} {
				if err := f(); apiCode(err) != "study_not_active" {
					t.Fatalf("mutation after the end: %v", err)
				}
			}
			end, err := e.EndStudy(bg, Request{}, app.id, EndStudyRequest{Reason: "user", FocusedMsSinceLast: 5000})
			if err != nil || end.Summary.Outcome != "punished" || end.Summary.PointsTotal != d.PointsTotal || end.Session.Status != "punished" {
				t.Fatalf("end after the punishment %+v %v", end, err)
			}
		})
	}
}

// ---------------------------------------------------------------------------------------
// Abandonment
// ---------------------------------------------------------------------------------------

func TestStudyAbandonment(t *testing.T) {
	timeout := time.Duration(studyRules().HeartbeatTimeoutMs) * time.Millisecond

	t.Run("silence punishes", func(t *testing.T) {
		env := newTestEnv(t)
		e := env.open()
		app, _ := env.startStudy(60, nil)
		app.study(time.Minute)
		env.advance(timeout - time.Second)
		app.beat(0) // just in time
		// Suspended time never counts.
		env.clk.Suspend(10 * time.Minute)
		env.advance(timeout - 2*time.Second)
		if app.rec().Status != "active" {
			t.Fatalf("abandoned while suspended: %s", app.rec().Status)
		}
		env.advance(4 * time.Second)
		d, _ := app.ended()
		if d.Outcome != "abandoned" || d.CleanBonus != 0 {
			t.Fatalf("summary %+v", d)
		}
		if b := env.lastBatch(); !slices.Equal(b, []string{EvFocusMinutes, EvStudyEnded, EvBlockCreated, EvPunishmentStarted}) {
			t.Fatalf("batch %v", b)
		}
		st := env.state()
		def := embedded.API().DefaultSettings.Punishment
		if len(st.Punishments) != 1 || st.Punishments[0].Cause != "abandoned" || st.Punishments[0].Level != def.Level ||
			st.Punishments[0].Minutes != int64(def.Minutes) || st.Recent.EndedStudy == nil || st.Recent.EndedStudy.Session.Status != "abandoned" {
			t.Fatalf("state %+v", st.Punishments)
		}
		if _, err := app.beatWith(1000, 0); apiCode(err) != "study_not_active" {
			t.Fatalf("heartbeat after abandonment: %v", err)
		}
		_ = e
	})

	t.Run("never after the planned end", func(t *testing.T) {
		env := newTestEnv(t)
		env.open()
		app, _ := env.startStudy(5, nil)
		app.study(4 * time.Minute)
		env.advance(3 * time.Minute) // the app died 60 s before the planned end
		d, _ := app.ended()
		if d.Outcome != "completed" || d.FocusedMinutes != 4 || len(env.eventsOf(EvPunishmentStarted)) != 0 {
			t.Fatalf("summary %+v", d)
		}
	})

	t.Run("a guardian restart resets the silence", func(t *testing.T) {
		env := newTestEnv(t)
		e := env.open()
		app, _ := env.startStudy(60, nil)
		app.beat(0)
		env.advance(100 * time.Second)
		if err := e.Stop(); err != nil {
			t.Fatal(err)
		}
		env.clk.ServiceRestart(time.Minute)
		e = env.open()
		env.advance(100 * time.Second)
		if s := env.state().Study; s == nil || s.Status != "active" || s.ActiveMinutes != 3 {
			t.Fatalf("after the restart %+v", s)
		}
		env.advance(30 * time.Second)
		if d, _ := app.ended(); d.Outcome != "abandoned" {
			t.Fatalf("summary %+v", d)
		}
		_ = e
	})

	t.Run("a failed flush still counts as a signal", func(t *testing.T) {
		env := newTestEnv(t)
		ffs := newFaultFS()
		env.fs = ffs
		e := env.open()
		app, _ := env.startStudy(60, nil)
		app.study(4*time.Minute + 45*time.Second)
		ffs.setFailAppend(true)
		env.advance(15 * time.Second)
		if _, err := app.beatWith(15000, 0); apiCode(err) != "read_only" {
			t.Fatalf("flush on a full disk: %v", err)
		}
		env.advance(timeout - 10*time.Second) // 125 s since the last accepted heartbeat
		ffs.setFailAppend(false)
		r := app.beat(125000)
		if r.Session.Status != "active" || r.AcceptedFocusMs != 125000 || app.focusLogged("") != 6 {
			t.Fatalf("after the full disk %+v", r)
		}
		_ = e
	})
}

// ---------------------------------------------------------------------------------------
// Interruption, end, outcome, history
// ---------------------------------------------------------------------------------------

func TestStudyInterrupted(t *testing.T) {
	t.Run("reboot", func(t *testing.T) {
		env := newTestEnv(t)
		e := env.open()
		app, _ := env.startStudy(60, nil)
		app.study(7*time.Minute + 15*time.Second)
		if err := e.Stop(); err != nil {
			t.Fatal(err)
		}
		env.clk.RebootAfter(time.Minute)
		e = env.open()
		d, _ := app.ended()
		if d.Outcome != "interrupted" || d.FocusedMinutes != 7 || d.CleanBonus != 0 || app.focusLogged("") != 7 {
			t.Fatalf("summary %+v", d)
		}
		if len(env.eventsOf(EvPunishmentStarted)) != 0 || len(env.eventsOf(EvStrike)) != 0 {
			t.Fatal("an interruption is never penalized")
		}
		st := env.state()
		if st.Study != nil || st.Recent.EndedStudy == nil || st.Recent.EndedStudy.Session.Status != "interrupted" {
			t.Fatalf("state %+v", st.Recent.EndedStudy)
		}
		_ = e
	})
	t.Run("logoff", func(t *testing.T) {
		env := newTestEnv(t)
		e := env.open()
		app, _ := env.startStudy(60, nil)
		app.study(time.Minute)
		if err := e.ReportLogoff(bg); err != nil {
			t.Fatal(err)
		}
		if d, _ := app.ended(); d.Outcome != "interrupted" || d.FocusedMinutes != 1 {
			t.Fatalf("summary %+v", d)
		}
		if err := e.ReportLogoff(bg); err != nil || len(env.eventsOf(EvStudyEnded)) != 1 {
			t.Fatalf("second logoff: %v", err)
		}
	})
}

func TestStudyEnd(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	end := func(id string, focused, warnings int64) (EndStudyResponse, error) {
		return e.EndStudy(bg, Request{Scope: "app"}, id, EndStudyRequest{Reason: "user", FocusedMsSinceLast: focused, WarningsSinceLast: warnings})
	}

	// Early end: the last interval is closed like a heartbeat; no penalty, no bonus.
	app, _ := env.startStudy(30, nil)
	app.study(10 * time.Minute)
	env.advance(20 * time.Second)
	r, err := end(app.id, 20000, 1)
	if err != nil || r.Session.Status != "ended_early" || r.Summary.Outcome != "ended_early" || r.Summary.CleanBonus != 0 ||
		r.Summary.FocusedMinutes != 10 || r.Summary.ActiveMinutes != 10 || r.Summary.Warnings != 1 || r.Session.EndedAt == nil {
		t.Fatalf("early end %+v %v", r, err)
	}
	if len(env.eventsOf(EvPunishmentStarted)) != 0 {
		t.Fatal("ending early is free")
	}
	// Idempotent by state.
	r2, err := end(app.id, 0, 0)
	if err != nil || r2.Summary != r.Summary || len(env.eventsOf(EvStudyEnded)) != 1 {
		t.Fatalf("second end %+v %v", r2, err)
	}

	// Within completionGraceMs of the planned time: completed, with the bonus.
	app, _ = env.startStudy(30, nil)
	app.study(29*time.Minute + 30*time.Second)
	env.advance(10 * time.Second)
	r, err = end(app.id, 10000, 0)
	bonus := int64(pointRules().CleanSessionBonus)
	if err != nil || r.Summary.Outcome != "completed" || r.Summary.CleanBonus != bonus || r.Summary.ActiveMinutes != 30 ||
		r.Summary.FocusedMinutes != 30 || r.Summary.PointsTotal != 30*int64(pointRules().StudyPointsPerFocusMinute)+bonus {
		t.Fatalf("completed end %+v %v", r, err)
	}

	// Validation, unknown ids.
	if _, err := e.EndStudy(bg, Request{}, app.id, EndStudyRequest{Reason: "bored"}); apiCode(err) != "validation_failed" || apiDetails(err)["path"] != "reason" {
		t.Fatalf("bad reason: %v", err)
	}
	if _, err := end("stu_0000000000000000000000", 0, 0); apiCode(err) != "not_found" {
		t.Fatalf("unknown: %v", err)
	}
}

func TestStudyOutcomeAndHistory(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	outcome := func(id, v string) (StudySessionResponse, error) {
		return e.SetStudyOutcome(bg, Request{}, id, StudyOutcomeRequest{Achieved: v})
	}
	app, _ := env.startStudy(10, nil)
	if _, err := outcome(app.id, "yes"); apiCode(err) != "outcome_window_closed" {
		t.Fatalf("outcome while open: %v", err)
	}
	app.study(time.Minute)
	if _, err := e.EndStudy(bg, Request{}, app.id, EndStudyRequest{Reason: "user"}); err != nil {
		t.Fatal(err)
	}
	if _, err := outcome(app.id, "maybe"); apiCode(err) != "validation_failed" {
		t.Fatalf("bad value: %v", err)
	}
	r, err := outcome(app.id, "partial")
	if err != nil || r.Session.Achieved == nil || *r.Session.Achieved != "partial" {
		t.Fatalf("outcome %+v %v", r, err)
	}
	if _, err := outcome(app.id, "yes"); apiCode(err) != "outcome_already_set" {
		t.Fatalf("outcome twice: %v", err)
	}
	if ev := env.eventsOf(EvStudyOutcome); len(ev) != 1 || mustDecode[StudyOutcomeData](t, ev[0]).Achieved != "partial" {
		t.Fatalf("study_outcome %v", types(ev))
	}

	// recent.endedStudy lasts recentEndedStudyMs.
	other, _ := env.startStudy(10, nil)
	if _, err := e.EndStudy(bg, Request{}, other.id, EndStudyRequest{Reason: "user"}); err != nil {
		t.Fatal(err)
	}
	if rec := env.state().Recent.EndedStudy; rec == nil || rec.Session.ID != other.id {
		t.Fatalf("recent %+v", rec)
	}
	env.advance(time.Duration(limits().RecentEndedStudyMs)*time.Millisecond + 2*time.Second)
	if rec := env.state().Recent.EndedStudy; rec != nil {
		t.Fatalf("recent after the window %+v", rec)
	}
	// The outcome window closes after outcomeWindowMs.
	env.clk.Advance(time.Duration(studyRules().OutcomeWindowMs) * time.Millisecond)
	e.Step()
	if _, err := outcome(other.id, "no"); apiCode(err) != "outcome_window_closed" {
		t.Fatalf("outcome after the window: %v", err)
	}
	// Sessions stay readable for studyHistoryMs, with their summary.
	d, err := e.GetStudySession(bg, other.id)
	if err != nil || d.Summary == nil || d.Summary.Outcome != "ended_early" || d.Session.Status != "ended_early" {
		t.Fatalf("history %+v %v", d, err)
	}
	env.clk.Advance(time.Duration(limits().StudyHistoryMs) * time.Millisecond)
	e.Step()
	if _, err := e.GetStudySession(bg, other.id); apiCode(err) != "not_found" {
		t.Fatalf("after the history window: %v", err)
	}
	if _, err := outcome(other.id, "no"); apiCode(err) != "not_found" {
		t.Fatalf("outcome after the history window: %v", err)
	}
	if len(e.state.Study.Sessions) != 0 {
		t.Fatalf("not pruned: %d", len(e.state.Study.Sessions))
	}
}

// ---------------------------------------------------------------------------------------
// Local midnight, stateVersion, recovery, attempts
// ---------------------------------------------------------------------------------------

// At local midnight the whole minutes go to the day that ends (in the day_closed batch)
// and the remainder carries to the new day.
func TestStudyMidnightFlush(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	_ = e.exec(bg, func() { e.state.Settings.Timezone = ptr("Etc/GMT-13") }) // 10:00Z = 23:00
	env.advance(40*time.Minute + 7*time.Second)
	day := e.localDay(e.now)
	app, _ := env.startStudy(30, nil) // midnight comes 19:53 into it
	app.study(30 * time.Minute)       // the heartbeat at the planned end completes it
	closed := env.eventsOf(EvDayClosed)
	if len(closed) != 1 || mustDecode[DayClosedData](t, closed[0]).Day != day {
		t.Fatalf("day_closed %v", types(closed))
	}
	all := env.events()
	i := slices.IndexFunc(all, func(ev store.Event) bool { return ev.Type == EvDayClosed })
	if all[i-1].Type != EvFocusMinutes || all[i-1].Day != day || all[i-1].TxEnd || mustDecode[FocusMinutesData](t, all[i-1]).Minutes != 4 {
		t.Fatalf("midnight flush %+v", all[i-1])
	}
	if got := app.focusLogged(day); got != 19 {
		t.Fatalf("old day %d", got)
	}
	if got := app.focusLogged(""); got != 30 {
		t.Fatalf("total %d", got)
	}
	if d, _ := app.ended(); d.FocusedMinutes != 30 || d.Outcome != "completed" {
		t.Fatalf("summary %+v", d)
	}
}

// Per-tick counters change stateVersion only at whole minutes (§8.5).
func TestStudyStateVersionStable(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	app, _ := env.startStudy(60, nil)
	app.beat(0)
	v := env.state().StateVersion
	for i := 0; i < 20; i++ {
		env.advance(2 * time.Second)
		if s := env.state(); s.StateVersion != v {
			t.Fatalf("tick %d moved stateVersion (%d → %d)", i, v, s.StateVersion)
		}
	}
	env.advance(20 * time.Second)
	if s := env.state(); s.StateVersion == v || s.Study.ActiveMinutes != 1 {
		t.Fatalf("a whole minute must be visible: %d %d", s.StateVersion, s.Study.ActiveMinutes)
	}
}

// Everything the events carry is rebuilt from the log; the tick counters restart.
func TestStudyRebuildFromLog(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	app, _ := env.startStudy(60, nil)
	app.study(6 * time.Minute)
	app.strike("phone")
	if _, err := e.PauseStudy(bg, Request{}, app.id); err != nil {
		t.Fatal(err)
	}
	if _, err := e.ResumeStudy(bg, Request{}, app.id); err != nil {
		t.Fatal(err)
	}
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"state.json", "state.prev.json"} {
		if err := os.Remove(filepath.Join(env.dir, n)); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
	}
	env.clk.ServiceRestart(time.Second)
	e = env.open()
	s := env.state().Study
	if s == nil || s.ID != app.id || s.Status != "active" || s.Strikes != 1 || s.FocusedMinutes != 5 || s.PausesLeft != 1 || s.CooldownUntil == nil {
		t.Fatalf("rebuilt %+v", s)
	}
	app.seq = 0
	app.study(time.Minute)
	if cur := env.state().Study; cur == nil || cur.Status != "active" {
		t.Fatalf("after the rebuild %+v", cur)
	}
}

// Attempts counted while a session is open (attempts.go calls studyNoteAttempt from its
// reducer) cost the clean bonus and count in pointsTotal.
func TestStudyAttemptsCount(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	app, _ := env.startStudy(30, nil)
	app.study(time.Minute)
	_ = e.exec(bg, func() { e.studyNoteAttempt(-10) })
	app.study(29 * time.Minute) // the heartbeat at the planned end completes it
	d, _ := app.ended()
	if d.Outcome != "completed" || d.Attempts != 1 || d.CleanBonus != 0 || d.PointsTotal != 30*int64(pointRules().StudyPointsPerFocusMinute)-10 {
		t.Fatalf("summary %+v", d)
	}
	if s := env.state().Recent.EndedStudy.Session; s.Attempts != 1 {
		t.Fatalf("session attempts %d", s.Attempts)
	}
	// Without an open session nothing is counted.
	_ = e.exec(bg, func() { e.studyNoteAttempt(-10) })
	if app.rec().Attempts != 1 {
		t.Fatal("attempt counted without an open session")
	}
}

// A policy outside the contract (a state written by another version) is never
// snapshotted: the embedded defaults replace the invalid parts.
func TestStudyPolicyFallback(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	env.setPolicy("reboot_the_pc", 5000)
	app, s := env.startStudy(25, nil)
	r := studyRules()
	if s.Policy.Level != r.DefaultPunishmentLevel || s.Policy.Minutes != r.PunishmentMinutes.Default {
		t.Fatalf("policy %+v", s.Policy)
	}
	if _, err := env.e.EndStudy(bg, Request{}, app.id, EndStudyRequest{Reason: "user"}); err != nil {
		t.Fatal(err)
	}
	env.setPolicy("whitelist", r.PunishmentMinutes.Max+1)
	if _, s = env.startStudy(25, nil); s.Policy.Level != "whitelist" || s.Policy.Minutes != r.PunishmentMinutes.Default {
		t.Fatalf("policy %+v", s.Policy)
	}
}

// Strikes during the final-heartbeat grace never count, and pausing is refused.
func TestStudyGrace(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	app, _ := env.startStudy(10, nil)
	app.study(9*time.Minute + 45*time.Second)
	env.advance(19 * time.Second) // 4 s into the grace, no heartbeat
	s := env.state().Study
	if s == nil || s.Phase != "ended" || s.Status != "active" || s.PhaseEndsAt != nil {
		t.Fatalf("grace %+v", s)
	}
	if r := app.strike("phone"); r.Counted || *r.Reason != "not_in_work_phase" {
		t.Fatalf("strike in the grace %+v", r)
	}
	if _, err := e.PauseStudy(bg, Request{}, app.id); apiCode(err) != "study_not_active" {
		t.Fatalf("pause in the grace: %v", err)
	}
	if _, err := e.StartStudy(bg, Request{}, StartStudyRequest{PlannedMinutes: 10}); apiCode(err) != "study_already_active" {
		t.Fatalf("start in the grace: %v", err)
	}
	env.advance(time.Duration(studyRules().FinalHeartbeatGraceMs) * time.Millisecond)
	if d, _ := app.ended(); d.Outcome != "completed" || d.FocusedMinutes != 10 {
		t.Fatalf("summary %+v", d)
	}
}

// ---------------------------------------------------------------------------------------
// Nuclear supervisor (§10.5)
// ---------------------------------------------------------------------------------------

// nuclearPunish starts a Nuclear punishment of minutes directly (as three strikes would).
func nuclearPunish(t *testing.T, e *Engine, minutes int) Punishment {
	t.Helper()
	var pun Punishment
	if err := e.exec(bg, func() {
		e.timeStep()
		b := e.newBatch()
		_, pun = e.addPunishmentEvents(b, nil, "", "abandoned", PunishmentPolicy{Level: "nuclear", Minutes: minutes})
		if err := e.commit(b); err != nil {
			t.Error(err)
		}
		e.afterTurn()
	}); err != nil {
		t.Fatal(err)
	}
	return pun
}

func TestNuclearSupervisor(t *testing.T) {
	env := newTestEnv(t)
	rl := &FakeRelauncher{}
	e := env.openWith(func(o *Options) { o.Nuclear = rl })
	env.setPolicy("nuclear", 15)
	nh := func(shown bool) NuclearHeartbeatResponse {
		t.Helper()
		r, err := e.NuclearHeartbeat(bg, Request{Scope: "app"}, NuclearHeartbeatRequest{OverlayShown: shown, Displays: 2})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	// seconds lets n seconds pass: a tick every 2 s, an overlay heartbeat every 3 s
	// when hb is true.
	seconds := func(n int, hb, shown bool) {
		for i := 1; i <= n; i++ {
			env.clk.Advance(time.Second)
			if hb && i%3 == 0 {
				nh(shown)
			}
			if i%2 == 0 {
				e.Step()
			}
		}
	}
	if r := nh(true); r.NuclearActive || r.EndsAt != nil {
		t.Fatalf("inactive heartbeat %+v", r)
	}
	if _, err := e.NuclearHeartbeat(bg, Request{}, NuclearHeartbeatRequest{OverlayShown: true, Displays: 0}); apiCode(err) != "validation_failed" {
		t.Fatalf("displays 0: %v", err)
	}
	seconds(20, false, false)
	if rl.Relaunches() != 0 {
		t.Fatal("relaunched without Nuclear")
	}

	// Three strikes with the nuclear policy: the next tick relaunches the app (gone).
	app, _ := env.startStudy(60, nil)
	for i := 0; i < 3; i++ {
		app.study(time.Minute + 15*time.Second)
		app.strike("phone")
	}
	st := env.state()
	if !st.NuclearActive || len(st.Punishments) != 1 {
		t.Fatalf("nuclear %v", st.NuclearActive)
	}
	if r := nh(true); !r.NuclearActive || r.EndsAt == nil || *r.EndsAt != st.Punishments[0].EndsAt {
		t.Fatalf("active heartbeat %+v", r)
	}
	e.Step()
	if rl.Relaunches() != 1 {
		t.Fatalf("relaunches %d", rl.Relaunches())
	}
	// Alive (process and overlay heartbeats): nothing to do.
	seconds(30, true, true)
	if rl.Relaunches() != 1 {
		t.Fatalf("relaunched a live app: %d", rl.Relaunches())
	}
	// Killed: relaunched at the next tick.
	rl.SetRunning(false)
	seconds(2, true, true)
	if rl.Relaunches() != 2 {
		t.Fatalf("after a kill %d", rl.Relaunches())
	}
	// Running but no overlay heartbeat (or overlayShown false): after nuclearLivenessMs.
	liveness := limits().NuclearLivenessMs / 1000
	seconds(liveness-2, true, false)
	if rl.Relaunches() != 2 {
		t.Fatalf("relaunched before the liveness window: %d", rl.Relaunches())
	}
	seconds(4, true, false)
	if rl.Relaunches() != 3 {
		t.Fatalf("no relaunch without the overlay: %d", rl.Relaunches())
	}
	// After the punishment ends nothing is relaunched any more.
	seconds(15*60, true, true)
	if env.state().NuclearActive {
		t.Fatal("still nuclear")
	}
	n := rl.Relaunches()
	rl.SetRunning(false)
	seconds(30, false, false)
	if rl.Relaunches() != n {
		t.Fatalf("relaunched after the end: %d → %d", n, rl.Relaunches())
	}
	if r := nh(true); r.NuclearActive || r.EndsAt != nil {
		t.Fatalf("heartbeat after the end %+v", r)
	}
}

// failingRelauncher reports a failing process check and counts relaunches.
type failingRelauncher struct {
	mu    sync.Mutex
	calls int
}

func (f *failingRelauncher) AppRunning() (bool, error) { return false, errors.New("no process list") }
func (f *failingRelauncher) Relaunch(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return nil
}
func (f *failingRelauncher) n() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func TestNuclearSupervisorCheckFails(t *testing.T) {
	env := newTestEnv(t)
	rl := &failingRelauncher{}
	e := env.openWith(func(o *Options) { o.Nuclear = rl })
	nuclearPunish(t, e, 15)
	// Within the liveness window the app gets to show the overlay by itself.
	env.advance(time.Duration(limits().NuclearLivenessMs-2000) * time.Millisecond)
	if rl.n() != 0 {
		t.Fatalf("relaunched on a failed check alone: %d", rl.n())
	}
	env.advance(6 * time.Second)
	if rl.n() != 1 {
		t.Fatalf("no relaunch without heartbeats: %d", rl.n())
	}
	if d, err := e.Diagnostics(bg); err != nil || !slices.ContainsFunc(d.Errors, func(x DiagnosticsError) bool { return x.Code == "nuclear_check" }) {
		t.Fatalf("diagnostics %+v %v", d.Errors, err)
	}
}

// blockingRelauncher blocks in Relaunch until its context ends.
type blockingRelauncher struct {
	entered chan struct{}
	once    sync.Once
}

func (b *blockingRelauncher) AppRunning() (bool, error) { return false, nil }
func (b *blockingRelauncher) Relaunch(ctx context.Context) error {
	b.once.Do(func() { close(b.entered) })
	<-ctx.Done()
	return ctx.Err()
}

// With the loop running, the OS calls run off the engine goroutine: a slow relaunch
// never blocks commands, and Stop cancels it.
func TestNuclearSupervisorLoop(t *testing.T) {
	t.Run("relaunch", func(t *testing.T) {
		env := newTestEnv(t)
		rl := &FakeRelauncher{}
		o := env.options()
		o.Nuclear = rl
		o.NewTicker = func(time.Duration) Ticker { return newRealTicker(time.Millisecond) }
		e, err := New(o)
		if err != nil {
			t.Fatal(err)
		}
		env.e = e
		if err := e.Start(bg); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = e.Stop() })
		<-e.Ready()
		nuclearPunish(t, e, 15)
		waitFor(t, func() bool { return engineRelaunches(e) >= 1 })
		// The app runs but never heartbeats: relaunched once the liveness window passes.
		env.clk.Advance(time.Duration(limits().NuclearLivenessMs)*time.Millisecond + time.Second)
		waitFor(t, func() bool { return engineRelaunches(e) >= 2 && rl.Relaunches() >= 2 })
		for i := 0; i < 20; i++ {
			if _, err := e.NuclearHeartbeat(bg, Request{}, NuclearHeartbeatRequest{OverlayShown: true, Displays: 1}); err != nil {
				t.Fatal(err)
			}
		}
	})
	t.Run("stop cancels", func(t *testing.T) {
		env := newTestEnv(t)
		rl := &blockingRelauncher{entered: make(chan struct{})}
		o := env.options()
		o.Nuclear = rl
		o.NewTicker = func(time.Duration) Ticker { return newRealTicker(time.Millisecond) }
		e, err := New(o)
		if err != nil {
			t.Fatal(err)
		}
		env.e = e
		if err := e.Start(bg); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = e.Stop() })
		<-e.Ready()
		nuclearPunish(t, e, 15)
		select {
		case <-rl.entered:
		case <-time.After(5 * time.Second):
			t.Fatal("relaunch never started")
		}
		// The engine keeps answering while the relaunch hangs.
		if _, err := e.State(bg); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- e.Stop() }()
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("Stop hangs on a relaunch")
		}
	})
}

// engineRelaunches reads the supervisor's count of recorded relaunches on the engine
// goroutine.
func engineRelaunches(e *Engine) int {
	n := 0
	_ = e.exec(bg, func() { n = e.state.Study.nuc.relaunches })
	return n
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(2 * time.Millisecond)
	}
}
