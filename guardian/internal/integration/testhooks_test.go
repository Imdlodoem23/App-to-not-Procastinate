//go:build testhooks

package integration

import (
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

// clockAction is a TestClockRequest with one action set (every field is required).
func clockAction(field string, v int64) map[string]any {
	body := map[string]any{"advanceMs": nil, "suspendMs": nil, "jumpMs": nil, "reboot": false}
	body[field] = v
	return body
}

// testClock sends POST /v1/_test/clock with the app token.
func (s *system) testClock(body map[string]any) engine.TestClockResponse {
	s.t.Helper()
	var res engine.TestClockResponse
	s.call(req{method: "POST", path: "/v1/_test/clock", body: body, token: s.token}, http.StatusOK, &res)
	return res
}

// TestTestClockDrivesTheBinaryClock runs the guardian with the clock a testhooks build
// picks by itself (no injected clock): POST /v1/_test/clock moves it, it survives a
// restart (saved in the data folder), and a block ends when the test clock says so.
func TestTestClockDrivesTheBinaryClock(t *testing.T) {
	sys := newSystem(t, nil)
	sys.start()

	var health engine.HealthResponse
	sys.call(req{method: "GET", path: "/v1/health"}, http.StatusOK, &health)
	if !slices.Contains(health.Capabilities, "testhooks") {
		t.Fatalf("capabilities = %v, want testhooks", health.Capabilities)
	}
	// The route needs the app token and exactly one action.
	if r := sys.do(req{method: "POST", path: "/v1/_test/clock", body: clockAction("advanceMs", 1000)}); r.status != http.StatusUnauthorized {
		t.Fatalf("without token = %d", r.status)
	}
	two := clockAction("advanceMs", 1000)
	two["jumpMs"] = 1000
	if r := sys.do(req{method: "POST", path: "/v1/_test/clock", body: two, token: sys.token}); r.status != http.StatusUnprocessableEntity {
		t.Fatalf("two actions = %d %s", r.status, r.body)
	}

	block := sys.createBlock(engine.ModeStrict, 60, "youtube")
	t0 := parseTime(t, sys.testClock(clockAction("advanceMs", 0)).TrustedNow)
	t1 := parseTime(t, sys.testClock(clockAction("advanceMs", int64(30*time.Minute/time.Millisecond))).TrustedNow)
	if d := t1.Sub(t0); d != 30*time.Minute {
		t.Fatalf("advance moved trusted time by %s", d)
	}

	// Restart: the fake clock resumes where the test left it.
	sys.stop()
	if _, err := os.Stat(filepath.Join(sys.dataDir, "testhooks-clock.json")); err != nil {
		t.Fatalf("fake clock not saved: %v", err)
	}
	sys.start()
	t2 := parseTime(t, sys.testClock(clockAction("advanceMs", 0)).TrustedNow)
	if t2.Before(t1) || t2.Sub(t1) > time.Minute {
		t.Fatalf("after the restart trusted time is %s, the test left it at %s", t2, t1)
	}
	if b := sys.getBlock(block.ID); b.Status != engine.StatusActive || b.EndsAt != block.EndsAt {
		t.Fatalf("after restart = %+v", b)
	}

	// A wall jump moves the display end; the block still ends in real (trusted) time.
	before := sys.getBlock(block.ID)
	sys.testClock(clockAction("jumpMs", int64(time.Hour/time.Millisecond)))
	if d := parseTime(t, sys.getBlock(block.ID).EndsAt).Sub(parseTime(t, before.EndsAt)); d != time.Hour {
		t.Fatalf("display endsAt moved by %s after a 1 h jump", d)
	}
	sys.testClock(clockAction("advanceMs", int64(31*time.Minute/time.Millisecond)))
	if b := sys.getBlock(block.ID); b.Status != engine.StatusCompleted {
		t.Fatalf("after endsAt = %+v", b)
	}
	if got := sys.hostsFile(); got != userHosts {
		t.Fatalf("hosts file = %q", got)
	}
	sys.stop()
}
