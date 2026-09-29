package engine

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// Daily limits tests (docs/ARCHITECTURE.md §5.10, §10.13, §8.8). Helpers are prefixed lim.
// testStart is Monday 2026-09-28 10:00 UTC, 12:00 in Europe/Madrid (the test zone), so
// the next local midnight is 22:00 UTC.

var limMidnight = time.Date(2026, 9, 28, 22, 0, 0, 0, time.UTC)

const limExt = "ext_limitsTestExtension00"

var limAllDays = []int{1, 2, 3, 4, 5, 6, 7}

// limIn is a strict limit on catalog services, every day.
func limIn(name string, minutes int64, services ...string) DailyLimitInput {
	t := emptyTargets()
	t.ServiceIDs = services
	return DailyLimitInput{Name: name, Enabled: true, Targets: t, DailyMinutes: minutes, Days: slices.Clone(limAllDays), Mode: ModeStrict}
}

// limInputOf re-sends a limit's effective definition (limitInputFromLimit).
func limInputOf(l DailyLimit) DailyLimitInput {
	d := l.DailyLimitDefinition
	return DailyLimitInput{Name: d.Name, Enabled: d.Enabled, Targets: d.Targets.normalized(), DailyMinutes: d.DailyMinutes,
		Days: slices.Clone(d.Days), Mode: d.Mode, Reason: d.Reason, AcknowledgeNoEmergency: d.Mode == ModeHardcore}
}

func limCreate(t *testing.T, env *testEnv, in DailyLimitInput) DailyLimit {
	t.Helper()
	res, err := env.e.CreateLimit(bg, Request{Scope: scopeApp}, in)
	if err != nil {
		t.Fatalf("CreateLimit(%s): %v", in.Name, err)
	}
	return res.Limit
}

func limUpdate(t *testing.T, env *testEnv, id string, in DailyLimitInput) DailyLimit {
	t.Helper()
	res, err := env.e.UpdateLimit(bg, Request{Scope: scopeApp}, id, in)
	if err != nil {
		t.Fatalf("UpdateLimit: %v", err)
	}
	return res.Limit
}

func limGet(t *testing.T, env *testEnv, id string) DailyLimit {
	t.Helper()
	res, err := env.e.ListLimits(bg)
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range res.Limits {
		if l.ID == id {
			return l
		}
	}
	t.Fatalf("limit %s not listed", id)
	return DailyLimit{}
}

func limHas(t *testing.T, env *testEnv, id string) bool {
	t.Helper()
	res, err := env.e.ListLimits(bg)
	if err != nil {
		t.Fatal(err)
	}
	return slices.ContainsFunc(res.Limits, func(l DailyLimit) bool { return l.ID == id })
}

// limReport sends one usage report from the extension (domains) or the app (processes).
func limReport(env *testEnv, scope string, interval time.Duration, items ...UsageItem) (UsageReportResponse, error) {
	r := Request{Scope: scope}
	if scope == scopeExt {
		r.ExtensionID = limExt
	}
	return env.e.ReportUsage(bg, r, UsageReportRequest{IntervalMs: interval.Milliseconds(), Items: items})
}

func limDomain(host string, seconds int64) UsageItem {
	return UsageItem{Type: usageTypeDomain, Value: host, Seconds: seconds}
}

// limBrowse spends d on host: the machine awake, one step per 30 s and a 30 s report
// from the extension after each.
func limBrowse(t *testing.T, env *testEnv, host string, d time.Duration) UsageReportResponse {
	t.Helper()
	var last UsageReportResponse
	for d > 0 {
		s := min(30*time.Second, d)
		env.clk.Advance(s)
		env.e.Step()
		res, err := limReport(env, scopeExt, s, limDomain(host, int64(s/time.Second)))
		if err != nil {
			t.Fatalf("ReportUsage: %v", err)
		}
		last = res
		d -= s
	}
	return last
}

func limStatus(res UsageReportResponse, id string) LimitUsageStatus {
	for _, s := range res.Limits {
		if s.LimitID == id {
			return s
		}
	}
	return LimitUsageStatus{}
}

// limBlocks are the blocks (any status) a limit materialized.
func limBlocks(e *Engine, id string) []*blockRec {
	var out []*blockRec
	for _, b := range e.state.Blocks {
		if b.LimitID != nil && *b.LimitID == id {
			out = append(out, b)
		}
	}
	return out
}

func TestLimitsCreateAndList(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	l := limCreate(t, env, limIn("YouTube", 30, "youtube"))
	if !isIDOf(l.ID, "lim") || l.Day != "2026-09-28" || !l.AppliesToday || l.UsedTodaySeconds != 0 ||
		l.RemainingTodaySeconds != 1800 || l.ReachedAt != nil || l.ActiveBlockID != nil || l.PendingChange != nil {
		t.Fatalf("created %+v", l)
	}
	if l.CreatedAt != fmtMs(testStart.UnixMilli()) || l.Mode != ModeStrict || !slices.Equal(l.Days, limAllDays) {
		t.Fatalf("created %+v", l)
	}
	evs := env.eventsOf(EvLimitCreated)
	if len(evs) != 1 {
		t.Fatalf("limit_created events %d", len(evs))
	}
	d := mustDecode[LimitCreatedData](t, evs[0])
	if d.Limit.ID != l.ID || d.Limit.Name != "YouTube" || evs[0].Points != 0 {
		t.Fatalf("limit_created %+v", d)
	}
	// Days are stored sorted; the state shows every limit.
	in := limIn("Redes", 60, "instagram", "tiktok")
	in.Days = []int{5, 1, 3}
	l2 := limCreate(t, env, in)
	if !slices.Equal(l2.Days, []int{1, 3, 5}) {
		t.Fatalf("days %v", l2.Days)
	}
	st := env.state()
	if len(st.Limits) != 2 || st.Limits[0].ID != l.ID || st.Limits[1].ID != l2.ID {
		t.Fatalf("state limits %+v", st.Limits)
	}
	// Nothing is blocked while the allowance lasts.
	if len(st.Blocks) != 0 || len(env.fh.Domains()) != 0 {
		t.Fatalf("blocked before the allowance ran out: %+v", st.Blocks)
	}
}

