package engine

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/points"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// Emergency unlock tests (docs/ARCHITECTURE.md §5.6, §10.6, §8.8 «Emergency»). Helpers
// are prefixed emg so they never collide with the other feature files' tests.

// emgPhrase is the Spanish commitment phrase (either language matches).
func emgPhrase() string { return points.DefaultEmergencyRules().Phrases.ES }

// emgCountdown is the countdown of a mode, from the embedded rules.
func emgCountdown(mode string) time.Duration {
	cd, _ := points.EmergencyCountdownMinutes([]string{mode}, points.DefaultEmergencyRules())
	return time.Duration(cd) * time.Minute
}

// emgWindow is the confirm window, from the embedded rules.
func emgWindow() time.Duration {
	return time.Duration(points.DefaultEmergencyRules().ConfirmWindowMinutes) * time.Minute
}

// emgRequest requests an unlock of ids with the phrase and fails the test on an error.
func emgRequest(t *testing.T, env *testEnv, ids ...string) EmergencyUnlock {
	t.Helper()
	res, err := env.e.RequestEmergency(bg, Request{Scope: "app"}, EmergencyRequest{BlockIDs: ids, Phrase: emgPhrase()})
	if err != nil {
		t.Fatalf("RequestEmergency: %v", err)
	}
	return res.Emergency
}

// emgForward moves real time with the machine awake, one tick every 10 s (the most one
// tick may credit), so long waits stay fast.
func emgForward(env *testEnv, d time.Duration) {
	for d > 0 {
		s := min(10*time.Second, d)
		env.clk.Advance(s)
		d -= s
		env.e.Step()
	}
}

// emgPunish starts a punishment the way Study Mode does (the §10.5 batch tail).
func emgPunish(t *testing.T, env *testEnv, level string, minutes int) (Block, Punishment) {
	t.Helper()
	e := env.e
	var blk Block
	var pun Punishment
	_ = e.exec(bg, func() {
		e.timeStep()
		b := e.newBatch()
		blk, pun = e.addPunishmentEvents(b, nil, "mates", "abandoned", PunishmentPolicy{Level: level, Minutes: minutes})
		if err := e.commit(b); err != nil {
			t.Error(err)
		}
		e.afterTurn()
	})
	return blk, pun
}

// emgLastBatch returns the committed batch holding the last event of type typ.
func emgLastBatch(t *testing.T, env *testEnv, typ string) []store.Event {
	t.Helper()
	evs := env.events()
	last := -1
	for j := len(evs) - 1; j >= 0; j-- {
		if evs[j].Type == typ {
			last = j
			break
		}
	}
	if last < 0 {
		t.Fatalf("no %s event", typ)
	}
	from := last
	for from > 0 && !evs[from-1].TxEnd {
		from--
	}
	to := last
	for to < len(evs)-1 && !evs[to].TxEnd {
		to++
	}
	return evs[from : to+1]
}

// emgTypes lists event types.
func emgTypes(evs []store.Event) []string {
	out := make([]string, len(evs))
	for i, ev := range evs {
		out[i] = ev.Type
	}
	return out
}

