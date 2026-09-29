//go:build !testhooks

package integration

import (
	"net/http"
	"slices"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

// TestReleaseBuildHasNoTestClock: without the testhooks tag the route does not exist
// and health does not advertise it (docs/ARCHITECTURE.md §15, §17 item 9).
func TestReleaseBuildHasNoTestClock(t *testing.T) {
	sys := newSystem(t, engine.NewFakeClock(testStart))
	sys.start()
	var health engine.HealthResponse
	sys.call(req{method: "GET", path: "/v1/health"}, http.StatusOK, &health)
	if slices.Contains(health.Capabilities, "testhooks") {
		t.Fatalf("capabilities = %v", health.Capabilities)
	}
	r := sys.do(req{method: "POST", path: "/v1/_test/clock", body: map[string]any{"advanceMs": 1000, "suspendMs": nil, "jumpMs": nil, "reboot": false}, token: sys.token})
	if r.status != http.StatusNotFound || r.errCode() != "not_found" {
		t.Fatalf("POST /v1/_test/clock = %d %s, want 404 not_found", r.status, r.body)
	}
	sys.stop()
}
