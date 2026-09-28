package engine

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/procwatch"
)

// After a reboot the guardian re-applies the active blocks (PROMPT §5 «Al arrancar el
// sistema, el guardián vuelve a aplicar los bloqueos activos»).
func TestRebootRecoveryReappliesHosts(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	b := env.create(durationReq(ModeStrict, 120, "youtube"))
	want := env.fh.Domains()
	if len(want) == 0 {
		t.Fatal("no section")
	}
	_ = e
	env.shutdown()
	// The machine reboots; something removed our section meanwhile.
	env.fh.Tamper(nil)
	env.clk.RebootAfter(2 * time.Minute)
	e = env.open()
	if got := env.fh.Domains(); !slices.Equal(got, want) {
		t.Fatalf("section after reboot: %d domains, want %d", len(got), len(want))
	}
	if e.block(b.ID).Status != StatusActive {
		t.Fatal("block lost across the reboot")
	}
	started := env.eventsOf(EvGuardianStarted)
	if d := mustDecode[GuardianStartedData](t, started[len(started)-1]); d.SameBoot || d.DowntimeMs != nil {
		t.Fatalf("guardian_started after reboot %+v", d)
	}
	// No stop penalty after a reboot.
	if len(env.eventsOf(EvTamperDetected)) != 0 {
		t.Fatal("a reboot was penalized")
	}
	// A crash (no clean shutdown) in the same boot also re-applies.
	env.e.crash()
	env.fh.Tamper([]string{"example.org"})
	env.clk.ServiceRestart(5 * time.Second)
	env.open()
	if got := env.fh.Domains(); !slices.Equal(got, want) {
		t.Fatal("section not re-applied after a crash")
	}
}

// Someone edits the section: it is re-applied at once and tamper_detected{hosts} is
// logged at most once a minute (§10.10).
func TestHostsTamperReapplied(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	env.create(durationReq(ModeNormal, 60, "youtube"))
	want := env.fh.Domains()
	notice := func() {
		t.Helper()
		if err := e.exec(bg, func() { e.timeStep(); e.onHostsChanged(); e.afterTurn() }); err != nil {
			t.Fatal(err)
		}
	}
	env.fh.Tamper(want[:1])
	notice()
	if got := env.fh.Domains(); !slices.Equal(got, want) {
		t.Fatalf("not re-applied: %d domains", len(got))
	}
	tam := env.eventsOf(EvTamperDetected)
	if len(tam) != 1 {
		t.Fatalf("%d tamper events", len(tam))
	}
	if d := mustDecode[TamperDetectedData](t, tam[0]); d.Kind != "hosts" || d.BalanceCorrection != 0 || d.VoidStreak {
		t.Fatalf("tamper %+v", d)
	}
	env.fh.Tamper(nil)
	notice()
	if got := env.fh.Domains(); !slices.Equal(got, want) {
		t.Fatal("not re-applied the second time")
	}
	if n := len(env.eventsOf(EvTamperDetected)); n != 1 {
		t.Fatalf("%d tamper events within a minute", n)
	}
	// The periodic verification (every 30 s) catches an edit the watcher missed, and a
	// minute after the last event a new one is logged.
	env.advance(time.Minute)
	env.fh.Tamper(want[1:])
	env.advance(31 * time.Second)
	if got := env.fh.Domains(); !slices.Equal(got, want) {
		t.Fatal("periodic verify did not re-apply")
	}
	if n := len(env.eventsOf(EvTamperDetected)); n != 2 {
		t.Fatalf("%d tamper events after a minute", n)
	}
	if e.state.Ledger.Balance != 0 {
		t.Fatal("hosts tampering while running must not cost points")
	}
}

// The watcher goroutines: with Start, a Tamper notice re-applies through the loop.
func TestHostsWatcherWithLoop(t *testing.T) {
	env := newTestEnv(t)
	o := env.options()
	o.DisableWatchers = false
	o.NewTicker = func(time.Duration) Ticker { return newRealTicker(time.Hour) }
	e, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	env.e = e
	ctx, cancel := context.WithCancel(bg)
	defer cancel()
	if err := e.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Stop() })
	<-e.Ready()
	if e.OpenErr() != nil {
		t.Fatal(e.OpenErr())
	}
	b, err := e.CreateBlock(bg, Request{}, durationReq(ModeNormal, 60, "youtube"))
	if err != nil {
		t.Fatal(err)
	}
	want := env.fh.Domains()
	deadline := time.Now().Add(5 * time.Second)
	for !env.fh.Tamper(nil) {
		if time.Now().After(deadline) {
			t.Fatal("the hosts watcher never started")
		}
		time.Sleep(5 * time.Millisecond)
	}
	for !slices.Equal(env.fh.Domains(), want) {
		if time.Now().After(deadline) {
			t.Fatal("not re-applied through the loop")
		}
		time.Sleep(5 * time.Millisecond)
	}
	g, err := e.GetBlock(bg, b.Block.ID)
	if err != nil || g.Block.Status != StatusActive {
		t.Fatalf("%+v %v", g, err)
	}
}

// discordProcess is a Discord executable name on this platform.
func discordProcess(t *testing.T, e *Engine) string {
	t.Helper()
	a := e.cat.App("discord")
	names := a.Processes.For(string(e.platform))
	if len(names) == 0 {
		t.Skip("no Discord process name on this platform")
	}
	return names[0]
}

