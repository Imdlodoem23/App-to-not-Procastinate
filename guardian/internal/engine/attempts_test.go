package engine

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/points"
	"github.com/imdlodoem23/centrate/guardian/internal/procwatch"
)

// Attempt tests (docs/ARCHITECTURE.md §10.8, §8.8 «POST /v1/attempts», §9.5). Helpers
// are prefixed att so they never collide with the other feature files' tests.

func attRules() points.PointRules { return points.DefaultPointRules() }

// attPenalty is the (negative) delta of a counted attempt with that escalation index.
func attPenalty(index int64) int64 { return -points.AttemptPenalty(index, attRules()) }

func attExtReq(host string) AttemptRequest {
	return AttemptRequest{Layer: LayerExtension, Target: AttemptTarget{Type: "domain", Value: host}, Browser: ptr("chrome")}
}

func attAppReq(service string) AttemptRequest {
	return AttemptRequest{Layer: LayerWindow, Target: AttemptTarget{Type: "service", Value: service}}
}

// attExt reports an extension detection and fails the test on an error.
func attExt(t *testing.T, env *testEnv, host string) AttemptResponse {
	t.Helper()
	res, err := env.e.ReportAttempt(bg, Request{Scope: scopeExt, ExtensionID: "ext_test"}, attExtReq(host))
	if err != nil {
		t.Fatalf("ReportAttempt(%s): %v", host, err)
	}
	return res
}

// attApp reports a window-title detection.
func attApp(t *testing.T, env *testEnv, service string) AttemptResponse {
	t.Helper()
	res, err := env.e.ReportAttempt(bg, Request{Scope: scopeApp}, attAppReq(service))
	if err != nil {
		t.Fatalf("ReportAttempt(%s): %v", service, err)
	}
	return res
}

// attTick moves real time by d with one engine step (no crediting granularity needed).
func attTick(env *testEnv, d time.Duration) {
	env.clk.Advance(d)
	env.e.Step()
}

func attSetPenalties(env *testEnv, on bool) {
	_ = env.e.exec(bg, func() { env.e.state.Settings.AttemptPenalties = on })
}

func TestAttemptScopeAndValidation(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	env.create(durationReq(ModeStrict, 60, "youtube"))
	for _, c := range []struct {
		name  string
		scope string
		req   AttemptRequest
		code  string
		path  string
	}{
		{"ext sends a service", scopeExt, AttemptRequest{Layer: LayerWindow, Target: AttemptTarget{Type: "service", Value: "youtube"}}, "insufficient_scope", ""},
		{"ext sends a window domain", scopeExt, AttemptRequest{Layer: LayerWindow, Target: AttemptTarget{Type: "domain", Value: "youtube.com"}}, "insufficient_scope", ""},
		{"app sends a domain", scopeApp, attExtReq("youtube.com"), "insufficient_scope", ""},
		{"no token", "", attAppReq("youtube"), "insufficient_scope", ""},
		{"process layer", scopeApp, AttemptRequest{Layer: LayerProcess, Target: AttemptTarget{Type: "service", Value: "youtube"}}, "insufficient_scope", ""},
		{"unknown layer", scopeApp, AttemptRequest{Layer: "dns", Target: AttemptTarget{Type: "service", Value: "youtube"}}, "validation_failed", "layer"},
		{"unknown target type", scopeExt, AttemptRequest{Layer: LayerExtension, Target: AttemptTarget{Type: "url", Value: "youtube.com"}}, "validation_failed", "target.type"},
		{"a URL, not a host", scopeExt, attExtReq("https://www.youtube.com/watch"), "validation_failed", "target.value"},
		{"uppercase host", scopeExt, attExtReq("WWW.YOUTUBE.COM"), "validation_failed", "target.value"},
		{"bad service id", scopeApp, attAppReq("You Tube"), "validation_failed", "target.value"},
		{"unknown browser", scopeExt, AttemptRequest{Layer: LayerExtension, Target: AttemptTarget{Type: "domain", Value: "youtube.com"}, Browser: ptr("netscape")}, "validation_failed", "browser"},
	} {
		_, err := e.ReportAttempt(bg, Request{Scope: c.scope}, c.req)
		if apiCode(err) != c.code {
			t.Fatalf("%s: %v, want %s", c.name, err, c.code)
		}
		if c.path != "" && apiDetails(err)["path"] != c.path {
			t.Fatalf("%s: details %v", c.name, apiDetails(err))
		}
	}
	if n := len(env.eventsOf(EvAttempt)); n != 0 {
		t.Fatalf("%d attempts logged by refused requests", n)
	}
	// An unknown catalog service (a newer app) is simply not blocked.
	if res := attApp(t, env, "some-future-service"); res.Blocked || res.Reason == nil || *res.Reason != "not_blocked" || res.ServiceID != nil {
		t.Fatalf("unknown service %+v", res)
	}
}

