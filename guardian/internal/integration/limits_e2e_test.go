package integration

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

// TestDailyLimitEndToEnd walks «YouTube máximo 10 minutos al día» through the real HTTP
// API (docs/ARCHITECTURE.md §5.10, §10.13): the app creates the limit, the paired
// extension reports its usage, the guardian warns, then blocks YouTube in the hosts file
// until local midnight (Europe/Madrid, 22:00 UTC), survives a restart, refuses to end the
// block early through a weakening edit or a deletion, and gives a fresh allowance the
// next day.
func TestDailyLimitEndToEnd(t *testing.T) {
	clk := engine.NewFakeClock(testStart)
	sys := newSystem(t, clk)
	sys.start()

	var health engine.HealthResponse
	sys.call(req{method: "GET", path: "/v1/health"}, http.StatusOK, &health)
	if !slices.Contains(health.Capabilities, "daily_limits") {
		t.Fatalf("capabilities %v", health.Capabilities)
	}

	// 1. The app creates the limit.
	limitBody := map[string]any{
		"name": "YouTube", "enabled": true,
		"targets": map[string]any{
			"serviceIds": []string{"youtube"}, "categoryIds": []string{}, "appIds": []string{},
			"customDomains": []string{}, "customProcesses": []string{},
		},
		"dailyMinutes": 10, "days": []int{1, 2, 3, 4, 5, 6, 7}, "mode": "strict",
		"reason": "Aprobar el examen de mates", "acknowledgeNoEmergency": false,
	}
	var created engine.LimitResponse
	sys.call(req{method: "POST", path: "/v1/limits", body: limitBody, token: sys.token, idemKey: "e2e-limit-1"}, http.StatusCreated, &created)
	id := created.Limit.ID
	if !strings.HasPrefix(id, "lim_") || !created.Limit.AppliesToday || created.Limit.RemainingTodaySeconds != 600 {
		t.Fatalf("created %+v", created.Limit)
	}

	// 2. The extension pairs and reads the limits from its signed rules.
	var code engine.PairingCodeResponse
	sys.call(req{method: "POST", path: "/v1/pairing/code", body: map[string]any{}, token: sys.token}, http.StatusCreated, &code)
	var claim engine.PairingClaimResponse
	sys.call(req{method: "POST", path: "/v1/pairing/claim", origin: pinnedOrigin, body: map[string]any{
		"code": code.Code, "browser": "chrome", "browserVersion": "131.0.6778.86", "extVersion": "0.1.0",
	}}, http.StatusCreated, &claim)
	ext := func(q req) req { q.token, q.origin = claim.Token, pinnedOrigin; return q }
	rules := func() engine.ExtRulesResponse {
		t.Helper()
		var r engine.ExtRulesResponse
		sys.call(ext(req{method: "GET", path: "/v1/ext/rules?nonce=q3Jd0W3y8kqj3n7mW2Wm8A"}), http.StatusOK, &r)
		return r
	}
	r := rules()
	if len(r.Limits) != 1 || r.Limits[0].ID != id || !slices.Contains(r.Limits[0].Domains, "youtube.com") || len(r.BlockDomains) != 0 {
		t.Fatalf("rules.limits %+v, blockDomains %v", r.Limits, r.BlockDomains)
	}

	// 3. Ten minutes of YouTube, reported every minute by the extension (fewer requests
	//    than the extension token's burst: the rate limiter runs on real time).
	usage := map[string]any{"intervalMs": 60000, "items": []map[string]any{{"type": "domain", "value": "www.youtube.com", "seconds": 60}}}
	var last engine.UsageReportResponse
	for range 10 {
		sys.advance(time.Minute)
		sys.call(ext(req{method: "POST", path: "/v1/usage", body: usage}), http.StatusOK, &last)
	}
	if len(last.Limits) != 1 || last.Limits[0].UsedTodaySeconds != 600 || last.Limits[0].BlockedUntil == nil {
		t.Fatalf("last usage response %+v", last)
	}
	midnight := time.Date(2026, 9, 28, 22, 0, 0, 0, time.UTC)
	if until := parseTime(t, *last.Limits[0].BlockedUntil); !until.Equal(midnight) {
		t.Fatalf("blocked until %s, want %s", until, midnight)
	}
	evs := sys.events()
	if len(eventsOf(evs, engine.EvLimitWarning)) != 1 || len(eventsOf(evs, engine.EvLimitReached)) != 1 {
		t.Fatalf("warnings %d, reached %d", len(eventsOf(evs, engine.EvLimitWarning)), len(eventsOf(evs, engine.EvLimitReached)))
	}
	if !hasLine(sys.hostsFile(), "0.0.0.0 youtube.com") {
		t.Fatalf("hosts file lacks youtube.com:\n%s", sys.hostsFile())
	}
	// The app sees a limit block; the extension a manual one with limitId.
	var st engine.GuardianStateResponse
	sys.call(req{method: "GET", path: "/v1/state", token: sys.token}, http.StatusOK, &st)
	if len(st.Blocks) != 1 || st.Blocks[0].Kind != engine.KindLimit || st.Blocks[0].LimitID == nil || *st.Blocks[0].LimitID != id {
		t.Fatalf("state blocks %+v", st.Blocks)
	}
	if len(st.Limits) != 1 || st.Limits[0].ReachedAt == nil || st.Limits[0].ActiveBlockID == nil {
		t.Fatalf("state limits %+v", st.Limits)
	}
	r = rules()
	if len(r.Blocks) != 1 || r.Blocks[0].Kind != engine.KindManual || r.Blocks[0].LimitID == nil || *r.Blocks[0].LimitID != id {
		t.Fatalf("rules blocks %+v", r.Blocks)
	}
	var attempt engine.AttemptResponse
	sys.call(ext(req{method: "POST", path: "/v1/attempts", body: map[string]any{
		"layer": "extension", "target": map[string]any{"type": "domain", "value": "www.youtube.com"},
		"browser": "chrome", "incognito": false,
	}}), http.StatusOK, &attempt)
	if !attempt.Counted || attempt.Block == nil || attempt.Block.Kind != engine.KindManual || attempt.Block.LimitID == nil {
		t.Fatalf("attempt %+v", attempt)
	}

	// 4. A restart keeps the limit, its usage and its block.
	sys.stop()
	clk.ServiceRestart(5 * time.Second)
	sys.start()
	var list engine.ListLimitsResponse
	sys.call(req{method: "GET", path: "/v1/limits", token: sys.token}, http.StatusOK, &list)
	if len(list.Limits) != 1 || list.Limits[0].UsedTodaySeconds != 600 || list.Limits[0].ActiveBlockID == nil {
		t.Fatalf("after restart %+v", list.Limits)
	}

	// 5. Raising the allowance or deleting the limit waits 24 h and leaves the block.
	limitBody["dailyMinutes"] = 120
	var updated engine.LimitResponse
	sys.call(req{method: "PUT", path: "/v1/limits/" + id, body: limitBody, token: sys.token}, http.StatusOK, &updated)
	if updated.Limit.DailyMinutes != 10 || updated.Limit.PendingChange == nil {
		t.Fatalf("raise %+v", updated.Limit)
	}
	var deleted engine.LimitResponse
	sys.call(req{method: "DELETE", path: "/v1/limits/" + id, token: sys.token}, http.StatusOK, &deleted)
	if deleted.Limit.PendingChange == nil || deleted.Limit.PendingChange.Definition != nil {
		t.Fatalf("delete %+v", deleted.Limit)
	}
	if !hasLine(sys.hostsFile(), "0.0.0.0 youtube.com") {
		t.Fatal("an edit ended the limit block")
	}

	// 6. Local midnight: the block ends without points and the day is closed.
	sys.advance(midnight.Add(time.Minute).Sub(clk.Wall()))
	if got := sys.hostsFile(); got != userHosts {
		t.Fatalf("hosts file after midnight %q", got)
	}
	evs = sys.events()
	closed := eventsOf(evs, engine.EvLimitDayClosed)
	if len(closed) != 1 {
		t.Fatalf("limit_day_closed %d", len(closed))
	}
	var cd engine.LimitDayClosedData
	if err := json.Unmarshal(closed[0].Data, &cd); err != nil {
		t.Fatal(err)
	}
	if cd.LimitID != id || cd.UsedSeconds != 600 || !cd.Reached || cd.Day != "2026-09-28" {
		t.Fatalf("limit_day_closed %+v", cd)
	}
	for _, ev := range eventsOf(evs, engine.EvBlockCompleted) {
		if ev.Points != 0 {
			t.Fatalf("a limit block earned %d", ev.Points)
		}
	}
	sys.call(req{method: "GET", path: "/v1/limits", token: sys.token}, http.StatusOK, &list)
	if len(list.Limits) != 1 || list.Limits[0].UsedTodaySeconds != 0 || list.Limits[0].Day != "2026-09-29" || list.Limits[0].PendingChange == nil {
		t.Fatalf("next day %+v", list.Limits)
	}

	// Neither the reports nor the limit leak domains into the logs.
	if strings.Contains(sys.logs.String(), "youtube.com") {
		t.Fatal("the logs contain a limited domain")
	}
	sys.stop()
}