func TestLimitsValidation(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	mod := func(f func(*DailyLimitInput)) DailyLimitInput {
		in := limIn("YouTube", 30, "youtube")
		f(&in)
		return in
	}
	cases := []struct {
		name  string
		in    DailyLimitInput
		code  string
		path  string
		issue string
	}{
		{"empty name", mod(func(in *DailyLimitInput) { in.Name = "" }), "validation_failed", "name", "length"},
		{"long name", mod(func(in *DailyLimitInput) { in.Name = strings.Repeat("a", 61) }), "validation_failed", "name", "length"},
		{"control in name", mod(func(in *DailyLimitInput) { in.Name = "a\u0007" }), "validation_failed", "name", "pattern"},
		{"bad service id", mod(func(in *DailyLimitInput) { in.Targets.ServiceIDs = []string{"You Tube"} }), "validation_failed", "targets.serviceIds[0]", "pattern"},
		{"too few minutes", mod(func(in *DailyLimitInput) { in.DailyMinutes = 4 }), "validation_failed", "dailyMinutes", "range"},
		{"too many minutes", mod(func(in *DailyLimitInput) { in.DailyMinutes = 721 }), "validation_failed", "dailyMinutes", "range"},
		{"no days", mod(func(in *DailyLimitInput) { in.Days = []int{} }), "validation_failed", "days", "length"},
		{"bad day", mod(func(in *DailyLimitInput) { in.Days = []int{1, 8} }), "validation_failed", "days[1]", "enum"},
		{"duplicate day", mod(func(in *DailyLimitInput) { in.Days = []int{2, 2} }), "validation_failed", "days[1]", "duplicate"},
		{"exam mode", mod(func(in *DailyLimitInput) { in.Mode = ModeExam }), "validation_failed", "mode", "enum"},
		{"long reason", mod(func(in *DailyLimitInput) { in.Reason = strings.Repeat("r", 141) }), "validation_failed", "reason", "length"},
		{"no targets", mod(func(in *DailyLimitInput) { in.Targets = emptyTargets() }), "validation_failed", "targets", "rule"},
		{"protected process", mod(func(in *DailyLimitInput) { in.Targets.CustomProcesses = []string{"explorer.exe"} }), "protected_target", "targets.customProcesses[0]", "protected_process"},
		{"unknown service", mod(func(in *DailyLimitInput) { in.Targets.ServiceIDs = []string{"nope-service"} }), "unknown_id", "targets.serviceIds[0]", ""},
		{"protected domain", mod(func(in *DailyLimitInput) { in.Targets.CustomDomains = []string{"windowsupdate.com"} }), "protected_target", "targets.customDomains[0]", ""},
	}
	for _, c := range cases {
		_, err := e.CreateLimit(bg, Request{Scope: scopeApp}, c.in)
		if apiCode(err) != c.code {
			t.Errorf("%s: %v, want %s", c.name, err, c.code)
			continue
		}
		d := apiDetails(err)
		if d["path"] != c.path || (c.issue != "" && d["issue"] != c.issue) {
			t.Errorf("%s: details %v, want %s %s", c.name, d, c.path, c.issue)
		}
	}
	// Hardcore needs the no-emergency confirmation.
	hard := limIn("YouTube", 30, "youtube")
	hard.Mode = ModeHardcore
	_, err := e.CreateLimit(bg, Request{Scope: scopeApp}, hard)
	if apiCode(err) != "confirmation_required" || fmt.Sprint(apiDetails(err)["needs"]) != "[no_emergency]" {
		t.Fatalf("hardcore without confirmation: %v %v", err, apiDetails(err))
	}
	hard.AcknowledgeNoEmergency = true
	h := limCreate(t, env, hard)
	// Updating a hardcore limit needs the confirmation again (limitInputFromLimit sends it).
	in := limInputOf(h)
	in.AcknowledgeNoEmergency = false
	if _, err := e.UpdateLimit(bg, Request{Scope: scopeApp}, h.ID, in); apiCode(err) != "confirmation_required" {
		t.Fatalf("hardcore update without confirmation: %v", err)
	}
	// Unknown ids.
	if _, err := e.UpdateLimit(bg, Request{Scope: scopeApp}, "lim_0000000000000000000000", limIn("x", 30, "youtube")); apiCode(err) != "not_found" {
		t.Fatalf("PUT unknown: %v", err)
	}
	if _, err := e.DeleteLimit(bg, Request{Scope: scopeApp}, "lim_0000000000000000000000"); apiCode(err) != "not_found" {
		t.Fatalf("DELETE unknown: %v", err)
	}
	// At most maxLimits.
	for i := len(env.state().Limits); i < limits().MaxLimits; i++ {
		limCreate(t, env, limIn(fmt.Sprintf("L%d", i), 30, "youtube"))
	}
	_, err = e.CreateLimit(bg, Request{Scope: scopeApp}, limIn("one too many", 30, "youtube"))
	if d := apiDetails(err); apiCode(err) != "validation_failed" || d["path"] != "$" || d["issue"] != "length" || d["limit"] != limits().MaxLimits {
		t.Fatalf("over maxLimits: %v %v", err, d)
	}
}

func TestLimitsCustomHostBudget(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	domains := func(prefix string, n int) []string {
		out := make([]string, n)
		for i := range out {
			out[i] = fmt.Sprintf("%s%d.example.org", prefix, i)
		}
		return out
	}
	custom := func(name, prefix string) DailyLimitInput {
		in := limIn(name, 30)
		in.Targets.CustomDomains = domains(prefix, limits().MaxCustomDomains)
		return in
	}
	per := e.customHostCount(domains("a", limits().MaxCustomDomains))
	fit := limits().MaxLimitCustomHosts / per
	for i := range fit {
		limCreate(t, env, custom(fmt.Sprintf("C%d", i), fmt.Sprintf("c%d-", i)))
	}
	_, err := e.CreateLimit(bg, Request{Scope: scopeApp}, custom("over", "over-"))
	d := apiDetails(err)
	if apiCode(err) != "too_many_targets" || d["kind"] != "limit_custom_hosts" || d["limit"] != limits().MaxLimitCustomHosts {
		t.Fatalf("over the budget: %v %v", err, d)
	}
	// A disabled limit is outside the budget.
	off := custom("off", "off-")
	off.Enabled = false
	limCreate(t, env, off)
}

