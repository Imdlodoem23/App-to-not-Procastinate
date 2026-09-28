package engine

import (
	"slices"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/points"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

func TestOpenFreshInstall(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	evs := env.events()
	if len(evs) < 2 || evs[0].Type != EvEpochStarted || evs[len(evs)-1].Type != EvGuardianStarted {
		t.Fatalf("fresh install events: %v", types(evs))
	}
	d := mustDecode[EpochStartedData](t, evs[0])
	if d.Reason != "install" || d.Kept.Settings.Timezone == nil || *d.Kept.Settings.Timezone != "Europe/Madrid" {
		t.Fatalf("epoch_started: %+v", d)
	}
	s := env.state()
	if s.Guardian.Mode != ModeGuardianNormal || len(s.Blocks) != 0 || s.Points.Balance != 0 {
		t.Fatalf("state: %+v", s)
	}
	if s.StateVersion < testStart.UnixMilli() {
		t.Fatalf("stateVersion %d must start at trusted Unix ms or later", s.StateVersion)
	}
	if e.trust() != TrustVerified {
		t.Fatalf("trust = %s after the first calibration", e.trust())
	}
	h, err := e.Health(bg)
	if err != nil || !h.OK || h.Name != "centrate-guardian" || h.APIVersion != embedded.API().APIVersion || slices.Contains(h.Capabilities, "testhooks") {
		t.Fatalf("health %+v %v", h, err)
	}
}

func types(evs []store.Event) []string {
	out := make([]string, len(evs))
	for i, ev := range evs {
		out[i] = ev.Type
	}
	return out
}

// A 60-minute block credits exactly 60 minutes (+60 and the clean bonus) at every tick
// phase (§10.9, §15).
func TestBlockCreditsExactly60AtEveryTickPhase(t *testing.T) {
	rules := points.DefaultPointRules()
	want := int64(60*rules.BlockPointsPerMinute + rules.CleanSessionBonus)
	for phase := time.Duration(0); phase < tickInterval; phase += 125 * time.Millisecond {
		env := newTestEnv(t)
		e := env.open()
		env.advance(10 * time.Second)
		env.clk.Advance(phase)
		blk := env.create(durationReq(ModeStrict, 60, "youtube"))
		env.clk.Advance(tickInterval - phase)
		e.Step()
		env.advance(61 * time.Minute)
		rec := e.block(blk.ID)
		if rec.Status != StatusCompleted {
			t.Fatalf("phase %v: status %s", phase, rec.Status)
		}
		done := env.eventsOf(EvBlockCompleted)
		if len(done) != 1 {
			t.Fatalf("phase %v: %d completions", phase, len(done))
		}
		d := mustDecode[BlockCompletedData](t, done[0])
		if d.CreditedMinutes != 60 || done[0].Points != want || *rec.PointsDelta != want {
			t.Fatalf("phase %v: credited %d (%d ms), points %d, want 60 and %d", phase, d.CreditedMinutes, rec.CreditedMs, done[0].Points, want)
		}
		if e.state.Ledger.Balance != want {
			t.Fatalf("phase %v: balance %d", phase, e.state.Ledger.Balance)
		}
		if *rec.EndedAt != rec.EndsAt {
			t.Fatalf("endedAt must be the scheduled end")
		}
	}
}

func TestCreateBlockEnforcesAndResponds(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	v0 := e.state.Versions
	res, err := e.CreateBlock(bg, Request{Scope: "app"}, durationReq(ModeNormal, 30, "youtube"))
	if err != nil {
		t.Fatal(err)
	}
	b := res.Block
	if b.Kind != KindManual || b.Status != StatusActive || !b.EmergencyEligible || b.PointsDelta != nil || b.EndedAt != nil {
		t.Fatalf("block %+v", b)
	}
	if res.StateVersion <= v0.State || e.state.Versions.ExtRules <= v0.ExtRules {
		t.Fatalf("versions did not increase: %+v → %+v", v0, e.state.Versions)
	}
	start, _ := parseMs(b.StartsAt)
	end, _ := parseMs(b.EndsAt)
	if end-start != 30*msPerMinute || b.OriginalEndsAt != b.EndsAt {
		t.Fatalf("span %d", end-start)
	}
	yt := e.cat.Service("youtube")
	got := env.fh.Domains()
	for _, d := range yt.Domains {
		if e.cat.IsAlwaysAllowedHost(d) {
			continue
		}
		if !slices.Contains(got, d) {
			t.Fatalf("hosts section lacks %s", d)
		}
	}
	if env.dns.Flushes() == 0 {
		t.Fatal("no DNS flush after the hosts change")
	}
	created := env.eventsOf(EvBlockCreated)
	if len(created) != 1 {
		t.Fatalf("%d block_created", len(created))
	}
	cd := mustDecode[BlockCreatedData](t, created[0])
	if cd.Source != "user" || cd.Block.EndsAt != fmtMs(end-e.wallOffsetMs()) {
		t.Fatalf("event block %+v", cd)
	}
	s := env.state()
	if len(s.Blocks) != 1 || s.Blocks[0].ID != b.ID {
		t.Fatalf("state blocks %+v", s.Blocks)
	}
	// After the end the section goes away.
	env.advance(31 * time.Minute)
	if len(env.fh.Domains()) != 0 {
		t.Fatalf("section still lists %d domains", len(env.fh.Domains()))
	}
	s = env.state()
	if len(s.Blocks) != 0 || len(s.Recent.EndedBlocks) != 1 || s.Recent.EndedBlocks[0].Outcome != StatusCompleted {
		t.Fatalf("state after end %+v %+v", s.Blocks, s.Recent)
	}
}

func TestExtendBlock(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	b := env.create(durationReq(ModeNormal, 60, "youtube"))
	res, err := e.ExtendBlock(bg, Request{}, b.ID, ExtendBlockRequest{AddMinutes: 30})
	if err != nil {
		t.Fatal(err)
	}
	e0, _ := parseMs(b.EndsAt)
	e1, _ := parseMs(res.Block.EndsAt)
	if e1-e0 != 30*msPerMinute || res.Block.ExtendedMinutes != 30 || res.Block.OriginalEndsAt != b.OriginalEndsAt {
		t.Fatalf("extended %+v", res.Block)
	}
	// Never beyond 24 h from now.
	_, err = e.ExtendBlock(bg, Request{}, b.ID, ExtendBlockRequest{AddMinutes: 1440})
	if apiCode(err) != "extension_exceeds_max" || apiDetails(err)["maxAddMinutes"] != int64(1440-90) {
		t.Fatalf("got %v %v", err, apiDetails(err))
	}
	for _, add := range []int64{0, -5, 1441} {
		if _, err := e.ExtendBlock(bg, Request{}, b.ID, ExtendBlockRequest{AddMinutes: add}); apiCode(err) != "validation_failed" {
			t.Fatalf("add %d: %v", add, err)
		}
	}
	if _, err := e.ExtendBlock(bg, Request{}, "blk_unknownunknownunknow", ExtendBlockRequest{AddMinutes: 5}); apiCode(err) != "not_found" {
		t.Fatalf("unknown: %v", err)
	}
	// Judged after the time-driven step: a block whose end passed is not extended.
	env.clk.Advance(90 * time.Minute)
	if _, err := e.ExtendBlock(bg, Request{}, b.ID, ExtendBlockRequest{AddMinutes: 5}); apiCode(err) != "block_not_active" {
		t.Fatalf("ended: %v", err)
	}
}

func TestCreateBlockValidation(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	ptrStr := func(s string) *string { return &s }
	cases := []struct {
		name string
		mod  func(r *CreateBlockRequest)
		code string
	}{
		{"unknown mode", func(r *CreateBlockRequest) { r.Mode = "soft" }, "validation_failed"},
		{"both duration and endsAt", func(r *CreateBlockRequest) { r.EndsAt = ptrStr(fmtMs(testStart.Add(2 * time.Hour).UnixMilli())) }, "validation_failed"},
		{"neither", func(r *CreateBlockRequest) { r.DurationMinutes = nil }, "validation_failed"},
		{"too short", func(r *CreateBlockRequest) { r.DurationMinutes = ptr(int64(4)) }, "duration_out_of_range"},
		{"too long", func(r *CreateBlockRequest) { r.DurationMinutes = ptr(int64(1441)) }, "duration_out_of_range"},
		{"endsAt too soon", func(r *CreateBlockRequest) {
			r.DurationMinutes = nil
			r.EndsAt = ptrStr(fmtMs(env.clk.Wall().Add(3 * time.Minute).UnixMilli()))
		}, "duration_out_of_range"},
		{"endsAt not wire format", func(r *CreateBlockRequest) { r.DurationMinutes = nil; r.EndsAt = ptrStr("2026-09-28T12:00:00Z") }, "validation_failed"},
		{"unknown service", func(r *CreateBlockRequest) { r.Targets.ServiceIDs = []string{"nope-not-a-service"} }, "unknown_id"},
		{"unknown category", func(r *CreateBlockRequest) { r.Targets.CategoryIDs = []string{"sports"} }, "validation_failed"},
		{"protected domain", func(r *CreateBlockRequest) { r.Targets.CustomDomains = []string{"update.microsoft.com"} }, "protected_target"},
		{"protected process", func(r *CreateBlockRequest) { r.Targets.CustomProcesses = []string{"explorer.exe"} }, "protected_target"},
		{"invalid domain", func(r *CreateBlockRequest) { r.Targets.CustomDomains = []string{"Example.COM"} }, "validation_failed"},
		{"no targets", func(r *CreateBlockRequest) { r.Targets = emptyTargets() }, "validation_failed"},
		{"allow without whitelist", func(r *CreateBlockRequest) { r.Allow.CustomDomains = []string{"wikipedia.org"} }, "validation_failed"},
		{"exam without whitelist", func(r *CreateBlockRequest) { r.Mode = ModeExam; r.AcknowledgeNoEmergency = true }, "validation_failed"},
		{"whitelist with targets", func(r *CreateBlockRequest) { r.WhitelistOnly = true }, "validation_failed"},
		{"allow distraction", func(r *CreateBlockRequest) {
			r.Targets = emptyTargets()
			r.WhitelistOnly = true
			r.Allow.CustomDomains = []string{"m.youtube.com"}
		}, "allow_distraction"},
		{"hardcore without ack", func(r *CreateBlockRequest) { r.Mode = ModeHardcore; r.AcknowledgeNoEmergency = false }, "confirmation_required"},
		{"long without ack", func(r *CreateBlockRequest) { r.DurationMinutes = ptr(int64(300)); r.AcknowledgeLong = false }, "confirmation_required"},
		{"reason too long", func(r *CreateBlockRequest) {
			r.Reason = string(make([]byte, 141))
		}, "validation_failed"},
	}
	for _, c := range cases {
		req := durationReq(ModeNormal, 30, "youtube")
		c.mod(&req)
		_, err := e.CreateBlock(bg, Request{}, req)
		if apiCode(err) != c.code {
			t.Errorf("%s: got %v (%v), want %s", c.name, err, apiDetails(err), c.code)
		}
	}
	if n := len(e.activeBlocks()); n != 0 {
		t.Fatalf("%d blocks created by invalid requests", n)
	}
	// The confirmation lists what is missing.
	req := durationReq(ModeHardcore, 300, "youtube")
	req.AcknowledgeLong, req.AcknowledgeNoEmergency = false, false
	_, err := e.CreateBlock(bg, Request{}, req)
	if needs, _ := apiDetails(err)["needs"].([]string); !slices.Equal(needs, []string{"long", "no_emergency"}) {
		t.Fatalf("needs %v", apiDetails(err))
	}
	// endsAt is display time: with the wall clock two hours ahead it is converted back.
	env.clk.JumpWall(2 * time.Hour)
	e.Step()
	req = durationReq(ModeNormal, 0, "youtube")
	req.DurationMinutes = nil
	req.EndsAt = ptrStr(fmtMs(env.clk.Wall().Add(45 * time.Minute).UnixMilli()))
	b := env.create(req)
	rec := e.block(b.ID)
	if rec.EndsAt-rec.StartsAt != 45*msPerMinute || b.EndsAt != *req.EndsAt {
		t.Fatalf("endsAt conversion: span %d, display %s vs %s", rec.EndsAt-rec.StartsAt, b.EndsAt, *req.EndsAt)
	}
}

func TestBlockBudgets(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	l := limits()
	for i := 0; i < l.MaxActiveBlocks; i++ {
		env.create(durationReq(ModeNormal, 30, "youtube"))
	}
	_, err := e.CreateBlock(bg, Request{}, durationReq(ModeNormal, 30, "youtube"))
	d := apiDetails(err)
	if apiCode(err) != "too_many_targets" || d["kind"] != "blocks" || d["limit"] != l.MaxActiveBlocks {
		t.Fatalf("got %v %v", err, d)
	}
}

func TestListAndGetBlocks(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	a := env.create(durationReq(ModeNormal, 30, "youtube"))
	b := env.create(durationReq(ModeStrict, 90, "instagram"))
	c := env.create(durationReq(ModeNormal, 10, "tiktok"))
	list, err := e.ListBlocks(bg, ListBlocksQuery{})
	if err != nil || len(list.Blocks) != 3 || list.Blocks[0].ID != b.ID || list.Blocks[2].ID != c.ID {
		t.Fatalf("active list %v %+v", err, list)
	}
	env.advance(11 * time.Minute)
	g, err := e.GetBlock(bg, a.ID)
	if err != nil || g.Progress.CreditedMinutes != 1 {
		// a was not the earliest-ending block while c ran: c got those 10 minutes.
		t.Fatalf("get %+v %v", g, err)
	}
	gc, _ := e.GetBlock(bg, c.ID)
	if gc.Block.Status != StatusCompleted || gc.Progress.CreditedMinutes != 10 {
		t.Fatalf("c %+v", gc)
	}
	env.advance(20 * time.Minute)
	ended, err := e.ListBlocks(bg, ListBlocksQuery{Status: "ended", Limit: 1})
	if err != nil || len(ended.Blocks) != 1 || ended.Blocks[0].ID != a.ID || ended.NextCursor == nil {
		t.Fatalf("ended page 1 %+v %v", ended, err)
	}
	next, err := e.ListBlocks(bg, ListBlocksQuery{Status: "ended", Limit: 1, Cursor: *ended.NextCursor})
	if err != nil || len(next.Blocks) != 1 || next.Blocks[0].ID != c.ID || next.NextCursor != nil {
		t.Fatalf("ended page 2 %+v %v", next, err)
	}
	for _, q := range []ListBlocksQuery{{Status: "all"}, {Status: "ended", Cursor: "!!"}, {Status: "ended", Limit: 101}} {
		if _, err := e.ListBlocks(bg, q); apiCode(err) != "bad_query" {
			t.Fatalf("%+v: %v", q, err)
		}
	}
	if _, err := e.GetBlock(bg, "blk_0000000000000000"); apiCode(err) != "not_found" {
		t.Fatal(err)
	}
}

// Overlapping blocks never earn the same minute twice (§10.9).
func TestOverlappingBlocksShareCredit(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	a := env.create(durationReq(ModeNormal, 60, "youtube"))
	env.advance(20 * time.Minute)
	b := env.create(durationReq(ModeNormal, 30, "instagram"))
	env.advance(45 * time.Minute)
	ra, rb := e.block(a.ID), e.block(b.ID)
	ca := points.BlockCreditedMinutes(ra.CreditedMs, ra.StartsAt, ra.EndsAt)
	cb := points.BlockCreditedMinutes(rb.CreditedMs, rb.StartsAt, rb.EndsAt)
	if ca+cb != 60 || cb != 30 || ca != 30 {
		t.Fatalf("credited a=%d b=%d", ca, cb)
	}
}

// Suspended time is never credited, and the block still ends at its promised moment.
func TestSuspendDoesNotCredit(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	b := env.create(durationReq(ModeNormal, 60, "youtube"))
	env.advance(10 * time.Minute)
	env.clk.Suspend(20 * time.Minute)
	e.Step()
	env.advance(29 * time.Minute)
	rec := e.block(b.ID)
	if rec.Status != StatusActive {
		t.Fatal("ended early")
	}
	env.advance(2 * time.Minute)
	if rec.Status != StatusCompleted {
		t.Fatal("did not end at the promised moment")
	}
	d := mustDecode[BlockCompletedData](t, env.eventsOf(EvBlockCompleted)[0])
	if d.CreditedMinutes != 40 {
		t.Fatalf("credited %d, want 40", d.CreditedMinutes)
	}
}

// A block ending while the guardian is off completes at the next start with the credit
// it actually saw.
func TestCompletionAfterDowntime(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	b := env.create(durationReq(ModeNormal, 30, "youtube"))
	env.advance(10 * time.Minute)
	if err := env.e.Stop(); err != nil {
		t.Fatal(err)
	}
	env.clk.RebootAfter(time.Hour)
	e := env.open()
	rec := e.block(b.ID)
	if rec.Status == StatusActive {
		e.Step()
	}
	env.advance(3 * time.Minute) // boot hold ends at the latest after 120 s
	if rec = e.block(b.ID); rec.Status != StatusCompleted {
		t.Fatalf("status %s", rec.Status)
	}
	d := mustDecode[BlockCompletedData](t, env.eventsOf(EvBlockCompleted)[0])
	if d.CreditedMinutes != 10 {
		t.Fatalf("credited %d", d.CreditedMinutes)
	}
}