// Counted attempts go through the ledger: the first costs the base penalty, a repeat of
// the same key within the dedupe window merges (sliding window) and answers with the
// attempt it merged into, and escalation is global across keys (§6.1, §10.8).
func TestAttemptDedupeAndEscalation(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	blk := env.create(durationReq(ModeStrict, 120, "youtube", "instagram"))
	balance := e.state.Ledger.Balance

	first := attExt(t, env, "www.youtube.com")
	if !first.Blocked || !first.Counted || first.Merged || first.AttemptID == nil || first.PointsDelta != attPenalty(0) ||
		first.EpisodePointsDelta != attPenalty(0) || first.EscalationIndex == nil || *first.EscalationIndex != 0 ||
		first.NextPenalty != -attPenalty(1) || first.ServiceID == nil || *first.ServiceID != "youtube" || first.Reason != nil {
		t.Fatalf("first attempt %+v", first)
	}
	if first.Block == nil || first.Block.ID != blk.ID || first.Block.Mode != ModeStrict || first.Block.EndsAt != blk.EndsAt {
		t.Fatalf("block %+v", first.Block)
	}
	evs := env.eventsOf(EvAttempt)
	if len(evs) != 1 || evs[0].Points != attPenalty(0) {
		t.Fatalf("attempt events %v", types(evs))
	}
	d := mustDecode[AttemptData](t, evs[0])
	if d.AttemptID != *first.AttemptID || d.Layer != LayerExtension || d.TargetKey != "svc:youtube" || d.TargetType != "service" ||
		d.ServiceID == nil || *d.ServiceID != "youtube" || !slices.Equal(d.BlockIDs, []string{blk.ID}) || d.Browser == nil ||
		*d.Browser != "chrome" || d.Incognito || d.EscalationIndex != 0 || !d.Penalized {
		t.Fatalf("attempt data %+v", d)
	}
	if got := e.state.Ledger.Balance; got != balance+attPenalty(0) {
		t.Fatalf("balance %d, want %d", got, balance+attPenalty(0))
	}

	// Reloads within the dedupe window merge; the window slides with each detection.
	win := time.Duration(attRules().AttemptDedupeWindowMs) * time.Millisecond
	for range 3 {
		attTick(env, win-5*time.Second)
		m := attExt(t, env, "m.youtube.com")
		if !m.Blocked || m.Counted || !m.Merged || m.PointsDelta != 0 || m.EscalationIndex != nil ||
			m.AttemptID == nil || *m.AttemptID != *first.AttemptID || m.EpisodePointsDelta != first.PointsDelta || m.Block == nil {
			t.Fatalf("merged detection %+v", m)
		}
	}
	// The window app (same service key) merges into the extension's attempt too.
	if m := attApp(t, env, "youtube"); !m.Merged || m.AttemptID == nil || *m.AttemptID != *first.AttemptID {
		t.Fatalf("cross-layer merge %+v", m)
	}
	if n := len(env.eventsOf(EvAttempt)); n != 1 {
		t.Fatalf("%d attempt events after merges", n)
	}
	// Another key within the escalation window escalates.
	second := attExt(t, env, "www.instagram.com")
	if !second.Counted || *second.EscalationIndex != 1 || second.PointsDelta != attPenalty(1) || second.NextPenalty != -attPenalty(2) {
		t.Fatalf("second key %+v", second)
	}
	// After the dedupe window the same key counts again, escalated.
	attTick(env, win)
	third := attExt(t, env, "youtube.com")
	if !third.Counted || *third.EscalationIndex != 2 || third.PointsDelta != attPenalty(2) || *third.AttemptID == *first.AttemptID {
		t.Fatalf("after the window %+v", third)
	}
	// After the escalation window the index starts over.
	attTick(env, time.Duration(attRules().AttemptEscalationWindowMs)*time.Millisecond)
	fourth := attExt(t, env, "youtube.com")
	if !fourth.Counted || *fourth.EscalationIndex != 0 || fourth.PointsDelta != attPenalty(0) {
		t.Fatalf("after the escalation window %+v", fourth)
	}
	if got := e.block(blk.ID).AttemptsCounted; got != 4 {
		t.Fatalf("attemptsCounted %d, want 4", got)
	}
	if s := env.state(); s.Blocks[0].AttemptsCounted != 4 {
		t.Fatalf("state attemptsCounted %d", s.Blocks[0].AttemptsCounted)
	}
}