// A limit reached at 18:00 blocks until local midnight and resets at 00:00 (§15).
func TestLimitsReachBlocksUntilMidnight(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	l := limCreate(t, env, limIn("YouTube", 30, "youtube"))

	// 24 minutes of YouTube: no warning yet (6 min left).
	res := limBrowse(t, env, "www.youtube.com", 24*time.Minute)
	if s := limStatus(res, l.ID); s.UsedTodaySeconds != 24*60 || s.RemainingTodaySeconds != 6*60 || !s.AppliesToday || s.BlockedUntil != nil {
		t.Fatalf("after 24 min %+v", s)
	}
	if len(env.eventsOf(EvLimitWarning)) != 0 {
		t.Fatal("warned with 6 minutes left")
	}
	// Other hosts and the limit's excluded hosts count nothing.
	res = limBrowse(t, env, "www.wikipedia.org", time.Minute)
	if s := limStatus(res, l.ID); s.UsedTodaySeconds != 24*60 || s.CreditedSeconds != 0 {
		t.Fatalf("an unrelated host counted %+v", s)
	}
	res = limBrowse(t, env, "accounts.youtube.com", time.Minute)
	if s := limStatus(res, l.ID); s.UsedTodaySeconds != 24*60 {
		t.Fatalf("an excluded host counted %+v", s)
	}
	// One more minute: 5 minutes left, one warning.
	limBrowse(t, env, "m.youtube.com", time.Minute)
	limBrowse(t, env, "m.youtube.com", time.Minute)
	warn := env.eventsOf(EvLimitWarning)
	if len(warn) != 1 {
		t.Fatalf("limit_warning events %d", len(warn))
	}
	if w := mustDecode[LimitWarningData](t, warn[0]); w.LimitID != l.ID || w.RemainingSeconds != 300 || w.UsedSeconds != 1500 || w.Day != "2026-09-28" || w.DailyMinutes != 30 {
		t.Fatalf("limit_warning %+v", w)
	}
	// The allowance runs out: limit_reached and a limit block until local midnight.
	res = limBrowse(t, env, "www.youtube.com", 5*time.Minute)
	reached := env.eventsOf(EvLimitReached)
	if len(reached) != 1 || len(env.eventsOf(EvLimitWarning)) != 1 {
		t.Fatalf("limit_reached %d, warnings %d", len(reached), len(env.eventsOf(EvLimitWarning)))
	}
	rd := mustDecode[LimitReachedData](t, reached[0])
	blocks := limBlocks(env.e, l.ID)
	if len(blocks) != 1 || rd.BlockID == nil || *rd.BlockID != blocks[0].ID || rd.UsedSeconds != 1800 {
		t.Fatalf("limit_reached %+v, blocks %d", rd, len(blocks))
	}
	blk := blocks[0]
	if blk.Kind != KindLimit || blk.Mode != ModeStrict || blk.EndsAt != limMidnight.UnixMilli() || blk.Status != StatusActive {
		t.Fatalf("limit block %+v (ends %s)", blk, fmtMs(blk.EndsAt))
	}
	if s := limStatus(res, l.ID); s.BlockedUntil == nil || *s.BlockedUntil != fmtMs(limMidnight.UnixMilli()) || s.RemainingTodaySeconds != 0 {
		t.Fatalf("usage status %+v", s)
	}
	created := env.eventsOf(EvBlockCreated)
	if bc := mustDecode[BlockCreatedData](t, created[len(created)-1]); bc.Source != "limit" || bc.Block.LimitID == nil || *bc.Block.LimitID != l.ID {
		t.Fatalf("block_created %+v", bc)
	}
	// Enforced like any block.
	if !slices.Contains(env.fh.Domains(), "youtube.com") {
		t.Fatalf("hosts %v", env.fh.Domains())
	}
	got := limGet(t, env, l.ID)
	if got.ReachedAt == nil || got.ActiveBlockID == nil || *got.ActiveBlockID != blk.ID {
		t.Fatalf("limit after reaching %+v", got)
	}
	st := env.state()
	if len(st.Blocks) != 1 || st.Blocks[0].Kind != KindLimit || st.Blocks[0].LimitID == nil {
		t.Fatalf("state blocks %+v", st.Blocks)
	}
	// Reaching again the same day does nothing.
	limBrowse(t, env, "www.youtube.com", time.Minute)
	if len(env.eventsOf(EvLimitReached)) != 1 || len(limBlocks(env.e, l.ID)) != 1 {
		t.Fatal("reached twice in one day")
	}

	// Midnight: the block completes without points, limit_day_closed, a fresh day.
	schForwardTo(env, limMidnight.Add(time.Minute), time.Minute)
	if blk.Status != StatusCompleted || blk.PointsDelta == nil || *blk.PointsDelta != 0 {
		t.Fatalf("limit block at midnight %+v", blk)
	}
	for _, ev := range env.eventsOf(EvBlockCompleted) {
		if ev.Points != 0 {
			t.Fatalf("a limit block earned %d", ev.Points)
		}
	}
	closed := env.eventsOf(EvLimitDayClosed)
	if len(closed) != 1 {
		t.Fatalf("limit_day_closed %d", len(closed))
	}
	cd := mustDecode[LimitDayClosedData](t, closed[0])
	if cd.LimitID != l.ID || cd.Day != "2026-09-28" || cd.UsedSeconds != 32*60 || !cd.Applied || !cd.Reached || closed[0].Day != "2026-09-29" {
		t.Fatalf("limit_day_closed %+v (day %s)", cd, closed[0].Day)
	}
	got = limGet(t, env, l.ID)
	if got.Day != "2026-09-29" || got.UsedTodaySeconds != 0 || got.ReachedAt != nil || got.ActiveBlockID != nil {
		t.Fatalf("after midnight %+v", got)
	}
	if len(env.fh.Domains()) != 0 {
		t.Fatalf("hosts after midnight %v", env.fh.Domains())
	}
	// A new allowance.
	limBrowse(t, env, "www.youtube.com", time.Minute)
	if got := limGet(t, env, l.ID); got.UsedTodaySeconds != 60 {
		t.Fatalf("new day usage %+v", got)
	}
}