func TestEmergencyPreview(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	rules := points.DefaultEmergencyRules()
	p, err := e.EmergencyPreview(bg, nil)
	if err != nil {
		t.Fatal(err)
	}
	minPen := int64(points.DefaultPointRules().EmergencyMinPenalty)
	if p.Eligible || p.Reason == nil || *p.Reason != "no_active_blocks" || p.CountdownMinutes != nil || p.PenaltyPoints != minPen ||
		len(p.BlockIDs) != 0 || len(p.ExcludedBlockIDs) != 0 || p.Phrases.ES != rules.Phrases.ES || p.Phrases.EN != rules.Phrases.EN {
		t.Fatalf("empty preview %+v", p)
	}
	n := env.create(durationReq(ModeNormal, 60, "youtube"))
	h := env.create(durationReq(ModeHardcore, 60, "reddit"))
	p, _ = e.EmergencyPreview(bg, nil)
	if !p.Eligible || p.Reason != nil || !slices.Equal(p.BlockIDs, []string{n.ID}) || !slices.Equal(p.ExcludedBlockIDs, []string{h.ID}) ||
		p.CountdownMinutes == nil || *p.CountdownMinutes != int64(rules.CountdownMinutes.Normal) {
		t.Fatalf("normal + hardcore %+v", p)
	}
	s := env.create(durationReq(ModeStrict, 60, "instagram"))
	p, _ = e.EmergencyPreview(bg, nil)
	if !slices.Equal(p.BlockIDs, []string{n.ID, s.ID}) || *p.CountdownMinutes != int64(rules.CountdownMinutes.Strict) {
		t.Fatalf("with strict %+v", p)
	}
	p, _ = e.EmergencyPreview(bg, []string{n.ID})
	if !slices.Equal(p.BlockIDs, []string{n.ID}) || *p.CountdownMinutes != int64(rules.CountdownMinutes.Normal) {
		t.Fatalf("listed normal %+v", p)
	}
	p, _ = e.EmergencyPreview(bg, []string{h.ID})
	if p.Eligible || *p.Reason != "hardcore" || p.CountdownMinutes != nil || len(p.BlockIDs) != 0 {
		t.Fatalf("listed hardcore %+v", p)
	}
	exam := durationReq(ModeExam, 60)
	exam.WhitelistOnly = true
	x := env.create(exam)
	p, _ = e.EmergencyPreview(bg, []string{h.ID, x.ID})
	if p.Eligible || *p.Reason != "exam" || !slices.Contains(p.ExcludedBlockIDs, x.ID) {
		t.Fatalf("listed exam %+v", p)
	}
	p, _ = e.EmergencyPreview(bg, []string{"blk_0123456789abcdefXYZ0"})
	if p.Eligible || *p.Reason != "no_active_blocks" {
		t.Fatalf("unknown id %+v", p)
	}
	if _, err := e.EmergencyPreview(bg, []string{"nope"}); apiCode(err) != "bad_query" {
		t.Fatalf("malformed id: %v", err)
	}
	em := emgRequest(t, env, n.ID)
	p, _ = e.EmergencyPreview(bg, nil)
	if p.Eligible || *p.Reason != "emergency_in_progress" {
		t.Fatalf("pending %+v", p)
	}
	if em.PenaltyPreview != minPen || p.PenaltyPoints != minPen || p.Balance != 0 || p.AllowanceValue != 0 {
		t.Fatalf("penalty %d / %+v", em.PenaltyPreview, p)
	}
}