// The escalation index is capped where the penalty reaches the cap.
func TestAttemptPenaltyCap(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	env.create(durationReq(ModeNormal, 60, "youtube", "instagram", "tiktok", "reddit", "twitch", "netflix"))
	maxIndex := points.MaxEscalationIndex(attRules())
	var last AttemptResponse
	for _, s := range []string{"youtube.com", "instagram.com", "tiktok.com", "reddit.com", "twitch.tv", "netflix.com"} {
		if e.cat.FindServiceByDomain(s) == nil {
			t.Fatalf("%s is not a catalog host", s)
		}
		last = attExt(t, env, s)
		if !last.Counted {
			t.Fatalf("%s not counted: %+v", s, last)
		}
	}
	if *last.EscalationIndex != maxIndex || -last.PointsDelta != int64(attRules().AttemptPenaltyCap) || last.NextPenalty != int64(attRules().AttemptPenaltyCap) {
		t.Fatalf("capped attempt %+v (max index %d)", last, maxIndex)
	}
}

// Coverage per layer (§10.8): subdomains of a resolved domain, never excluded,
// always-allowed or protected hosts; custom domains key by host; categories cover the
// window layer.
func TestAttemptCoverage(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	notBlocked := func(res AttemptResponse) bool {
		return !res.Blocked && !res.Counted && res.Reason != nil && *res.Reason == "not_blocked" && res.Block == nil && res.AttemptID == nil
	}
	// Nothing active: not blocked, and nothing is charged.
	if res := attExt(t, env, "www.youtube.com"); !notBlocked(res) || res.NextPenalty != -attPenalty(0) {
		t.Fatalf("without blocks %+v", res)
	}
	custom := durationReq(ModeStrict, 60)
	custom.Targets.CustomDomains = []string{"example.org"}
	cb := env.create(custom)
	yt := e.cat.Service("youtube")
	cat := durationReq(ModeNormal, 30)
	cat.Targets.CategoryIDs = []string{yt.Categories[0]}
	env.create(cat)

	if res := attExt(t, env, "forum.example.org"); !res.Blocked || !res.Counted || res.ServiceID != nil || res.Block.ID != cb.ID {
		t.Fatalf("custom subdomain %+v", res)
	}
	if d := mustDecode[AttemptData](t, env.eventsOf(EvAttempt)[0]); d.TargetKey != "dom:forum.example.org" || d.TargetType != "domain" || d.ServiceID != nil {
		t.Fatalf("custom domain data %+v", d)
	}
	// www. is dropped from dom: keys: a reload of www.example.org merges with example.org.
	attExt(t, env, "example.org")
	if res := attExt(t, env, "www.example.org"); !res.Merged {
		t.Fatalf("www. variant %+v", res)
	}
	// A host that only shares a suffix is not under the domain.
	if res := attExt(t, env, "notexample.org"); !notBlocked(res) {
		t.Fatalf("suffix look-alike %+v", res)
	}
	for _, h := range e.cat.AlwaysAllowedHosts() {
		if res := attExt(t, env, h); !notBlocked(res) {
			t.Fatalf("always-allowed %s %+v", h, res)
		}
	}
	for _, s := range []string{"youtube", "instagram"} {
		for _, h := range e.cat.Service(s).ExcludedSubdomains {
			if res := attExt(t, env, h); !notBlocked(res) {
				t.Fatalf("excluded %s %+v", h, res)
			}
		}
	}
	if pd := e.cat.ProtectedDomains(); len(pd) > 0 {
		if res := attExt(t, env, pd[0]); !notBlocked(res) {
			t.Fatalf("protected %s %+v", pd[0], res)
		}
	}
	// The window layer: the category covers the service; another category's service is
	// not blocked.
	if res := attApp(t, env, "youtube"); !res.Blocked || !res.Counted || res.ServiceID == nil || *res.ServiceID != "youtube" {
		t.Fatalf("window layer %+v", res)
	}
	d := mustDecode[AttemptData](t, env.eventsOf(EvAttempt)[len(env.eventsOf(EvAttempt))-1])
	if d.Layer != LayerWindow || d.TargetKey != "svc:youtube" || d.TargetType != "service" || d.Browser != nil {
		t.Fatalf("window attempt %+v", d)
	}
	for _, s := range e.cat.Snapshot().Services {
		if !slices.Contains(s.Categories, yt.Categories[0]) {
			if res := attApp(t, env, s.ID); !notBlocked(res) {
				t.Fatalf("service %s outside the category %+v", s.ID, res)
			}
			break
		}
	}
}