// Usage is never trusted beyond real time: per-client and per-limit clamps (§10.13).
func TestLimitsUsageClamps(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	l := limCreate(t, env, limIn("YouTube", 60, "youtube"))
	yt := limDomain("www.youtube.com", 30)
	used := func() int64 { return limGet(t, env, l.ID).UsedTodaySeconds }

	// Time before the limit existed never counts: only the slack.
	if _, err := limReport(env, scopeExt, 30*time.Second, yt); err != nil {
		t.Fatal(err)
	}
	if u := used(); u != 2 {
		t.Fatalf("usage before creation counted: %d", u)
	}
	// Two clients reporting the same 30 s credit 30 s plus at most the slack.
	env.clk.Advance(30 * time.Second)
	env.e.Step()
	if _, err := limReport(env, scopeExt, 30*time.Second, yt); err != nil {
		t.Fatal(err)
	}
	before := used()
	if _, err := env.e.ReportUsage(bg, Request{Scope: scopeExt, ExtensionID: "ext_otherExtension000000"}, UsageReportRequest{IntervalMs: 30000, Items: []UsageItem{yt}}); err != nil {
		t.Fatal(err)
	}
	if d := used() - before; d > 2 {
		t.Fatalf("a second client added %d s for the same time", d)
	}
	// A report longer than the time since the client's previous one is clamped.
	env.clk.Advance(10 * time.Second)
	env.e.Step()
	before = used()
	res, err := limReport(env, scopeExt, 120*time.Second, limDomain("www.youtube.com", 120))
	if err != nil {
		t.Fatal(err)
	}
	if d := used() - before; d != 12 || limStatus(res, l.ID).CreditedSeconds != 12 {
		t.Fatalf("a 120 s report after 10 s added %d", d)
	}
	// An immediate replay credits at most the slack.
	before = used()
	if _, err := limReport(env, scopeExt, 30*time.Second, yt); err != nil {
		t.Fatal(err)
	}
	if d := used() - before; d > 2 {
		t.Fatalf("a replay added %d", d)
	}
	// Seconds of several matching hosts count once per limit, capped by the interval.
	env.clk.Advance(30 * time.Second)
	env.e.Step()
	before = used()
	if _, err := limReport(env, scopeExt, 30*time.Second, limDomain("www.youtube.com", 20), limDomain("m.youtube.com", 20)); err != nil {
		t.Fatal(err)
	}
	if d := used() - before; d != 30 {
		t.Fatalf("overlapping hosts added %d", d)
	}
	// A disabled limit counts nothing (disabling waits: use a new disabled limit).
	off := limIn("Off", 30, "youtube")
	off.Enabled = false
	lo := limCreate(t, env, off)
	env.clk.Advance(30 * time.Second)
	env.e.Step()
	res, err = limReport(env, scopeExt, 30*time.Second, yt)
	if err != nil {
		t.Fatal(err)
	}
	if got := limGet(t, env, lo.ID); got.UsedTodaySeconds != 0 || got.AppliesToday {
		t.Fatalf("disabled limit %+v", got)
	}
	if slices.ContainsFunc(res.Limits, func(s LimitUsageStatus) bool { return s.LimitID == lo.ID }) {
		t.Fatal("the usage response lists a disabled limit")
	}
	// Usage is counted on days the limit does not apply; it just does not block.
	in := limIn("Weekend", 5, "youtube")
	in.Days = []int{6, 7}
	wk := limCreate(t, env, in)
	limBrowse(t, env, "www.youtube.com", 6*time.Minute)
	got := limGet(t, env, wk.ID)
	if got.AppliesToday || got.UsedTodaySeconds < 5*60 || got.ReachedAt != nil || len(limBlocks(env.e, wk.ID)) != 0 {
		t.Fatalf("weekend limit on a Monday %+v", got)
	}
	// Adding today's weekday applies at once with the real usage.
	in = limInputOf(got)
	in.Days = []int{1, 6, 7}
	limUpdate(t, env, wk.ID, in)
	if bl := limBlocks(env.e, wk.ID); len(bl) != 1 || bl[0].Status != StatusActive {
		t.Fatalf("adding today did not reach the limit: %d blocks", len(bl))
	}
}

func TestLimitsUsageValidationAndScope(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	cases := []struct {
		name  string
		req   UsageReportRequest
		path  string
		issue string
	}{
		{"short interval", UsageReportRequest{IntervalMs: 999, Items: []UsageItem{}}, "intervalMs", "range"},
		{"long interval", UsageReportRequest{IntervalMs: 120001, Items: []UsageItem{}}, "intervalMs", "range"},
		{"bad type", UsageReportRequest{IntervalMs: 30000, Items: []UsageItem{{Type: "url", Value: "x", Seconds: 1}}}, "items[0].type", "enum"},
		{"bad domain", UsageReportRequest{IntervalMs: 30000, Items: []UsageItem{{Type: "domain", Value: "https://x.com/", Seconds: 1}}}, "items[0].value", "invalid_domain"},
		{"zero seconds", UsageReportRequest{IntervalMs: 30000, Items: []UsageItem{limDomain("x.com", 0)}}, "items[0].seconds", "range"},
		{"more than the interval", UsageReportRequest{IntervalMs: 10500, Items: []UsageItem{limDomain("x.com", 12)}}, "items[0].seconds", "rule"},
		{"duplicate", UsageReportRequest{IntervalMs: 30000, Items: []UsageItem{limDomain("x.com", 1), limDomain("x.com", 2)}}, "items[1]", "rule"},
	}
	many := UsageReportRequest{IntervalMs: 30000}
	for i := range limits().UsageMaxItems + 1 {
		many.Items = append(many.Items, limDomain(fmt.Sprintf("h%d.example.org", i), 1))
	}
	cases = append(cases, struct {
		name  string
		req   UsageReportRequest
		path  string
		issue string
	}{"too many items", many, "items", "length"})
	for _, c := range cases {
		_, err := e.ReportUsage(bg, Request{Scope: scopeExt, ExtensionID: limExt}, c.req)
		if d := apiDetails(err); apiCode(err) != "validation_failed" || d["path"] != c.path || d["issue"] != c.issue {
			t.Errorf("%s: %v %v", c.name, err, d)
		}
	}
	// 11 seconds fit a 10.5 s interval (ceil).
	if _, err := limReport(env, scopeExt, 10500*time.Millisecond, limDomain("x.com", 11)); err != nil {
		t.Fatalf("ceil of the interval: %v", err)
	}
	// Scope: the extension reports domains, the app processes.
	if _, err := limReport(env, scopeExt, 30*time.Second, UsageItem{Type: usageTypeProcess, Value: "chrome.exe", Seconds: 3}); apiCode(err) != "insufficient_scope" {
		t.Fatalf("ext process item: %v", err)
	}
	if _, err := limReport(env, scopeApp, 30*time.Second, limDomain("x.com", 3)); apiCode(err) != "insufficient_scope" {
		t.Fatalf("app domain item: %v", err)
	}
	if _, err := env.e.ReportUsage(bg, Request{}, UsageReportRequest{IntervalMs: 30000, Items: []UsageItem{}}); apiCode(err) != "insufficient_scope" {
		t.Fatalf("no scope: %v", err)
	}
	// An empty report is valid; protected process names are fine (usage of nothing).
	if _, err := limReport(env, scopeApp, 30*time.Second); err != nil {
		t.Fatal(err)
	}
	if _, err := limReport(env, scopeApp, 30*time.Second, UsageItem{Type: usageTypeProcess, Value: "explorer.exe", Seconds: 3}); err != nil {
		t.Fatal(err)
	}
	// Frozen mode refuses reports; safe mode accepts them.
	env.e.mode = ModeGuardianSafe
	if _, err := limReport(env, scopeApp, 30*time.Second); err != nil {
		t.Fatalf("safe mode refused a usage report: %v", err)
	}
	if _, err := e.CreateLimit(bg, Request{Scope: scopeApp}, limIn("x", 30, "youtube")); apiCode(err) != "read_only" {
		t.Fatalf("safe mode accepted a limit write: %v", err)
	}
	env.e.mode = ModeGuardianNormal
}

