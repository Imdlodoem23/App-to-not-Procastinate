package api

import (
	"net/http"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

// Daily limits through the HTTP layer (docs/ARCHITECTURE.md §8.8 «Daily limits», «POST
// /v1/usage»): strict decoding, statuses, scopes, idempotency and safe mode.

// limitBody is a valid DailyLimitInput.
func limitBody(minutes int) map[string]any {
	return map[string]any{
		"name":    "YouTube",
		"enabled": true,
		"targets": map[string]any{
			"serviceIds": []string{"youtube"}, "categoryIds": []string{}, "appIds": []string{},
			"customDomains": []string{}, "customProcesses": []string{},
		},
		"dailyMinutes":           minutes,
		"days":                   []int{1, 2, 3, 4, 5, 6, 7},
		"mode":                   "strict",
		"reason":                 "",
		"acknowledgeNoEmergency": false,
	}
}

func TestLimitsRoutes(t *testing.T) {
	env := newTestEnv(t)

	// Create (idempotent, 201) and replay.
	r := env.do("POST", "/v1/limits", limitBody(30), env.app(), withHeader("Idempotency-Key", "lim-1"))
	expect(t, r, http.StatusCreated, "")
	var created engine.LimitResponse
	r.decode(t, &created)
	if created.Limit.Name != "YouTube" || created.Limit.DailyMinutes != 30 || created.Limit.RemainingTodaySeconds != 1800 {
		t.Fatalf("created %+v", created.Limit)
	}
	r2 := env.do("POST", "/v1/limits", limitBody(30), env.app(), withHeader("Idempotency-Key", "lim-1"))
	expect(t, r2, http.StatusCreated, "")
	if r2.header.Get("Idempotent-Replayed") != "true" || string(r2.body) != string(r.body) {
		t.Fatalf("replay %s %s", r2.header, r2.body)
	}
	id := created.Limit.ID

	// List.
	r = env.do("GET", "/v1/limits", nil, env.app())
	expect(t, r, http.StatusOK, "")
	var list engine.ListLimitsResponse
	r.decode(t, &list)
	if len(list.Limits) != 1 || list.Limits[0].ID != id {
		t.Fatalf("list %+v", list)
	}

	// Strict decoding: unknown fields, missing fields and wrong types.
	bad := limitBody(30)
	bad["whitelistOnly"] = false
	expect(t, env.do("POST", "/v1/limits", bad, env.app()), http.StatusBadRequest, "unknown_field")
	bad = limitBody(30)
	delete(bad, "days")
	r = env.do("POST", "/v1/limits", bad, env.app())
	expect(t, r, http.StatusUnprocessableEntity, "validation_failed")
	if d := r.errDetails(); d["path"] != "days" || d["issue"] != "required" {
		t.Fatalf("missing days %v", d)
	}
	bad = limitBody(30)
	bad["dailyMinutes"] = "30"
	expect(t, env.do("POST", "/v1/limits", bad, env.app()), http.StatusUnprocessableEntity, "validation_failed")
	r = env.do("POST", "/v1/limits", limitBody(2), env.app())
	expect(t, r, http.StatusUnprocessableEntity, "validation_failed")
	if d := r.errDetails(); d["path"] != "dailyMinutes" || d["issue"] != "range" {
		t.Fatalf("range %v", d)
	}
	hard := limitBody(30)
	hard["mode"] = "hardcore"
	expect(t, env.do("POST", "/v1/limits", hard, env.app()), http.StatusUnprocessableEntity, "confirmation_required")

	// Update: raising waits (200 with the pending change); unknown id → 404.
	up := limitBody(45)
	r = env.do("PUT", "/v1/limits/"+id, up, env.app())
	expect(t, r, http.StatusOK, "")
	var updated engine.LimitResponse
	r.decode(t, &updated)
	if updated.Limit.DailyMinutes != 30 || updated.Limit.PendingChange == nil || updated.Limit.PendingChange.Definition.DailyMinutes != 45 {
		t.Fatalf("updated %+v", updated.Limit)
	}
	expect(t, env.do("PUT", "/v1/limits/lim_0000000000000000000000", up, env.app()), http.StatusNotFound, "not_found")

	// Delete: 200 with a pending deletion, nothing deleted.
	r = env.do("DELETE", "/v1/limits/"+id, nil, env.app())
	expect(t, r, http.StatusOK, "")
	var deleted engine.LimitResponse
	r.decode(t, &deleted)
	if deleted.Limit.PendingChange == nil || deleted.Limit.PendingChange.Definition != nil {
		t.Fatalf("deleted %+v", deleted.Limit)
	}
	expect(t, env.do("DELETE", "/v1/limits/lim_0000000000000000000000", nil, env.app()), http.StatusNotFound, "not_found")
	expect(t, env.do("GET", "/v1/limits", nil, env.app()), http.StatusOK, "")

	// The extension token cannot manage limits.
	x := env.pair(pinnedOrigin)
	expect(t, env.do("GET", "/v1/limits", nil, withToken(x.token), withOrigin(pinnedOrigin)), http.StatusForbidden, "insufficient_scope")
	// Without a token: 401.
	expect(t, env.do("GET", "/v1/limits", nil), http.StatusUnauthorized, "unauthorized")
}

func TestUsageRoute(t *testing.T) {
	env := newTestEnv(t)
	r := env.do("POST", "/v1/limits", limitBody(30), env.app())
	expect(t, r, http.StatusCreated, "")
	var created engine.LimitResponse
	r.decode(t, &created)

	appReport := map[string]any{"intervalMs": 30000, "items": []map[string]any{{"type": "process", "value": "chrome.exe", "seconds": 30}}}
	r = env.do("POST", "/v1/usage", appReport, env.app())
	expect(t, r, http.StatusOK, "")
	var res engine.UsageReportResponse
	r.decode(t, &res)
	if res.Day == "" || len(res.Limits) != 1 || res.Limits[0].LimitID != created.Limit.ID || res.ServerNow == "" {
		t.Fatalf("usage response %+v", res)
	}
	// Scopes: the app reports processes, the extension domains.
	domainReport := map[string]any{"intervalMs": 30000, "items": []map[string]any{{"type": "domain", "value": "www.youtube.com", "seconds": 30}}}
	expect(t, env.do("POST", "/v1/usage", domainReport, env.app()), http.StatusForbidden, "insufficient_scope")
	x := env.pair(pinnedOrigin)
	ext := []reqOpt{withToken(x.token), withOrigin(pinnedOrigin)}
	r = env.do("POST", "/v1/usage", domainReport, ext...)
	expect(t, r, http.StatusOK, "")
	expect(t, env.do("POST", "/v1/usage", appReport, ext...), http.StatusForbidden, "insufficient_scope")
	// Strict shape.
	expect(t, env.do("POST", "/v1/usage", map[string]any{"intervalMs": 30000, "items": []any{}, "extra": 1}, ext...), http.StatusBadRequest, "unknown_field")
	r = env.do("POST", "/v1/usage", map[string]any{"intervalMs": 30000, "items": []map[string]any{{"type": "domain", "value": "www.youtube.com", "seconds": "30"}}}, ext...)
	expect(t, r, http.StatusUnprocessableEntity, "validation_failed")
	if d := r.errDetails(); d["path"] != "items[0].seconds" || d["issue"] != "type" {
		t.Fatalf("details %v", d)
	}
	r = env.do("POST", "/v1/usage", map[string]any{"intervalMs": 5000, "items": []map[string]any{{"type": "domain", "value": "www.youtube.com", "seconds": 30}}}, ext...)
	expect(t, r, http.StatusUnprocessableEntity, "validation_failed")
	if d := r.errDetails(); d["path"] != "items[0].seconds" || d["issue"] != "rule" {
		t.Fatalf("details %v", d)
	}
	// Safe mode refuses limit writes but accepts usage reports (§8.3 step 6).
	safe := engine.ModeGuardianSafe
	env.srv.mode.Store(&safe)
	expect(t, env.do("POST", "/v1/limits", limitBody(30), env.app()), http.StatusServiceUnavailable, codeReadOnly)
	expect(t, env.do("POST", "/v1/usage", appReport, env.app()), http.StatusOK, "")
}
