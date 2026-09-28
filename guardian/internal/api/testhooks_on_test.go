//go:build testhooks

package api

import (
	"net/http"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

func TestTestClockRouteInTesthooksBuilds(t *testing.T) {
	env := newTestEnv(t)
	body := map[string]any{"advanceMs": 60000, "suspendMs": nil, "jumpMs": nil, "reboot": false}
	expect(t, env.do("POST", "/v1/_test/clock", body), http.StatusUnauthorized, codeUnauthorized)
	r := env.do("POST", "/v1/_test/clock", body, env.app())
	expect(t, r, http.StatusOK, "")
	var res engine.TestClockResponse
	r.decode(t, &res)
	if res.ServerNow != "2026-09-28T10:01:00.000Z" {
		t.Fatalf("serverNow = %q", res.ServerNow)
	}
	// Shape: every field is required.
	expect(t, env.do("POST", "/v1/_test/clock", map[string]any{"advanceMs": 1}, env.app()),
		http.StatusUnprocessableEntity, codeValidationFailed)
}
