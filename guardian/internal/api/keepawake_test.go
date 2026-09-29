package api

import (
	"net/http"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

// Keep-awake through the HTTP layer (docs/ARCHITECTURE.md §8.8 «Keep awake»): strict
// decoding, the duration error details, the app scope, safe mode and the state ETag.

func kaBody(on bool, minutes any, display bool) map[string]any {
	return map[string]any{"on": on, "durationMinutes": minutes, "display": display}
}

func TestKeepAwakeRoutes(t *testing.T) {
	env := newTestEnv(t)

	r := env.do("GET", "/v1/keep-awake", nil, env.app())
	expect(t, r, http.StatusOK, "")
	var got engine.KeepAwakeResponse
	r.decode(t, &got)
	if got.KeepAwake.On || !got.KeepAwake.Display || got.KeepAwake.DurationMinutes != nil || got.KeepAwake.Error != nil {
		t.Fatalf("fresh %+v", got.KeepAwake)
	}
	stateTag := env.do("GET", "/v1/state", nil, env.app()).header.Get("ETag")

	// Turn on for 60 min: 200 with the state, the inhibitor holds, the state ETag moves.
	r = env.do("PUT", "/v1/keep-awake", kaBody(true, 60, true), env.app())
	expect(t, r, http.StatusOK, "")
	r.decode(t, &got)
	if !got.KeepAwake.On || !got.KeepAwake.Active || got.KeepAwake.Since == nil || got.KeepAwake.Until == nil || !env.inh.Held() {
		t.Fatalf("on %+v", got.KeepAwake)
	}
	until := *got.KeepAwake.Until
	expect(t, env.do("GET", "/v1/state", nil, env.app(), withHeader("If-None-Match", stateTag)), http.StatusOK, "")
	// The same body again: 200, same until (no Idempotency-Key needed).
	r = env.do("PUT", "/v1/keep-awake", kaBody(true, 60.0, true), env.app())
	expect(t, r, http.StatusOK, "")
	r.decode(t, &got)
	if got.KeepAwake.Until == nil || *got.KeepAwake.Until != until {
		t.Fatalf("retry moved until %+v", got.KeepAwake)
	}
	var st engine.GuardianStateResponse
	env.do("GET", "/v1/state", nil, env.app()).decode(t, &st)
	if st.KeepAwake == nil || !st.KeepAwake.On || st.KeepAwake.Until == nil || *st.KeepAwake.Until != until {
		t.Fatalf("state.keepAwake %+v", st.KeepAwake)
	}

	// Strict decoding.
	bad := kaBody(true, 60, true)
	bad["until"] = "2026-09-28T12:00:00.000Z"
	expect(t, env.do("PUT", "/v1/keep-awake", bad, env.app()), http.StatusBadRequest, "unknown_field")
	bad = kaBody(true, 60, true)
	delete(bad, "display")
	r = env.do("PUT", "/v1/keep-awake", bad, env.app())
	expect(t, r, http.StatusUnprocessableEntity, "validation_failed")
	if d := r.errDetails(); d["path"] != "display" || d["issue"] != "required" {
		t.Fatalf("missing display %v", d)
	}
	expect(t, env.do("PUT", "/v1/keep-awake", kaBody(true, 60.5, true), env.app()), http.StatusUnprocessableEntity, "validation_failed")
	expect(t, env.do("PUT", "/v1/keep-awake", kaBody(true, "60", true), env.app()), http.StatusUnprocessableEntity, "validation_failed")
	expect(t, env.do("PUT", "/v1/keep-awake", map[string]any{"on": "yes", "durationMinutes": nil, "display": true}, env.app()), http.StatusUnprocessableEntity, "validation_failed")
	expect(t, env.do("PUT", "/v1/keep-awake", "[]", env.app()), http.StatusUnprocessableEntity, "validation_failed")
	expect(t, env.do("PUT", "/v1/keep-awake", `{"on":true,"on":false,"durationMinutes":null,"display":true}`, env.app()), http.StatusBadRequest, "invalid_json")
	for _, m := range []int{4, 1441} {
		r = env.do("PUT", "/v1/keep-awake", kaBody(true, m, true), env.app())
		expect(t, r, http.StatusUnprocessableEntity, "duration_out_of_range")
		if d := r.errDetails(); d["minMinutes"] != float64(5) || d["maxMinutes"] != float64(1440) {
			t.Fatalf("%d minutes: details %v", m, d)
		}
	}
	// Nothing of the refused requests was applied.
	env.do("GET", "/v1/keep-awake", nil, env.app()).decode(t, &got)
	if got.KeepAwake.Until == nil || *got.KeepAwake.Until != until {
		t.Fatalf("a refused request changed it %+v", got.KeepAwake)
	}

	// Turn off.
	r = env.do("PUT", "/v1/keep-awake", kaBody(false, 60, true), env.app())
	expect(t, r, http.StatusOK, "")
	r.decode(t, &got)
	if got.KeepAwake.On || got.KeepAwake.Since != nil || env.inh.Held() {
		t.Fatalf("off %+v", got.KeepAwake)
	}

	// App token only.
	x := env.pair(pinnedOrigin)
	expect(t, env.do("GET", "/v1/keep-awake", nil, withToken(x.token), withOrigin(pinnedOrigin)), http.StatusForbidden, "insufficient_scope")
	expect(t, env.do("PUT", "/v1/keep-awake", kaBody(true, nil, true), withToken(x.token), withOrigin(pinnedOrigin)), http.StatusForbidden, "insufficient_scope")
	expect(t, env.do("PUT", "/v1/keep-awake", kaBody(true, nil, true)), http.StatusUnauthorized, "unauthorized")
	expect(t, env.do("POST", "/v1/keep-awake", kaBody(true, nil, true), env.app()), http.StatusMethodNotAllowed, "method_not_allowed")
}

// Safe mode (cached by the server) does not refuse keep-awake: the user must always be
// able to turn it off. Frozen mode does.
func TestKeepAwakeModes(t *testing.T) {
	env := newTestEnv(t)
	safe := engine.ModeGuardianSafe
	env.srv.mode.Store(&safe)
	expect(t, env.do("PUT", "/v1/settings", "{}", env.app()), http.StatusServiceUnavailable, codeReadOnly)
	expect(t, env.do("PUT", "/v1/keep-awake", kaBody(true, 30, true), env.app()), http.StatusOK, "")
	frozen := engine.ModeGuardianFrozen
	env.srv.mode.Store(&frozen)
	// The route is no write for the pipeline; the engine turn decides (normal here).
	expect(t, env.do("PUT", "/v1/keep-awake", kaBody(false, 30, true), env.app()), http.StatusOK, "")
}