func TestLimitsProcessUsageFromTheApp(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	in := limIn("Juego", 5)
	in.Targets.CustomProcesses = []string{"mygame"}
	l := limCreate(t, env, in)
	// A 5-minute limit warns at creation (nothing left above the warning threshold).
	if w := env.eventsOf(EvLimitWarning); len(w) != 1 || mustDecode[LimitWarningData](t, w[0]).RemainingSeconds != 300 {
		t.Fatalf("5-minute limit warning %d", len(w))
	}
	for range 10 {
		env.clk.Advance(30 * time.Second)
		env.e.Step()
		if _, err := limReport(env, scopeApp, 30*time.Second, UsageItem{Type: usageTypeProcess, Value: "mygame", Seconds: 30}); err != nil {
			t.Fatal(err)
		}
	}
	bl := limBlocks(env.e, l.ID)
	if len(bl) != 1 || bl[0].Status != StatusActive {
		t.Fatalf("process limit blocks %d", len(bl))
	}
	if !slices.Contains(env.e.Matcher().Names(), "mygame") {
		t.Fatalf("process not enforced: %v", env.e.Matcher().Names())
	}
}

// Raising, removing, disabling and deleting wait 24 h and never touch the active limit
// block; strengthening applies at once (§5.10, §15).
func TestLimitsChangesAndPendingDelay(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	delay := msDuration(limDelayMs())
	l := limCreate(t, env, limIn("YouTube", 30, "youtube"))

	// Lowering applies at once.
	in := limInputOf(l)
	in.DailyMinutes = 20
	got := limUpdate(t, env, l.ID, in)
	if got.DailyMinutes != 20 || got.PendingChange != nil {
		t.Fatalf("lowering %+v", got)
	}
	// Raising waits; the rename applies at once.
	in.DailyMinutes = 45
	in.Name = "Vídeos"
	got = limUpdate(t, env, l.ID, in)
	if got.DailyMinutes != 20 || got.Name != "Vídeos" || got.PendingChange == nil || got.PendingChange.Definition == nil || got.PendingChange.Definition.DailyMinutes != 45 {
		t.Fatalf("raising %+v", got)
	}
	eff, _ := parseMs(got.PendingChange.EffectiveAt)
	if want := testStart.Add(delay).UnixMilli(); eff != want {
		t.Fatalf("effectiveAt %s, want %s", got.PendingChange.EffectiveAt, fmtMs(want))
	}
	nEvents := len(env.eventsOf(EvLimitUpdated))
	// A retry changes nothing (no event, the delay keeps running).
	schForward(env, time.Hour, 10*time.Minute)
	again := limUpdate(t, env, l.ID, in)
	if len(env.eventsOf(EvLimitUpdated)) != nEvents || again.PendingChange.EffectiveAt != got.PendingChange.EffectiveAt {
		t.Fatalf("a retry changed the pending change: %+v", again.PendingChange)
	}
	// A smaller raise keeps the delay; a larger one restarts it.
	in.DailyMinutes = 40
	smaller := limUpdate(t, env, l.ID, in)
	if smaller.PendingChange.EffectiveAt != got.PendingChange.EffectiveAt || smaller.PendingChange.Definition.DailyMinutes != 40 {
		t.Fatalf("a smaller raise restarted the delay: %+v", smaller.PendingChange)
	}
	in.DailyMinutes = 50
	larger := limUpdate(t, env, l.ID, in)
	if eff2, _ := parseMs(larger.PendingChange.EffectiveAt); eff2 != testStart.Add(time.Hour+delay).UnixMilli() {
		t.Fatalf("a larger raise kept the delay: %s", larger.PendingChange.EffectiveAt)
	}
	// Re-sending the effective definition cancels the pending change.
	cancelled := limUpdate(t, env, l.ID, limInputOf(larger))
	if cancelled.PendingChange != nil || cancelled.DailyMinutes != 20 {
		t.Fatalf("cancel %+v", cancelled)
	}
	// Adding a target and a stricter mode apply at once; removing the old target waits.
	in = limInputOf(cancelled)
	in.Targets.ServiceIDs = []string{"tiktok"}
	in.Mode = ModeHardcore
	in.AcknowledgeNoEmergency = true
	got = limUpdate(t, env, l.ID, in)
	if !slices.Equal(got.Targets.ServiceIDs, []string{"youtube", "tiktok"}) || got.Mode != ModeHardcore ||
		got.PendingChange == nil || !slices.Equal(got.PendingChange.Definition.Targets.ServiceIDs, []string{"tiktok"}) {
		t.Fatalf("replace target %+v", got)
	}
	// Disabling waits.
	in = limInputOf(got)
	in.Targets.ServiceIDs = []string{"tiktok"}
	in.Enabled = false
	got = limUpdate(t, env, l.ID, in)
	if !got.Enabled || got.PendingChange == nil || got.PendingChange.Definition.Enabled {
		t.Fatalf("disable %+v", got)
	}
	// After the delay and on a later day, the pending change applies.
	schForward(env, delay+10*time.Minute, 10*time.Minute)
	got = limGet(t, env, l.ID)
	if got.Enabled || got.PendingChange != nil || !slices.Equal(got.Targets.ServiceIDs, []string{"tiktok"}) {
		t.Fatalf("after the delay %+v", got)
	}
	ups := env.eventsOf(EvLimitUpdated)
	if d := mustDecode[LimitUpdatedData](t, ups[len(ups)-1]); d.Cause != "pending_applied" || d.Limit.PendingChange != nil {
		t.Fatalf("last limit_updated %+v", d)
	}

	// Deleting waits too; it is a pending deletion shown on the limit.
	res, err := env.e.DeleteLimit(bg, Request{Scope: scopeApp}, l.ID)
	if err != nil {
		t.Fatal(err)
	}
	if res.Limit.PendingChange == nil || res.Limit.PendingChange.Definition != nil {
		t.Fatalf("delete %+v", res.Limit)
	}
	n := len(env.eventsOf(EvLimitUpdated))
	if _, err := env.e.DeleteLimit(bg, Request{Scope: scopeApp}, l.ID); err != nil || len(env.eventsOf(EvLimitUpdated)) != n {
		t.Fatalf("a repeated delete wrote an event: %v", err)
	}
	// Re-sending the definition cancels the deletion.
	limUpdate(t, env, l.ID, limInputOf(res.Limit))
	if limGet(t, env, l.ID).PendingChange != nil {
		t.Fatal("the deletion was not cancelled")
	}
	if _, err := env.e.DeleteLimit(bg, Request{Scope: scopeApp}, l.ID); err != nil {
		t.Fatal(err)
	}
	schForward(env, delay+10*time.Minute, 10*time.Minute)
	if limHas(t, env, l.ID) || len(env.eventsOf(EvLimitDeleted)) != 1 {
		t.Fatal("the pending deletion did not apply")
	}
}