// The response names the covering block with the latest endsAt (ties: the most recently
// created); every covering block counts the attempt.
func TestAttemptBlockChoice(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	short := env.create(durationReq(ModeNormal, 30, "youtube"))
	long := env.create(durationReq(ModeStrict, 90, "youtube"))
	env.create(durationReq(ModeStrict, 120, "instagram"))
	twin := env.create(durationReq(ModeHardcore, 90, "youtube"))
	if twin.EndsAt != long.EndsAt {
		t.Skip("blocks created in the same millisecond expected")
	}
	res := attExt(t, env, "youtube.com")
	if res.Block == nil || res.Block.ID != twin.ID || res.Block.Kind != KindManual || res.Block.Mode != ModeHardcore {
		t.Fatalf("block %+v, want %s", res.Block, twin.ID)
	}
	d := mustDecode[AttemptData](t, env.eventsOf(EvAttempt)[0])
	if !slices.Equal(d.BlockIDs, []string{short.ID, long.ID, twin.ID}) {
		t.Fatalf("blockIds %v", d.BlockIDs)
	}
	for _, id := range d.BlockIDs {
		if e.block(id).AttemptsCounted != 1 {
			t.Fatalf("%s attemptsCounted %d", id, e.block(id).AttemptsCounted)
		}
	}
	// The count reaches the completion (no clean bonus).
	env.advance(31 * time.Minute)
	comp := env.eventsOf(EvBlockCompleted)
	if len(comp) != 1 || mustDecode[BlockCompletedData](t, comp[0]).AttemptsCounted != 1 {
		t.Fatalf("completion %v", types(comp))
	}
}

