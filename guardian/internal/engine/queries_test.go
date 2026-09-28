package engine

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// stateVersion is stable while nothing visible changes (the 2 s poll gets 304s) and
// increases on every visible change (§8.5).
func TestStateVersionETag(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	s1 := env.state()
	s2 := env.state()
	if s2.StateVersion != s1.StateVersion {
		t.Fatalf("version moved without a change: %d → %d", s1.StateVersion, s2.StateVersion)
	}
	env.advance(4 * time.Second)
	if s3 := env.state(); s3.StateVersion != s1.StateVersion {
		t.Fatalf("idle ticks moved the version: %d → %d", s1.StateVersion, s3.StateVersion)
	}
	res, err := e.CreateBlock(bg, Request{}, durationReq(ModeNormal, 30, "youtube"))
	if err != nil {
		t.Fatal(err)
	}
	s4 := env.state()
	if res.StateVersion <= s1.StateVersion || s4.StateVersion != res.StateVersion {
		t.Fatalf("after create: response %d, state %d, before %d", res.StateVersion, s4.StateVersion, s1.StateVersion)
	}
	// A wall-clock jump moves every display time: a new version.
	env.clk.JumpWall(time.Hour)
	e.Step()
	if s5 := env.state(); s5.StateVersion <= s4.StateVersion {
		t.Fatal("a jump did not change the version")
	}
}

// Events: cursor paging, reset on another epoch, and the long poll returns as soon as
// an event is committed (§8.8).
func TestEventsPagingAndLongPoll(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	all, err := e.Events(bg, EventsQuery{})
	if err != nil || !all.Reset || len(all.Events) == 0 || all.HasMore {
		t.Fatalf("first page %+v %v", all, err)
	}
	var first map[string]any
	if err := json.Unmarshal(all.Events[0], &first); err != nil || first["type"] != EvEpochStarted || first["mac"] != nil || first["prevMac"] != nil {
		t.Fatalf("wire event %v %v", first, err)
	}
	after := all.LastSeq
	one := 1
	page, err := e.Events(bg, EventsQuery{Epoch: all.Epoch, Limit: &one})
	if err != nil || page.Reset || len(page.Events) != 1 || !page.HasMore {
		t.Fatalf("limited page %+v %v", page, err)
	}
	empty, err := e.Events(bg, EventsQuery{Epoch: all.Epoch, After: &after})
	if err != nil || len(empty.Events) != 0 || empty.LastSeq != after || empty.HasMore {
		t.Fatalf("empty page %+v %v", empty, err)
	}
	// Long poll: a create committed while waiting wakes it.
	wait := 5000
	got := make(chan EventsResponse, 1)
	go func() {
		r, err := e.Events(bg, EventsQuery{Epoch: all.Epoch, After: &after, WaitMs: &wait})
		if err != nil {
			t.Error(err)
		}
		got <- r
	}()
	time.Sleep(20 * time.Millisecond)
	env.create(durationReq(ModeNormal, 30, "youtube"))
	select {
	case r := <-got:
		if len(r.Events) == 0 || r.LastSeq <= after {
			t.Fatalf("long poll %+v", r)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("the long poll did not wake up")
	}
	// A long poll that times out returns the empty page; ctx cancels it.
	short := 30
	last := env.e.state.LastEventSeq
	r, err := e.Events(bg, EventsQuery{Epoch: all.Epoch, After: &last, WaitMs: &short})
	if err != nil || len(r.Events) != 0 {
		t.Fatalf("timeout %+v %v", r, err)
	}
	ctx, cancel := context.WithCancel(bg)
	cancel()
	if _, err := e.Events(ctx, EventsQuery{Epoch: all.Epoch, After: &last, WaitMs: &wait}); err == nil {
		t.Fatal("a cancelled long poll must fail")
	}
	bad := -1
	if _, err := e.Events(bg, EventsQuery{After: ptr(int64(-1))}); apiCode(err) != "bad_query" {
		t.Fatal(err)
	}
	if _, err := e.Events(bg, EventsQuery{Limit: &bad}); apiCode(err) != "bad_query" {
		t.Fatal(err)
	}
}

// day_closed at local midnight (Europe/Madrid), with the goal in force.
func TestDayClose(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	day0 := e.localDay(e.now)
	// 10:00 UTC is 12:00 in Madrid: 12 h to midnight.
	env.advance(12*time.Hour + time.Minute)
	closed := env.eventsOf(EvDayClosed)
	if len(closed) != 1 {
		t.Fatalf("%d day_closed", len(closed))
	}
	d := mustDecode[DayClosedData](t, closed[0])
	if d.Day != day0 || d.GoalMinutes != int64(e.state.Settings.DailyGoalMinutes) || closed[0].Day != day0 {
		t.Fatalf("day_closed %+v (envelope day %s)", d, closed[0].Day)
	}
	if e.state.Ledger.LastClosedDay == nil || *e.state.Ledger.LastClosedDay != day0 {
		t.Fatal("ledger did not close the day")
	}
	p, err := e.Points(bg)
	if err != nil || p.Points.Today.Day == day0 || p.Points.StreakDays != 0 {
		t.Fatalf("points %+v %v", p, err)
	}
	// A restart after midnight closes the open day at startup (catch-up), once.
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	env.clk.RebootAfter(26 * time.Hour)
	env.open()
	if n := len(env.eventsOf(EvDayClosed)); n != 2 {
		t.Fatalf("%d day_closed after the catch-up", n)
	}
}

// Commands from many goroutines through the running loop (run with -race).
func TestLoopConcurrency(t *testing.T) {
	env := newTestEnv(t)
	o := env.options()
	o.NewTicker = func(time.Duration) Ticker { return newRealTicker(time.Millisecond) }
	e, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	env.e = e
	if err := e.Start(bg); err != nil {
		t.Fatal(err)
	}
	<-e.Ready()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 5; j++ {
				switch (i + j) % 4 {
				case 0:
					if _, err := e.CreateBlock(bg, Request{}, durationReq(ModeNormal, 30, "youtube")); err != nil && apiCode(err) != "too_many_targets" {
						t.Error(err)
					}
				case 1:
					if _, err := e.State(bg); err != nil {
						t.Error(err)
					}
				case 2:
					zero := 0
					if _, err := e.Events(bg, EventsQuery{WaitMs: &zero}); err != nil {
						t.Error(err)
					}
				case 3:
					env.clk.Advance(time.Second)
					e.Step()
				}
			}
		}(i)
	}
	wg.Wait()
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	if _, err := e.State(bg); err != ErrStopped {
		t.Fatalf("after Stop: %v", err)
	}
	// The clean shutdown left a consistent directory.
	env.clk.ServiceRestart(time.Second)
	e2 := env.open()
	if len(e2.activeBlocks()) == 0 {
		t.Fatal("blocks lost")
	}
	if n := len(env.eventsOf(EvTamperDetected)); n != 0 {
		t.Fatalf("clean restart penalized: %d", n)
	}
}