// A pending change never applies on the local day it was requested (a 25-hour day).
func TestLimitsPendingNeverOnTheRequestDay(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	l := limCreate(t, env, limIn("YouTube", 30, "youtube"))
	in := limInputOf(l)
	in.DailyMinutes = 60
	limUpdate(t, env, l.ID, in)
	// The delay ran out (as it could on a 25-hour day) but the day is the same.
	if err := env.e.exec(bg, func() { env.e.limit(l.ID).Pending.RemainingMs = 1000 }); err != nil {
		t.Fatal(err)
	}
	schForward(env, time.Minute, 10*time.Second)
	got := limGet(t, env, l.ID)
	if got.DailyMinutes != 30 || got.PendingChange == nil {
		t.Fatalf("applied on the request day %+v", got)
	}
	if eff, _ := parseMs(got.PendingChange.EffectiveAt); eff != limMidnight.UnixMilli() {
		t.Fatalf("effectiveAt %s, want the next midnight", got.PendingChange.EffectiveAt)
	}
	schForwardTo(env, limMidnight.Add(time.Minute), 10*time.Minute)
	if got := limGet(t, env, l.ID); got.DailyMinutes != 60 || got.PendingChange != nil {
		t.Fatalf("after midnight %+v", got)
	}
}

// FakeClock.Reboot + JumpWall never applies a pending weakening early (§15).
func TestLimitsPendingIgnoresClockAndOfflineReboots(t *testing.T) {
	delay := msDuration(limDelayMs())
	setup := func(t *testing.T) (*testEnv, DailyLimit) {
		env := newTestEnv(t)
		env.open()
		l := limCreate(t, env, limIn("YouTube", 30, "youtube"))
		if _, err := env.e.DeleteLimit(bg, Request{Scope: scopeApp}, l.ID); err != nil {
			t.Fatal(err)
		}
		schForward(env, time.Hour, 10*time.Minute)
		if err := env.e.Stop(); err != nil {
			t.Fatal(err)
		}
		return env, l
	}
	remaining := func(env *testEnv, id string) time.Duration {
		var ms int64
		_ = env.e.exec(bg, func() { ms = env.e.limit(id).Pending.RemainingMs })
		return msDuration(ms)
	}
	t.Run("bios jump and offline reboot", func(t *testing.T) {
		env, l := setup(t)
		env.net.SetOffline(true)
		env.clk.RebootAfter(0)
		env.clk.JumpWall(72 * time.Hour)
		env.open()
		schForward(env, 10*time.Minute, time.Minute)
		if !limHas(t, env, l.ID) {
			t.Fatal("a clock jump and an offline reboot applied the deletion early")
		}
		if r := remaining(env, l.ID); r < delay-time.Hour-11*time.Minute || r > delay-time.Hour-9*time.Minute {
			t.Fatalf("remaining %v", r)
		}
	})
	t.Run("verified downtime counts", func(t *testing.T) {
		env, l := setup(t)
		env.net.SetOffline(true)
		env.clk.RebootAfter(30 * time.Hour)
		env.open()
		schForward(env, 10*time.Minute, time.Minute)
		if !limHas(t, env, l.ID) {
			t.Fatal("unverified downtime applied the deletion")
		}
		env.net.SetOffline(false)
		schForward(env, 10*time.Minute, time.Minute)
		if limHas(t, env, l.ID) {
			t.Fatalf("verified downtime was not credited (remaining %v)", remaining(env, l.ID))
		}
	})
}

// A strengthening edit after reaching adds a block; an emergency is never re-triggered
// the same day; nothing ever ends the limit block early (§15).
func TestLimitsStrengtheningAfterReachAndEmergency(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	l := limCreate(t, env, limIn("YouTube", 5, "youtube"))
	limBrowse(t, env, "www.youtube.com", 5*time.Minute)
	bl := limBlocks(env.e, l.ID)
	if len(bl) != 1 {
		t.Fatalf("blocks %d", len(bl))
	}
	first := bl[0]
	// Neutral and weakening edits add nothing and leave the block alone.
	in := limInputOf(limGet(t, env, l.ID))
	in.Name = "Vídeos"
	in.DailyMinutes = 60
	limUpdate(t, env, l.ID, in)
	if len(limBlocks(env.e, l.ID)) != 1 || first.Status != StatusActive || first.EndsAt != limMidnight.UnixMilli() {
		t.Fatalf("a weakening edit touched the block: %+v", first)
	}
	// A new target: a further block with the full targets.
	in.DailyMinutes = 5
	in.Targets.ServiceIDs = []string{"youtube", "tiktok"}
	limUpdate(t, env, l.ID, in)
	bl = limBlocks(env.e, l.ID)
	if len(bl) != 2 || !slices.Equal(bl[1].Targets.ServiceIDs, []string{"youtube", "tiktok"}) || bl[1].Mode != ModeStrict {
		t.Fatalf("after adding a target: %d blocks", len(bl))
	}
	// A stricter mode: a hardcore block (and allowances would be revoked).
	in.Mode = ModeHardcore
	in.AcknowledgeNoEmergency = true
	limUpdate(t, env, l.ID, in)
	bl = limBlocks(env.e, l.ID)
	if len(bl) != 3 || bl[2].Mode != ModeHardcore {
		t.Fatalf("after a stricter mode: %d blocks", len(bl))
	}
	if env.e.rewardsLock() != ModeHardcore {
		t.Fatalf("rewards lock %q", env.e.rewardsLock())
	}
	if len(env.eventsOf(EvLimitReached)) != 1 {
		t.Fatal("limit_reached written twice")
	}
	// The emergency exit exists for the strict blocks; once cancelled they never return
	// that day.
	em := emgRequest(t, env, bl[0].ID, bl[1].ID)
	emgForward(env, emgCountdown(ModeStrict)+time.Second)
	if _, err := env.e.ConfirmEmergency(bg, Request{Scope: scopeApp}, em.ID, ConfirmEmergencyRequest{Acknowledge: true}); err != nil {
		t.Fatalf("ConfirmEmergency: %v", err)
	}
	if bl[0].Status != StatusCancelledEmergency || bl[1].Status != StatusCancelledEmergency || bl[2].Status != StatusActive {
		t.Fatalf("after the emergency: %s %s %s", bl[0].Status, bl[1].Status, bl[2].Status)
	}
	limBrowse(t, env, "www.youtube.com", 2*time.Minute)
	if n := len(limBlocks(env.e, l.ID)); n != 3 {
		t.Fatalf("the emergency was re-triggered: %d blocks", n)
	}
}

