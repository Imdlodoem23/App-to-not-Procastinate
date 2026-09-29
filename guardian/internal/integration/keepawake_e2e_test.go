package integration

import (
	"encoding/json"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

// TestKeepAwakeEndToEnd walks «Mantener despierto · 1 h» through the real HTTP API and
// the daemon (docs/ARCHITECTURE.md §5.11, §10.14): the app turns it on, the guardian holds
// the inhibition with the app gone, keeps it across a service restart, lets it expire on
// trusted time, and releases it when the service stops. A reboot past the deadline never
// holds again.
func TestKeepAwakeEndToEnd(t *testing.T) {
	clk := engine.NewFakeClock(testStart)
	sys := newSystem(t, clk)
	sys.start()

	var health engine.HealthResponse
	sys.call(req{method: "GET", path: "/v1/health"}, http.StatusOK, &health)
	if !slices.Contains(health.Capabilities, "keep_awake") {
		t.Fatalf("capabilities %v", health.Capabilities)
	}

	// 1. The app turns it on for an hour.
	var res engine.KeepAwakeResponse
	sys.call(req{method: "PUT", path: "/v1/keep-awake", token: sys.token,
		body: map[string]any{"on": true, "durationMinutes": 60, "display": true}}, http.StatusOK, &res)
	ka := res.KeepAwake
	if !ka.On || !ka.Active || ka.Until == nil || !sys.inh.Held() {
		t.Fatalf("turned on %+v", ka)
	}
	until := parseTime(t, *ka.Until)
	if want := testStart.Add(time.Hour); !until.Equal(want) {
		t.Fatalf("until %s, want %s", until, want)
	}

	// 2. A service restart keeps it (state.json) and holds again.
	sys.stop()
	if sys.inh.Held() || !sys.inh.Closed() {
		t.Fatal("the stopped service still holds")
	}
	clk.ServiceRestart(5 * time.Second)
	sys.start()
	if !sys.inh.Held() {
		t.Fatal("not held after the restart")
	}
	var st engine.GuardianStateResponse
	sys.call(req{method: "GET", path: "/v1/state", token: sys.token}, http.StatusOK, &st)
	if st.KeepAwake == nil || !st.KeepAwake.On || st.KeepAwake.Until == nil || !parseTime(t, *st.KeepAwake.Until).Equal(until) {
		t.Fatalf("state.keepAwake after restart %+v", st.KeepAwake)
	}

	// 3. It ends on its own at `until`.
	sys.advance(time.Hour)
	sys.call(req{method: "GET", path: "/v1/keep-awake", token: sys.token}, http.StatusOK, &res)
	if res.KeepAwake.On || sys.inh.Held() {
		t.Fatalf("not expired %+v", res.KeepAwake)
	}
	evs := sys.events()
	on, off := eventsOf(evs, engine.EvKeepAwakeOn), eventsOf(evs, engine.EvKeepAwakeOff)
	if len(on) != 1 || len(off) != 1 || on[0].Points != 0 || off[0].Points != 0 {
		t.Fatalf("events on %d off %d", len(on), len(off))
	}
	var offData engine.KeepAwakeOffData
	if err := json.Unmarshal(off[0].Data, &offData); err != nil || offData.Reason != engine.KeepAwakeOffExpired {
		t.Fatalf("keep_awake_off %s", off[0].Data)
	}

	// 4. On again, then the machine is off past the deadline: never held after boot.
	sys.call(req{method: "PUT", path: "/v1/keep-awake", token: sys.token,
		body: map[string]any{"on": true, "durationMinutes": 30, "display": false}}, http.StatusOK, &res)
	sys.stop()
	holds := len(sys.inh.Holds())
	clk.RebootAfter(2 * time.Hour)
	sys.start()
	if h := sys.inh.Holds()[holds:]; slices.Contains(h, true) {
		t.Fatalf("held after the deadline: %v", h)
	}
	sys.call(req{method: "GET", path: "/v1/keep-awake", token: sys.token}, http.StatusOK, &res)
	if res.KeepAwake.On || res.KeepAwake.Display || res.KeepAwake.DurationMinutes == nil || *res.KeepAwake.DurationMinutes != 30 {
		t.Fatalf("after the reboot %+v", res.KeepAwake)
	}
}