func TestEmergencyRequestValidation(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	n := env.create(durationReq(ModeNormal, 60, "youtube"))
	h := env.create(durationReq(ModeHardcore, 60, "reddit"))
	unknown := "blk_0123456789abcdefXYZ0"
	req := func(ids []string, phrase string) error {
		_, err := e.RequestEmergency(bg, Request{Scope: "app"}, EmergencyRequest{BlockIDs: ids, Phrase: phrase})
		return err
	}
	cases := []struct {
		name   string
		ids    []string
		phrase string
		code   string
		path   string
	}{
		{"no blocks", []string{}, emgPhrase(), "validation_failed", "blockIds"},
		{"malformed id", []string{"blk_short"}, emgPhrase(), "validation_failed", "blockIds[0]"},
		{"duplicate", []string{n.ID, n.ID}, emgPhrase(), "validation_failed", "blockIds[1]"},
		{"empty phrase", []string{n.ID}, "", "validation_failed", "phrase"},
		{"wrong phrase", []string{n.ID}, "quiero ver youtube", "phrase_mismatch", ""},
		{"hardcore", []string{n.ID, h.ID}, emgPhrase(), "emergency_not_available", ""},
		{"unknown", []string{unknown}, emgPhrase(), "emergency_not_available", ""},
	}
	for _, c := range cases {
		err := req(c.ids, c.phrase)
		if apiCode(err) != c.code {
			t.Fatalf("%s: %v, want %s", c.name, err, c.code)
		}
		if c.path != "" && apiDetails(err)["path"] != c.path {
			t.Fatalf("%s: details %v", c.name, apiDetails(err))
		}
	}
	err := req([]string{n.ID, h.ID}, emgPhrase())
	if d := apiDetails(err); d["reason"] != "hardcore" || !slices.Equal(d["blockIds"].([]string), []string{h.ID}) {
		t.Fatalf("not available details %v", d)
	}
	if d := apiDetails(req([]string{unknown}, emgPhrase())); d["reason"] != "not_active" {
		t.Fatalf("unknown details %v", d)
	}
	if len(env.eventsOf(EvEmergencyRequested)) != 0 {
		t.Fatal("a refused request was logged")
	}
	// The phrase is normalized (ASCII case, runs of spaces and NBSP, one trailing dot)
	// and either language matches.
	sloppy := "  ACEPTO romper mi   compromiso y perder mis puntos. "
	if !points.EmergencyPhraseMatches(sloppy, points.DefaultEmergencyRules()) {
		t.Fatal("normalization differs from the shared rules")
	}
	res, err := e.RequestEmergency(bg, Request{Scope: "app"}, EmergencyRequest{BlockIDs: []string{n.ID}, Phrase: sloppy})
	if err != nil {
		t.Fatalf("sloppy phrase: %v", err)
	}
	em := res.Emergency
	if em.Status != "counting" || em.CancelReason != nil || em.ConfirmBy != nil || em.ResolvedAt != nil || !slices.Equal(em.BlockIDs, []string{n.ID}) {
		t.Fatalf("emergency %+v", em)
	}
	if err := req([]string{n.ID}, points.DefaultEmergencyRules().Phrases.EN); apiCode(err) != "emergency_in_progress" {
		t.Fatalf("second request: %v", err)
	}
	s := env.state()
	if s.Emergency == nil || s.Emergency.ID != em.ID || s.RewardsLock == nil || *s.RewardsLock != "emergency" {
		t.Fatalf("state emergency %+v lock %v", s.Emergency, s.RewardsLock)
	}
	for _, b := range s.Blocks {
		if b.EmergencyEligible {
			t.Fatalf("block %s (%s) still eligible", b.ID, b.Mode)
		}
	}
}