func TestLimitsLimitedBlocksPerDay(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	l := limCreate(t, env, limIn("A", 5, "youtube"))
	limBrowse(t, env, "www.youtube.com", 5*time.Minute)
	services := []string{"tiktok", "instagram", "reddit", "twitch", "netflix"}
	in := limInputOf(limGet(t, env, l.ID))
	for _, s := range services {
		in.Targets.ServiceIDs = append(in.Targets.ServiceIDs, s)
		limUpdate(t, env, l.ID, in)
	}
	if n := len(limBlocks(env.e, l.ID)); n != limits().LimitMaxBlocksPerDay {
		t.Fatalf("%d limit blocks, want %d", n, limits().LimitMaxBlocksPerDay)
	}
}

// Less than a minute before midnight, reaching the allowance blocks nothing.
func TestLimitsReachedJustBeforeMidnight(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	schForwardTo(env, limMidnight.Add(-10*time.Minute), 10*time.Minute)
	l := limCreate(t, env, limIn("YouTube", 5, "youtube"))
	limBrowse(t, env, "www.wikipedia.org", 4*time.Minute+30*time.Second)
	limBrowse(t, env, "www.youtube.com", 5*time.Minute)
	reached := env.eventsOf(EvLimitReached)
	if len(reached) != 1 {
		t.Fatalf("limit_reached %d", len(reached))
	}
	if d := mustDecode[LimitReachedData](t, reached[0]); d.BlockID != nil {
		t.Fatalf("a block %v was created %s before midnight", *d.BlockID, limMidnight.Sub(env.clk.Wall()))
	}
	if len(limBlocks(env.e, l.ID)) != 0 || len(env.fh.Domains()) != 0 {
		t.Fatal("blocked with less than a minute left")
	}
}

func TestLimitsExtensionSeesManualWithLimitID(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	x := pairExt(t, env, "chrome")
	l := limCreate(t, env, limIn("YouTube", 5, "youtube"))
	rules := xrDecode(t, xrGet(t, env, x, xrNonce))
	if len(rules.Limits) != 1 || rules.Limits[0].ID != l.ID || rules.Limits[0].Name != "YouTube" || !rules.Limits[0].AppliesToday ||
		rules.Limits[0].DailyMinutes != 5 || !slices.Contains(rules.Limits[0].Domains, "youtube.com") || !slices.Equal(rules.Limits[0].ServiceIDs, []string{"youtube"}) {
		t.Fatalf("rules.limits %+v", rules.Limits)
	}
	if len(rules.BlockDomains) != 0 {
		t.Fatalf("a limit being counted changed blockDomains: %v", rules.BlockDomains)
	}
	v := rules.ExtRulesVersion
	limBrowse(t, env, "www.youtube.com", 5*time.Minute)
	rules = xrDecode(t, xrGet(t, env, x, xrNonce))
	if rules.ExtRulesVersion <= v || len(rules.Blocks) != 1 {
		t.Fatalf("rules after reaching %+v", rules)
	}
	if b := rules.Blocks[0]; b.Kind != KindManual || b.LimitID == nil || *b.LimitID != l.ID {
		t.Fatalf("ext rule block %+v", b)
	}
	// Attempts: manual for the extension, limit for the app.
	a, err := env.e.ReportAttempt(bg, Request{Scope: scopeExt, ExtensionID: x.ExtensionID},
		AttemptRequest{Layer: LayerExtension, Target: AttemptTarget{Type: attemptTargetDomain, Value: "www.youtube.com"}, Browser: ptr("chrome")})
	if err != nil || a.Block == nil || a.Block.Kind != KindManual || a.Block.LimitID == nil || *a.Block.LimitID != l.ID || !a.Counted {
		t.Fatalf("ext attempt %+v %v", a, err)
	}
	a, err = env.e.ReportAttempt(bg, Request{Scope: scopeApp},
		AttemptRequest{Layer: LayerWindow, Target: AttemptTarget{Type: attemptTargetService, Value: "youtube"}})
	if err != nil || a.Block == nil || a.Block.Kind != KindLimit || a.Block.LimitID == nil {
		t.Fatalf("app attempt %+v %v", a, err)
	}
	// The day rollover bumps the rules version.
	v = rules.ExtRulesVersion
	schForwardTo(env, limMidnight.Add(time.Minute), 10*time.Minute)
	if rules = xrDecode(t, xrGet(t, env, x, xrNonce)); rules.ExtRulesVersion <= v || len(rules.Blocks) != 0 {
		t.Fatalf("rules after midnight %+v", rules)
	}
}

// Data deletion keeps every limit, its pending change and today's usage; a reached limit
// stays materialized (§10.11, §15).
func TestLimitsSurviveDataDeletion(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	a := limCreate(t, env, limIn("YouTube", 5, "youtube"))
	b := limCreate(t, env, limIn("TikTok", 30, "tiktok"))
	limBrowse(t, env, "www.youtube.com", 6*time.Minute)
	limBrowse(t, env, "www.tiktok.com", 10*time.Minute)
	in := limInputOf(limGet(t, env, b.ID))
	in.DailyMinutes = 60
	pend := limUpdate(t, env, b.ID, in)
	res, err := env.e.DeleteData(bg, Request{Scope: scopeApp}, DeleteDataRequest{Confirm: "BORRAR"})
	if err != nil {
		t.Fatalf("DeleteData: %v", err)
	}
	if !slices.Equal(res.KeptLimitIDs, []string{a.ID, b.ID}) {
		t.Fatalf("keptLimitIds %v", res.KeptLimitIDs)
	}
	ga, gb := limGet(t, env, a.ID), limGet(t, env, b.ID)
	if ga.ReachedAt == nil || ga.ActiveBlockID == nil || gb.UsedTodaySeconds != 600 || gb.PendingChange == nil ||
		gb.PendingChange.EffectiveAt != pend.PendingChange.EffectiveAt || gb.DailyMinutes != 30 {
		t.Fatalf("after deletion %+v\n%+v", ga, gb)
	}
	ep := env.eventsOf(EvEpochStarted)
	if k := mustDecode[EpochStartedData](t, ep[len(ep)-1]).Kept; len(k.Limits) != 2 {
		t.Fatalf("kept.limits %d", len(k.Limits))
	}
	// Still materialized: no second block, no second limit_reached in the new epoch.
	limBrowse(t, env, "www.youtube.com", time.Minute)
	if n := len(env.eventsOf(EvLimitReached)); n != 0 {
		t.Fatalf("limit_reached after deletion %d", n)
	}
	// The usage keeps counting from where it was.
	limBrowse(t, env, "www.tiktok.com", time.Minute)
	if got := limGet(t, env, b.ID); got.UsedTodaySeconds != 660 {
		t.Fatalf("usage after deletion %d", got.UsedTodaySeconds)
	}
}