// Every state file and the log are gone, the hosts header survives: a recovered block
// keeps enforcing until `until` (§10.12).
func TestRecoveredBlockFromHostsHeader(t *testing.T) {
	env := newTestEnv(t)
	hh := NewFakeHeaderHosts()
	env.hosts, env.fh = hh, hh.FakeHosts
	e := env.open()
	env.create(durationReq(ModeStrict, 60, "youtube"))
	want := env.fh.Domains()
	if _, until, ok, _ := hh.Section(); !ok || until.IsZero() {
		t.Fatal("the header was not written")
	}
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"state.json", "state.prev.json", "events"} {
		if err := os.RemoveAll(filepath.Join(env.dir, n)); err != nil {
			t.Fatal(err)
		}
	}
	env.anchor.Set(nil)
	env.clk.ServiceRestart(time.Second)
	e = env.open()
	blocks := e.activeBlocks()
	if len(blocks) != 1 || blocks[0].Kind != KindRecovered || blocks[0].Mode != ModeStrict {
		t.Fatalf("recovered %+v", blocks)
	}
	if got := env.fh.Domains(); len(got) != len(want) {
		t.Fatalf("section %d domains, want %d", len(got), len(want))
	}
	started := env.eventsOf(EvGuardianStarted)
	if d := mustDecode[GuardianStartedData](t, started[len(started)-1]); d.Recovery != "hosts_section" {
		t.Fatalf("recovery %s", d.Recovery)
	}
	env.advance(61 * time.Minute)
	if len(env.fh.Domains()) != 0 {
		t.Fatal("the recovered block did not end")
	}
	if e.state.Ledger.Balance != 0 {
		t.Fatal("a recovered block earned points")
	}
}

// Diagnostics carry no domains, reasons or user paths.
func TestDiagnosticsNoPersonalData(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	req := durationReq(ModeNormal, 30)
	req.Targets.CustomDomains = []string{"secret-forum.example"}
	req.Reason = "Quiero aprobar mates"
	env.create(req)
	d, err := e.Diagnostics(bg)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(d)
	for _, bad := range []string{"secret-forum", "aprobar"} {
		if strings.Contains(string(raw), bad) {
			t.Fatalf("diagnostics leak %q", bad)
		}
	}
	if sanitizePath(`C:\Users\Ana\hosts\hosts`) != `%USERPROFILE%\hosts\hosts` || sanitizePath("/home/ana/etc/hosts") != "~/etc/hosts" {
		t.Fatal("sanitizePath")
	}
	if d.Hosts.Entries == 0 || d.State.Epoch == "" || d.Guardian.Version != "0.1.0-test" {
		t.Fatalf("diagnostics %+v", d)
	}
}

// The test clock drives the FakeClock through the engine (testhooks builds).
func TestTestClock(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	b := env.create(durationReq(ModeNormal, 10, "youtube"))
	if _, err := e.TestClock(bg, TestClockRequest{AdvanceMs: ptr(int64(11 * 60 * 1000))}); err != nil {
		t.Fatal(err)
	}
	if e.block(b.ID).Status != StatusCompleted {
		t.Fatal("advance did not complete the block")
	}
	if d := mustDecode[BlockCompletedData](t, env.eventsOf(EvBlockCompleted)[0]); d.CreditedMinutes != 10 {
		t.Fatalf("credited %d", d.CreditedMinutes)
	}
	if _, err := e.TestClock(bg, TestClockRequest{}); apiCode(err) != "validation_failed" {
		t.Fatal(err)
	}
}