// The countdown runs on the boot clock: a wall-clock change never moves it, suspend
// counts, and readyAt is reported in display time (§10.6).
func TestEmergencyCountdownOnBootClock(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	blk := env.create(durationReq(ModeNormal, 60, "youtube"))
	t0 := e.now
	em := emgRequest(t, env, blk.ID)
	cd := emgCountdown(ModeNormal)
	if em.CountdownMinutes != int64(cd/time.Minute) || em.ReadyAt != fmtMs(t0+cd.Milliseconds()) || em.RequestedAt != fmtMs(t0) {
		t.Fatalf("emergency %+v", em)
	}
	req := env.eventsOf(EvEmergencyRequested)
	if len(req) != 1 || req[0].Points != 0 {
		t.Fatalf("emergency_requested %v", emgTypes(req))
	}
	if d := mustDecode[EmergencyRequestedData](t, req[0]); d.Emergency.ReadyAt != fmtMs(t0+cd.Milliseconds()) || d.Emergency.Status != "counting" {
		t.Fatalf("event snapshot %+v", d.Emergency)
	}
	// A block created during the countdown is not included.
	later := env.create(durationReq(ModeNormal, 60, "reddit"))
	if !env.e.displayBlock(e.block(later.ID)).EmergencyEligible {
		t.Fatal("a block created during the countdown must stay eligible")
	}
	env.advance(4 * time.Minute)
	_, err := e.ConfirmEmergency(bg, Request{Scope: "app"}, em.ID, ConfirmEmergencyRequest{Acknowledge: true})
	if apiCode(err) != "emergency_not_ready" || apiDetails(err)["readyAt"] != em.ReadyAt {
		t.Fatalf("early confirm: %v %v", err, apiDetails(err))
	}
	// Moving the wall clock two hours ahead changes nothing but the display time.
	env.clk.JumpWall(2 * time.Hour)
	e.Step()
	s := env.state()
	if s.Emergency == nil || s.Emergency.Status != "counting" {
		t.Fatalf("after a wall jump %+v", s.Emergency)
	}
	if want := fmtMs(t0 + cd.Milliseconds() + e.wallOffsetMs()); s.Emergency.ReadyAt != want || e.wallOffsetMs() != (2*time.Hour).Milliseconds() {
		t.Fatalf("display readyAt %s, want %s", s.Emergency.ReadyAt, want)
	}
	// Suspend counts on the boot clock: the countdown ends while the machine sleeps.
	env.clk.Suspend(cd - 4*time.Minute - 2*time.Second)
	e.Step()
	if env.state().Emergency.Status != "counting" {
		t.Fatal("ready before the countdown ended")
	}
	env.clk.Advance(2 * time.Second)
	e.Step()
	s = env.state()
	win := emgWindow()
	if s.Emergency.Status != "ready" || s.Emergency.ConfirmBy == nil ||
		*s.Emergency.ConfirmBy != fmtMs(t0+(cd+win).Milliseconds()+e.wallOffsetMs()) {
		t.Fatalf("ready %+v", s.Emergency)
	}
	if _, err := e.ConfirmEmergency(bg, Request{Scope: "app"}, em.ID, ConfirmEmergencyRequest{}); apiCode(err) != "validation_failed" {
		t.Fatalf("confirm without acknowledge: %v", err)
	}
	res, err := e.ConfirmEmergency(bg, Request{Scope: "app"}, em.ID, ConfirmEmergencyRequest{Acknowledge: true})
	if err != nil {
		t.Fatal(err)
	}
	pen := int64(points.DefaultPointRules().EmergencyMinPenalty)
	if res.PenaltyApplied != pen || res.BalanceAfter != -pen || !slices.Equal(res.CancelledBlockIDs, []string{blk.ID}) ||
		res.StreakDaysLost != 0 || res.Emergency.Status != "confirmed" || res.Emergency.ResolvedAt == nil || res.Emergency.CancelReason != nil ||
		res.Emergency.PenaltyPreview != pen {
		t.Fatalf("confirm %+v", res)
	}
	batch := emgLastBatch(t, env, EvEmergencyConfirmed)
	if !slices.Equal(emgTypes(batch), []string{EvEmergencyConfirmed, EvBlockCancelled}) || batch[0].Points != -pen {
		t.Fatalf("confirm batch %v", emgTypes(batch))
	}
	d := mustDecode[EmergencyConfirmedData](t, batch[0])
	if d.BalanceBefore != 0 || d.AllowanceValue != 0 || d.Penalty != pen || !slices.Equal(d.BlockIDs, []string{blk.ID}) ||
		d.GoalMinutes != int64(e.state.Settings.DailyGoalMinutes) {
		t.Fatalf("emergency_confirmed %+v", d)
	}
	if c := mustDecode[BlockCancelledData](t, batch[1]); c.BlockID != blk.ID || c.EmergencyID != em.ID || c.ForfeitedMinutes <= 0 {
		t.Fatalf("block_cancelled %+v", c)
	}
	s = env.state()
	if s.Emergency != nil || s.RewardsLock != nil || s.Points.Balance != -pen {
		t.Fatalf("after confirm %+v", s)
	}
	if rec := e.block(blk.ID); rec.Status != StatusCancelledEmergency || *rec.PointsDelta != 0 {
		t.Fatalf("block %+v", rec)
	}
	if rec := e.block(later.ID); rec.Status != StatusActive {
		t.Fatal("the later block was cancelled too")
	}
	if slices.Contains(env.fh.Domains(), "youtube.com") || !slices.Contains(env.fh.Domains(), "reddit.com") {
		t.Fatalf("hosts after confirm: youtube must reopen, reddit stay: %v", env.fh.Domains())
	}
	if e.state.Ledger.VoidedDay == nil || *e.state.Ledger.VoidedDay != e.localDay(e.now) {
		t.Fatal("the day is not voided")
	}
	// A second confirm (another key) is not pending any more.
	if _, err := e.ConfirmEmergency(bg, Request{Scope: "app"}, em.ID, ConfirmEmergencyRequest{Acknowledge: true}); apiCode(err) != "emergency_expired" {
		t.Fatalf("second confirm: %v", err)
	}
}