// Usage survives restarts (state.json) and, without state files, today's usage comes
// back from the log: the largest usedSeconds of today's warnings and reached events.
func TestLimitsPersistenceAndRebuild(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	a := limCreate(t, env, limIn("YouTube", 10, "youtube"))
	b := limCreate(t, env, limIn("TikTok", 30, "tiktok"))
	limBrowse(t, env, "www.youtube.com", 10*time.Minute)
	limBrowse(t, env, "www.tiktok.com", 7*time.Minute)
	in := limInputOf(limGet(t, env, b.ID))
	in.DailyMinutes = 45
	limUpdate(t, env, b.ID, in)
	env.clk.ServiceRestart(time.Second)
	env.restart()
	if got := limGet(t, env, b.ID); got.UsedTodaySeconds != 420 || got.PendingChange == nil {
		t.Fatalf("after restart %+v", got)
	}
	if got := limGet(t, env, a.ID); got.ReachedAt == nil || got.ActiveBlockID == nil {
		t.Fatalf("after restart %+v", got)
	}
	if err := env.e.Stop(); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"state.json", "state.prev.json"} {
		_ = os.Remove(filepath.Join(env.dir, n))
	}
	env.clk.ServiceRestart(time.Second)
	env.open()
	ga, gb := limGet(t, env, a.ID), limGet(t, env, b.ID)
	if ga.ReachedAt == nil || ga.UsedTodaySeconds != 600 || ga.ActiveBlockID == nil {
		t.Fatalf("rebuilt reached limit %+v", ga)
	}
	if gb.UsedTodaySeconds != 0 || gb.PendingChange == nil || gb.PendingChange.Definition.DailyMinutes != 45 {
		t.Fatalf("rebuilt limit %+v", gb)
	}
	// Rebuilt: still materialized today.
	limBrowse(t, env, "www.youtube.com", time.Minute)
	if n := len(limBlocks(env.e, a.ID)); n != 1 {
		t.Fatalf("rebuilt limit blocks %d", n)
	}
}

// The day rollover also runs at startup for a record of a past day.
func TestLimitsRolloverAtStartup(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	l := limCreate(t, env, limIn("YouTube", 30, "youtube"))
	limBrowse(t, env, "www.youtube.com", 3*time.Minute)
	if err := env.e.Stop(); err != nil {
		t.Fatal(err)
	}
	env.clk.RebootAfter(24 * time.Hour)
	env.open()
	closed := env.eventsOf(EvLimitDayClosed)
	if len(closed) != 1 {
		t.Fatalf("limit_day_closed %d", len(closed))
	}
	if d := mustDecode[LimitDayClosedData](t, closed[0]); d.Day != "2026-09-28" || d.UsedSeconds != 180 || d.Reached {
		t.Fatalf("limit_day_closed %+v", d)
	}
	if got := limGet(t, env, l.ID); got.UsedTodaySeconds != 0 || got.Day != "2026-09-29" {
		t.Fatalf("after the reboot %+v", got)
	}
}

// A wall-clock jump neither ends the limit block nor moves its trusted end.
func TestLimitsClockJump(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	l := limCreate(t, env, limIn("YouTube", 5, "youtube"))
	limBrowse(t, env, "www.youtube.com", 5*time.Minute)
	env.clk.JumpWall(12 * time.Hour)
	schForward(env, time.Minute, 10*time.Second)
	bl := limBlocks(env.e, l.ID)
	if len(bl) != 1 || bl[0].Status != StatusActive || bl[0].EndsAt != limMidnight.UnixMilli() {
		t.Fatalf("after a jump %+v", bl)
	}
	if n := len(env.eventsOf(EvLimitDayClosed)); n != 0 {
		t.Fatalf("a wall jump closed the day: %d", n)
	}
}

// The limit events keep the store's time basis: trusted times, the envelope day.
func TestLimitEventsAreTrusted(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	env.clk.JumpWall(3 * time.Hour)
	env.e.Step()
	limCreate(t, env, limIn("YouTube", 30, "youtube"))
	var ev store.Event
	for _, x := range env.events() {
		if x.Type == EvLimitCreated {
			ev = x
		}
	}
	d := mustDecode[LimitCreatedData](t, ev)
	if d.Limit.CreatedAt != ev.At || ev.WallOffsetMs != (3*time.Hour).Milliseconds() {
		t.Fatalf("event createdAt %s at %s (offset %d)", d.Limit.CreatedAt, ev.At, ev.WallOffsetMs)
	}
	if st := env.state(); st.Limits[0].CreatedAt == ev.At {
		t.Fatal("the API answered trusted time")
	}
}

// A limit block created while the trusted clock ran ahead moves back with the
// calibration like every block; its (limit, day) stays materialized, and usage credited
// ahead of the corrected clock only delays new credit (never counts twice, §10.2).
func TestLimitsCalibrationShift(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	l := limCreate(t, env, limIn("YouTube", 5, "youtube"))
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	env.net.SetOffline(true)
	env.clk.RebootAfter(5 * time.Minute)
	env.clk.JumpWall(3 * time.Hour)
	e = env.open()
	limBrowse(t, env, "www.youtube.com", 5*time.Minute)
	bl := limBlocks(e, l.ID)
	if len(bl) != 1 || bl[0].EndsAt != limMidnight.UnixMilli() {
		t.Fatalf("limit block while the clock ran ahead: %+v", bl)
	}
	used := limGet(t, env, l.ID).UsedTodaySeconds
	env.net.SetOffline(false)
	schForward(env, 5*time.Minute, 10*time.Second)
	if e.trust() != TrustVerified {
		t.Fatal("no calibration")
	}
	bl = limBlocks(e, l.ID)
	if len(bl) != 1 || bl[0].Status != StatusActive || bl[0].EndsAt >= limMidnight.UnixMilli()-2*3600*1000 {
		t.Fatalf("limit block after the correction: %d blocks, ends %s", len(bl), fmtMs(bl[0].EndsAt))
	}
	limBrowse(t, env, "www.youtube.com", 2*time.Minute)
	if n := len(limBlocks(e, l.ID)); n != 1 || len(env.eventsOf(EvLimitReached)) != 1 {
		t.Fatalf("re-materialized after the correction: %d blocks", n)
	}
	if got := limGet(t, env, l.ID).UsedTodaySeconds; got != used {
		t.Fatalf("usage credited again after the clock moved back: %d → %d", used, got)
	}
}