// Whitelist blocks cover every host their allow set does not allow; the allow set never
// exempts a host another block lists (§10.10).
func TestAttemptWhitelistCoverage(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	wl := durationReq(ModeNormal, 60)
	wl.WhitelistOnly = true
	wl.Allow.CustomDomains = []string{"myforum.com"}
	w := env.create(wl)
	study := e.cat.StudyWhitelistDomains()[0]
	if res := attExt(t, env, study); res.Blocked {
		t.Fatalf("study site %s %+v", study, res)
	}
	if res := attExt(t, env, "www.myforum.com"); res.Blocked {
		t.Fatalf("allowed custom domain %+v", res)
	}
	if res := attExt(t, env, "random-site.net"); !res.Blocked || !res.Counted || res.Block.ID != w.ID || res.ServiceID != nil {
		t.Fatalf("any other host %+v", res)
	}
	if res := attApp(t, env, "youtube"); !res.Blocked || !res.Counted || res.Block.ID != w.ID {
		t.Fatalf("window layer under a whitelist %+v", res)
	}
	// A hardcore block on the allowed domain keeps it blocked.
	hc := durationReq(ModeHardcore, 30)
	hc.Targets.CustomDomains = []string{"myforum.com"}
	h := env.create(hc)
	res := attExt(t, env, "myforum.com")
	if !res.Blocked || !res.Counted || res.Block.ID != h.ID {
		t.Fatalf("hardcore target under the whitelist %+v", res)
	}
	if d := mustDecode[AttemptData](t, env.eventsOf(EvAttempt)[2]); !slices.Equal(d.BlockIDs, []string{h.ID}) {
		t.Fatalf("covering blocks %v, want only the hardcore block", d.BlockIDs)
	}
}

// A service with an active allowance is not blocked (reason allowance_active) and
// costs nothing; other services stay blocked.
func TestAttemptAllowance(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	env.create(durationReq(ModeNormal, 120, "youtube", "instagram"))
	_ = e.exec(bg, func() { e.state.Ledger.Balance += 1000; e.markDirty(true) })
	if _, err := e.RedeemReward(bg, Request{Scope: scopeApp}, RedeemRewardRequest{OfferID: "youtube-15"}); err != nil {
		t.Fatalf("RedeemReward: %v", err)
	}
	balance := e.state.Ledger.Balance
	for _, res := range []AttemptResponse{attExt(t, env, "www.youtube.com"), attApp(t, env, "youtube")} {
		if res.Blocked || res.Counted || res.Reason == nil || *res.Reason != "allowance_active" || res.Block != nil ||
			res.ServiceID == nil || *res.ServiceID != "youtube" {
			t.Fatalf("allowance %+v", res)
		}
	}
	if res := attExt(t, env, "www.instagram.com"); !res.Counted {
		t.Fatalf("other service %+v", res)
	}
	if got := e.state.Ledger.Balance; got != balance+attPenalty(0) {
		t.Fatalf("balance %d, want %d", got, balance+attPenalty(0))
	}
}

// With attemptPenalties off attempts still count (and escalate) but cost nothing.
func TestAttemptPenaltiesOff(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	env.create(durationReq(ModeStrict, 60, "youtube"))
	attSetPenalties(env, false)
	res := attExt(t, env, "youtube.com")
	if !res.Counted || res.PointsDelta != 0 || res.EpisodePointsDelta != 0 || res.NextPenalty != 0 || *res.EscalationIndex != 0 {
		t.Fatalf("penalties off %+v", res)
	}
	ev := env.eventsOf(EvAttempt)
	if d := mustDecode[AttemptData](t, ev[0]); d.Penalized || ev[0].Points != 0 {
		t.Fatalf("attempt %+v points %d", d, ev[0].Points)
	}
	if e.state.Ledger.Escalation.LastCountedAtMs == nil {
		t.Fatal("an unpenalized attempt must still escalate")
	}
}