// Punishment blocks are strict (30 min) and an emergency may cover several blocks; the
// confirm batch ends each punishment (§10.6).
func TestEmergencyCoversPunishmentsAndSeveralBlocks(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	n := env.create(durationReq(ModeNormal, 120, "youtube"))
	pb, pun := emgPunish(t, env, "distractions", 90)
	balance := e.state.Ledger.Balance
	em := emgRequest(t, env, n.ID, pb.ID)
	if em.CountdownMinutes != int64(emgCountdown(ModeStrict)/time.Minute) || em.PenaltyPreview != points.EmergencyPenalty(balance, points.DefaultPointRules()) {
		t.Fatalf("emergency %+v", em)
	}
	emgForward(env, emgCountdown(ModeNormal))
	if env.state().Emergency.Status != "counting" {
		t.Fatal("the strict countdown must be longer")
	}
	emgForward(env, emgCountdown(ModeStrict)-emgCountdown(ModeNormal))
	res, err := e.ConfirmEmergency(bg, Request{Scope: "app"}, em.ID, ConfirmEmergencyRequest{Acknowledge: true})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(res.CancelledBlockIDs, []string{n.ID, pb.ID}) {
		t.Fatalf("cancelled %v", res.CancelledBlockIDs)
	}
	batch := emgLastBatch(t, env, EvEmergencyConfirmed)
	want := []string{EvEmergencyConfirmed, EvBlockCancelled, EvBlockCancelled, EvPunishmentEnded}
	if !slices.Equal(emgTypes(batch), want) {
		t.Fatalf("batch %v", emgTypes(batch))
	}
	if d := mustDecode[PunishmentEndedData](t, batch[3]); d.Outcome != "emergency" || d.PunishmentID != pun.ID {
		t.Fatalf("punishment_ended %+v", d)
	}
	if p := e.punishment(pun.ID); p.Status != StatusCancelledEmergency || p.EndedAt == nil {
		t.Fatalf("punishment %+v", p)
	}
	if res.BalanceAfter != balance-res.PenaltyApplied {
		t.Fatalf("balance %d after %d − %d", res.BalanceAfter, balance, res.PenaltyApplied)
	}
	if s := env.state(); len(s.Blocks) != 0 || len(s.Punishments) != 0 || s.RewardsLock != nil {
		t.Fatalf("state %+v", s)
	}
}