// Process watcher detections in the grace cases emit process_closed and cost nothing
// (§10.8); the matcher follows the blocks.
func TestProcessDetectionsEmitProcessClosed(t *testing.T) {
	env := newTestEnv(t)
	boot := env.clk.Boot()
	env.logon = func() (time.Duration, bool) { return boot, true }
	e := env.open()
	name := discordProcess(t, e)
	if _, ok := e.Matcher().MatchName(name); ok {
		t.Fatal("matcher active without blocks")
	}
	b := env.create(durationReq(ModeStrict, 60, "discord"))
	if _, ok := e.Matcher().MatchName(name); !ok {
		t.Fatal("matcher does not follow the block")
	}
	if err := e.ReportProcessKilled(bg, procwatch.Killed{Target: name, Name: name, PIDs: []int{4242}}); err != nil {
		t.Fatal(err)
	}
	closed := env.eventsOf(EvProcessClosed)
	if len(closed) != 1 {
		t.Fatalf("%d process_closed", len(closed))
	}
	d := mustDecode[ProcessClosedData](t, closed[0])
	if d.Reason != "running_at_block_start" || d.AppID == nil || *d.AppID != "discord" || d.ServiceID == nil || *d.ServiceID != "discord" ||
		!slices.Equal(d.BlockIDs, []string{b.ID}) || d.Browser != nil || closed[0].Points != 0 {
		t.Fatalf("process_closed %+v points %d", d, closed[0].Points)
	}
	// After the block-start grace but within 90 s of the logon: logon_grace.
	env.clk.Advance(61 * time.Second)
	env.e.Step()
	env.logon = nil
	if err := e.ReportProcessKilled(bg, procwatch.Killed{Target: name, Name: name, PIDs: []int{4243}}); err != nil {
		t.Fatal(err)
	}
	closed = env.eventsOf(EvProcessClosed)
	if len(closed) != 2 || mustDecode[ProcessClosedData](t, closed[1]).Reason != "logon_grace" {
		t.Fatalf("logon grace: %v", types(closed))
	}
	// Later detections go to the attempt pipeline (attempts.go), never to process_closed.
	env.advance(time.Minute)
	if err := e.ReportProcessKilled(bg, procwatch.Killed{Target: name, Name: name, PIDs: []int{4244}}); err != nil {
		t.Fatal(err)
	}
	if n := len(env.eventsOf(EvProcessClosed)); n != 2 {
		t.Fatalf("%d process_closed after the graces", n)
	}
	// A detection of something no block covers is ignored.
	if err := e.ReportProcessKilled(bg, procwatch.Killed{Target: "unknown-app", Name: "unknown-app"}); err != nil {
		t.Fatal(err)
	}
	if n := len(env.eventsOf(EvProcessClosed)); n != 2 {
		t.Fatal("an uncovered detection was logged")
	}
}

// The real procwatch.Watcher on fake processes, through the loop: the process is
// closed and reported.
func TestProcessWatcherWithLoop(t *testing.T) {
	env := newTestEnv(t)
	o := env.options()
	o.DisableWatchers = false
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
	name := discordProcess(t, e)
	if _, err := e.CreateBlock(bg, Request{}, durationReq(ModeStrict, 60, "discord")); err != nil {
		t.Fatal(err)
	}
	env.procs.Start(name)
	deadline := time.Now().Add(5 * time.Second)
	for env.procs.Running(name) || len(env.eventsOf(EvProcessClosed)) == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("running %v, events %v", env.procs.Running(name), types(env.events()))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A whitelist allowance never reopens a host another block lists (§10.10): a hardcore
// block on a custom domain stays enforced under a normal whitelist block allowing it.
func TestWhitelistNeverReopensExplicitTargets(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	hc := durationReq(ModeHardcore, 60)
	hc.Targets.CustomDomains = []string{"myforum.com"}
	env.create(hc)
	wl := durationReq(ModeNormal, 30)
	wl.WhitelistOnly = true
	wl.Allow.CustomDomains = []string{"myforum.com"}
	env.create(wl)
	if got := env.fh.Domains(); !slices.Contains(got, "myforum.com") || !slices.Contains(got, "www.myforum.com") {
		t.Fatal("the whitelist allow set reopened a hardcore target in the hosts section")
	}
	if !slices.Contains(e.enf.BlockDomains, "myforum.com") {
		t.Fatal("blockDomains lost the hardcore target")
	}
	if e.enf.Whitelist == nil || !slices.Contains(e.enf.Whitelist.AllowDomains, "myforum.com") {
		t.Fatal("the whitelist rule must still exempt myforum.com from the whitelist rule")
	}
	// The whitelist part blocks distraction services the allow set does not exempt.
	yt := e.cat.Service("youtube").Domains[0]
	if !slices.Contains(env.fh.Domains(), yt) {
		t.Fatal("whitelist-only block does not block distraction services")
	}
	// Study sites stay open.
	for _, d := range e.cat.StudyWhitelistDomains() {
		if slices.Contains(env.fh.Domains(), d) {
			t.Fatalf("study site %s blocked by the whitelist rule", d)
		}
	}
}

// Protected, always-allowed and excluded hosts never reach the hosts section.
func TestEnforcementDropsProtectedHosts(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	all := durationReq(ModeNormal, 30)
	all.Targets.CategoryIDs = e.cat.CategoryIDs()
	env.create(all)
	got := env.fh.Domains()
	if len(got) == 0 {
		t.Fatal("empty section")
	}
	for _, d := range got {
		if e.cat.IsAlwaysAllowedHost(d) || e.cat.IsProtectedDomain(d) || slices.Contains(e.enf.ExcludedDomains, d) {
			t.Fatalf("%s must not be blocked", d)
		}
	}
	if len(got) > limits().HostsMaxDomains {
		t.Fatal("cap exceeded")
	}
}