// Process detections outside the graces go through the same pipeline (layer process),
// and merge with the other layers' detections of the same service.
func TestProcessAttempts(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	name := discordProcess(t, e)
	blk := env.create(durationReq(ModeStrict, 60, "discord"))
	env.advance(2 * time.Minute) // past the block-start grace; no logon grace configured
	kill := func() {
		t.Helper()
		if err := e.ReportProcessKilled(bg, procwatch.Killed{Target: name, Name: name, PIDs: []int{4242}}); err != nil {
			t.Fatal(err)
		}
	}
	kill()
	evs := env.eventsOf(EvAttempt)
	if len(evs) != 1 || len(env.eventsOf(EvProcessClosed)) != 0 || evs[0].Points != attPenalty(0) {
		t.Fatalf("events %v", types(env.events()))
	}
	d := mustDecode[AttemptData](t, evs[0])
	if d.Layer != LayerProcess || d.TargetKey != "svc:discord" || d.TargetType != "service" || d.ServiceID == nil ||
		*d.ServiceID != "discord" || !slices.Equal(d.BlockIDs, []string{blk.ID}) || d.Browser != nil {
		t.Fatalf("process attempt %+v", d)
	}
	kill()
	if n := len(env.eventsOf(EvAttempt)); n != 1 {
		t.Fatalf("a relaunch within the dedupe window counted again (%d)", n)
	}
	if res := attApp(t, env, "discord"); !res.Merged || res.AttemptID == nil || *res.AttemptID != d.AttemptID || res.EpisodePointsDelta != evs[0].Points {
		t.Fatalf("window detection after the process one %+v", res)
	}
	if e.block(blk.ID).AttemptsCounted != 1 {
		t.Fatalf("attemptsCounted %d", e.block(blk.ID).AttemptsCounted)
	}
}

// Attempt counts and the dedupe window survive a restart; a rebuild from the log also
// rebuilds the merge memo.
func TestAttemptPersistence(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	blk := env.create(durationReq(ModeStrict, 60, "youtube"))
	first := attExt(t, env, "youtube.com")
	e := env.restart()
	if got := e.block(blk.ID).AttemptsCounted; got != 1 {
		t.Fatalf("attemptsCounted after a restart %d", got)
	}
	if res := attExt(t, env, "www.youtube.com"); !res.Blocked || !res.Merged || res.Counted || res.PointsDelta != 0 {
		t.Fatalf("merge after a restart %+v", res)
	}
	if n := len(env.eventsOf(EvAttempt)); n != 1 {
		t.Fatalf("%d attempts after a restart", n)
	}
	// A rebuild from the log (state files lost) replays the reducer.
	balance := e.state.Ledger.Balance
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"state.json", "state.prev.json"} {
		if err := os.Remove(filepath.Join(env.dir, f)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			t.Fatal(err)
		}
	}
	e = env.open()
	if got := e.block(blk.ID).AttemptsCounted; got != 1 {
		t.Fatalf("attemptsCounted after a rebuild %d", got)
	}
	if e.state.Ledger.Balance != balance {
		t.Fatalf("balance after a rebuild %d, want %d", e.state.Ledger.Balance, balance)
	}
	if res := attExt(t, env, "m.youtube.com"); !res.Merged || res.AttemptID == nil || *res.AttemptID != *first.AttemptID ||
		res.EpisodePointsDelta != first.PointsDelta {
		t.Fatalf("merge after a rebuild %+v", res)
	}
	// Past the dedupe window the memo is forgotten.
	attTick(env, time.Duration(attRules().AttemptDedupeWindowMs)*time.Millisecond)
	if res := attExt(t, env, "instagram.com"); res.Blocked {
		t.Fatalf("instagram %+v", res)
	}
	if res := attExt(t, env, "youtube.com"); !res.Counted || *res.AttemptID == *first.AttemptID {
		t.Fatalf("after the window %+v", res)
	}
	if m := e.lastCountKey["svc:youtube"]; m.AttemptID == *first.AttemptID {
		t.Fatal("memo not replaced by the new attempt")
	}
	// No host of a dom: key reaches state.json through the attempts state.
	attExt(t, env, "www.example.net")
	raw, err := json.Marshal(e.state.Attempts)
	if err != nil || string(raw) != "{}" {
		t.Fatalf("persisted attempts state %s %v", raw, err)
	}
}

// In frozen or safe mode attempts are writes: 503 read_only.
func TestAttemptReadOnly(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	env.create(durationReq(ModeStrict, 60, "youtube"))
	_ = e.exec(bg, func() { e.mode = ModeGuardianSafe })
	if _, err := e.ReportAttempt(bg, Request{Scope: scopeExt}, attExtReq("youtube.com")); apiCode(err) != "read_only" {
		t.Fatalf("safe mode: %v", err)
	}
}