// The confirm window runs on the boot clock too; expiry is logged as
// emergency_cancelled{expired} and costs nothing.
func TestEmergencyConfirmWindowExpires(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	blk := env.create(durationReq(ModeNormal, 60, "youtube"))
	em := emgRequest(t, env, blk.ID)
	emgForward(env, emgCountdown(ModeNormal)+emgWindow()-10*time.Second)
	if s := env.state(); s.Emergency == nil || s.Emergency.Status != "ready" {
		t.Fatalf("still in the window %+v", s.Emergency)
	}
	env.advance(10 * time.Second)
	if s := env.state(); s.Emergency != nil || s.RewardsLock != nil {
		t.Fatalf("expired emergency still pending %+v", s.Emergency)
	}
	c := env.eventsOf(EvEmergencyCancelled)
	if len(c) != 1 || mustDecode[EmergencyCancelledData](t, c[0]).Reason != "expired" || c[0].Points != 0 {
		t.Fatalf("expiry events %v", emgTypes(c))
	}
	if l := e.state.Emergency.Last; l.Status != "expired" || *l.CancelReason != "expired" || l.ConfirmBy == nil {
		t.Fatalf("last %+v", l)
	}
	_, err := e.ConfirmEmergency(bg, Request{Scope: "app"}, em.ID, ConfirmEmergencyRequest{Acknowledge: true})
	if apiCode(err) != "emergency_expired" || apiDetails(err)["status"] != "expired" {
		t.Fatalf("confirm after expiry: %v %v", err, apiDetails(err))
	}
	if _, err := e.CancelEmergency(bg, Request{Scope: "app"}, em.ID); apiCode(err) != "emergency_expired" {
		t.Fatalf("cancel after expiry: %v", err)
	}
	if e.state.Ledger.Balance != 0 || e.block(blk.ID).Status != StatusActive {
		t.Fatal("an expired emergency must cost nothing and cancel nothing")
	}
	// A new request is possible.
	if em2 := emgRequest(t, env, blk.ID); em2.ID == em.ID {
		t.Fatal("same id")
	}
}

func TestEmergencyCancelIsFree(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	blk := env.create(durationReq(ModeNormal, 60, "youtube"))
	em := emgRequest(t, env, blk.ID)
	env.advance(time.Minute)
	if _, err := e.CancelEmergency(bg, Request{Scope: "app"}, "emg_nope"); apiCode(err) != "not_found" {
		t.Fatalf("malformed id: %v", err)
	}
	if _, err := e.CancelEmergency(bg, Request{Scope: "app"}, "emg_0123456789abcdefXYZ0"); apiCode(err) != "emergency_expired" {
		t.Fatalf("other id: %v", err)
	}
	res, err := e.CancelEmergency(bg, Request{Scope: "app"}, em.ID)
	if err != nil {
		t.Fatal(err)
	}
	c := res.Emergency
	if c.Status != "cancelled" || c.CancelReason == nil || *c.CancelReason != "user" || c.ResolvedAt == nil || c.ConfirmBy != nil || c.ID != em.ID {
		t.Fatalf("cancelled %+v", c)
	}
	s := env.state()
	if s.Emergency != nil || s.Points.Balance != 0 || !s.Blocks[0].EmergencyEligible || s.RewardsLock != nil {
		t.Fatalf("after cancel %+v", s)
	}
	if _, err := e.CancelEmergency(bg, Request{Scope: "app"}, em.ID); apiCode(err) != "emergency_expired" {
		t.Fatalf("second cancel: %v", err)
	}
	// Cancelling while ready is free too.
	em = emgRequest(t, env, blk.ID)
	emgForward(env, emgCountdown(ModeNormal))
	res, err = e.CancelEmergency(bg, Request{Scope: "app"}, em.ID)
	if err != nil || res.Emergency.ConfirmBy == nil || e.state.Ledger.Balance != 0 {
		t.Fatalf("cancel while ready: %+v %v", res, err)
	}
}

// An unlock whose blocks all ended is cancelled for free (blocks_ended) and a late
// confirm answers emergency_moot; one whose blocks partly ended cancels the rest.
func TestEmergencyMootWhenBlocksEnd(t *testing.T) {
	t.Run("all ended", func(t *testing.T) {
		env := newTestEnv(t)
		e := env.open()
		short := env.create(durationReq(ModeNormal, 8, "youtube"))
		em := emgRequest(t, env, short.ID)
		env.advance(9 * time.Minute)
		if e.block(short.ID).Status != StatusCompleted {
			t.Fatal("block not completed")
		}
		c := env.eventsOf(EvEmergencyCancelled)
		if len(c) != 1 || mustDecode[EmergencyCancelledData](t, c[0]).Reason != "blocks_ended" || env.state().Emergency != nil {
			t.Fatalf("moot events %v", emgTypes(env.events()))
		}
		balance := e.state.Ledger.Balance
		env.advance(2 * time.Minute)
		_, err := e.ConfirmEmergency(bg, Request{Scope: "app"}, em.ID, ConfirmEmergencyRequest{Acknowledge: true})
		if apiCode(err) != "emergency_moot" || e.state.Ledger.Balance != balance || balance <= 0 {
			t.Fatalf("late confirm: %v, balance %d", err, balance)
		}
	})
	t.Run("partly ended", func(t *testing.T) {
		env := newTestEnv(t)
		e := env.open()
		short := env.create(durationReq(ModeNormal, 6, "youtube"))
		long := env.create(durationReq(ModeNormal, 60, "reddit"))
		em := emgRequest(t, env, short.ID, long.ID)
		emgForward(env, emgCountdown(ModeNormal))
		res, err := e.ConfirmEmergency(bg, Request{Scope: "app"}, em.ID, ConfirmEmergencyRequest{Acknowledge: true})
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(res.CancelledBlockIDs, []string{long.ID}) || !slices.Equal(res.Emergency.BlockIDs, []string{short.ID, long.ID}) {
			t.Fatalf("confirm %+v", res)
		}
		d := mustDecode[EmergencyConfirmedData](t, env.eventsOf(EvEmergencyConfirmed)[0])
		if !slices.Equal(d.BlockIDs, []string{long.ID}) || e.block(short.ID).Status != StatusCompleted {
			t.Fatalf("emergency_confirmed %+v", d)
		}
	})
}

// A reboot cancels a pending unlock (its countdown ran on the old boot clock); a
// service restart in the same boot keeps the countdown, and replaying the request from
// the log never shortens it (§10.2, §10.6).
func TestEmergencyRebootAndRestart(t *testing.T) {
	t.Run("reboot cancels", func(t *testing.T) {
		env := newTestEnv(t)
		env.open()
		blk := env.create(durationReq(ModeNormal, 60, "youtube"))
		em := emgRequest(t, env, blk.ID)
		env.advance(time.Minute)
		if err := env.e.Stop(); err != nil {
			t.Fatal(err)
		}
		env.clk.Reboot()
		e := env.open()
		c := env.eventsOf(EvEmergencyCancelled)
		if len(c) != 1 || mustDecode[EmergencyCancelledData](t, c[0]).Reason != "reboot" || env.state().Emergency != nil {
			t.Fatalf("after reboot %v", emgTypes(env.events()))
		}
		if l := e.state.Emergency.Last; l == nil || l.ID != em.ID || l.Status != "cancelled" || l.ConfirmBy != nil {
			t.Fatalf("last %+v", l)
		}
		if e.block(blk.ID).Status != StatusActive || e.state.Ledger.Balance != 0 {
			t.Fatal("a reboot must not cancel the block or charge anything")
		}
	})
	t.Run("same boot restart keeps the countdown", func(t *testing.T) {
		env := newTestEnv(t)
		env.open()
		blk := env.create(durationReq(ModeNormal, 60, "youtube"))
		em := emgRequest(t, env, blk.ID)
		env.advance(4 * time.Minute)
		if err := env.e.Stop(); err != nil {
			t.Fatal(err)
		}
		env.clk.ServiceRestart(30 * time.Second)
		e := env.open()
		s := env.state()
		if s.Emergency == nil || s.Emergency.ID != em.ID || s.Emergency.Status != "counting" || s.Emergency.ReadyAt != em.ReadyAt {
			t.Fatalf("after restart %+v", s.Emergency)
		}
		// Ready exactly at the original boot deadline (the downtime counted).
		env.clk.Advance(emgCountdown(ModeNormal) - 4*time.Minute - 30*time.Second - time.Second)
		e.Step()
		if env.state().Emergency.Status != "counting" {
			t.Fatal("ready early")
		}
		env.clk.Advance(time.Second)
		e.Step()
		if env.state().Emergency.Status != "ready" {
			t.Fatal("not ready at the deadline")
		}
	})
	t.Run("replay from the log never shortens it", func(t *testing.T) {
		env := newTestEnv(t)
		env.open()
		blk := env.create(durationReq(ModeNormal, 60, "youtube"))
		em := emgRequest(t, env, blk.ID)
		env.advance(4 * time.Minute)
		if err := env.e.Stop(); err != nil {
			t.Fatal(err)
		}
		for _, n := range []string{"state.json", "state.prev.json"} {
			_ = os.Remove(filepath.Join(env.dir, n))
		}
		env.clk.ServiceRestart(time.Second)
		e := env.open()
		p := e.state.Emergency.Pending
		if p == nil || p.ID != em.ID {
			t.Fatal("pending emergency not rebuilt from the log")
		}
		readyAt, _ := parseMs(em.ReadyAt)
		if got := e.bootAnchored(p.ReadyAt, p.ReadyAtBoot); got < readyAt {
			t.Fatalf("rebuilt readyAt %s before %s", fmtMs(got), em.ReadyAt)
		}
	})
}

// Redemptions are refused while an emergency counts (§10.6).
func TestEmergencyLocksTheShop(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	blk := env.create(durationReq(ModeNormal, 60, "youtube"))
	emgRequest(t, env, blk.ID)
	_, err := e.RedeemReward(bg, Request{Scope: "app"}, RedeemRewardRequest{OfferID: "youtube-15"})
	if apiCode(err) != "rewards_locked" || apiDetails(err)["reason"] != "emergency" {
		t.Fatalf("redeem during an emergency: %v %v", err, apiDetails(err))
	}
	r, _ := e.ListRewards(bg)
	if !r.Locked || r.LockReason == nil || *r.LockReason != "emergency" {
		t.Fatalf("rewards %+v", r)
	}
}

// Confirming wipes the displayed streak (streakDaysLost) and voids the day, so meeting
// the goal later that day does not count (§6.3).
func TestEmergencyStreakLoss(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	blk := env.create(durationReq(ModeNormal, 60, "youtube"))
	// A 5-day streak closed yesterday (test shortcut: the ledger state is set directly).
	_ = e.exec(bg, func() {
		yesterday, _ := points.AddDays(e.localDay(e.now), -1)
		e.state.Ledger.Streak, e.state.Ledger.BestStreak = 5, 5
		e.state.Ledger.LastClosedDay = &yesterday
	})
	p, _ := e.EmergencyPreview(bg, nil)
	if p.StreakDays != 5 {
		t.Fatalf("preview streak %d", p.StreakDays)
	}
	em := emgRequest(t, env, blk.ID)
	if em.StreakDaysAtRisk != 5 {
		t.Fatalf("streakDaysAtRisk %d", em.StreakDaysAtRisk)
	}
	emgForward(env, emgCountdown(ModeNormal))
	res, err := e.ConfirmEmergency(bg, Request{Scope: "app"}, em.ID, ConfirmEmergencyRequest{Acknowledge: true})
	if err != nil {
		t.Fatal(err)
	}
	if res.StreakDaysLost != 5 || res.Emergency.StreakDaysAtRisk != 5 || env.state().Points.StreakDays != 0 || e.state.Ledger.Streak != 0 {
		t.Fatalf("confirm %+v, streak %d", res, env.state().Points.StreakDays)
	}
	if d := mustDecode[EmergencyConfirmedData](t, env.eventsOf(EvEmergencyConfirmed)[0]); d.StreakDaysLost != 5 {
		t.Fatalf("event %+v", d)
	}
}
