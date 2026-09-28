package integration

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/api"
	"github.com/imdlodoem23/centrate/guardian/internal/engine"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
	"github.com/imdlodoem23/centrate/guardian/internal/svc"
)

// hostsLines are the two sink lines of domain in the Céntrate section.
func hostsLines(domain string) []string {
	return []string{"0.0.0.0 " + domain, ":: " + domain}
}

func hasLine(content, line string) bool {
	for l := range strings.Lines(content) {
		if strings.TrimRight(l, "\r\n") == line {
			return true
		}
	}
	return false
}

// TestGuardianEndToEnd walks the guardian's main promise through its real HTTP API: a
// YouTube block created with the token from client.json lands in the hosts file,
// survives a restart, prices attempts from a paired extension (−10, then −20), follows
// a forward wall-clock jump with its display end, and ends on time with +60 and a
// hosts file byte-identical to the user's.
func TestGuardianEndToEnd(t *testing.T) {
	clk := engine.NewFakeClock(testStart)
	sys := newSystem(t, clk)
	sys.start()

	var health engine.HealthResponse
	sys.call(req{method: "GET", path: "/v1/health"}, http.StatusOK, &health)
	if !health.OK || health.Name != "centrate-guardian" || health.Version != "0.1.0-e2e" {
		t.Fatalf("health = %+v", health)
	}
	if got := slices.Contains(health.Capabilities, "testhooks"); got != api.TestHooksEnabled() {
		t.Fatalf("testhooks capability = %v in a build with testhooks %v", got, api.TestHooksEnabled())
	}
	// Writes need the token; the app token from client.json works.
	if r := sys.do(req{method: "POST", path: "/v1/blocks", body: blockRequest(engine.ModeStrict, 60, "youtube")}); r.status != http.StatusUnauthorized {
		t.Fatalf("create without token = %d %s", r.status, r.body)
	}

	// 1. A 60-minute YouTube block reaches the hosts file (IPv4 and IPv6 sinks).
	block := sys.createBlock(engine.ModeStrict, 60, "youtube")
	if block.Status != engine.StatusActive || block.Kind != "manual" {
		t.Fatalf("block = %+v", block)
	}
	endsAt := parseTime(t, block.EndsAt)
	if want := testStart.Add(60 * time.Minute); !endsAt.Equal(want) {
		t.Fatalf("endsAt = %s, want %s", endsAt, want)
	}
	hostsNow := sys.hostsFile()
	for _, line := range hostsLines("youtube.com") {
		if !hasLine(hostsNow, line) {
			t.Fatalf("hosts file lacks %q:\n%s", line, hostsNow)
		}
	}
	if !strings.HasPrefix(hostsNow, userHosts) {
		t.Fatalf("the user's lines changed:\n%s", hostsNow)
	}
	if lvl, err := engine.HasActiveWith(sys.dataDir, clk); err != nil || lvl != engine.ActiveNormal {
		t.Fatalf("has-active during a strict block = %v, %v; want %v", lvl, err, engine.ActiveNormal)
	}

	// 2. Restart: a new guardian process state from disk. The block survives, the
	//    section stays, and client.json carries a new token (the old one is dead).
	oldToken := sys.token
	sys.stop()
	if !hasLine(sys.hostsFile(), "0.0.0.0 youtube.com") {
		t.Fatal("stopping the guardian removed the hosts section")
	}
	clk.ServiceRestart(5 * time.Second)
	sys.start()
	if sys.token == oldToken {
		t.Fatal("the app token was not rotated on restart")
	}
	if r := sys.do(req{method: "GET", path: "/v1/state", token: oldToken}); r.status != http.StatusUnauthorized {
		t.Fatalf("old token after restart = %d", r.status)
	}
	again := sys.getBlock(block.ID)
	if again.Status != engine.StatusActive || again.EndsAt != block.EndsAt {
		t.Fatalf("after restart = %+v, want active until %s", again, block.EndsAt)
	}
	if !hasLine(sys.hostsFile(), ":: youtube.com") {
		t.Fatal("hosts section lost across the restart")
	}
	var st engine.GuardianStateResponse
	sys.call(req{method: "GET", path: "/v1/state", token: sys.token}, http.StatusOK, &st)
	if len(st.Blocks) != 1 || st.Blocks[0].ID != block.ID {
		t.Fatalf("state blocks = %+v", st.Blocks)
	}

	// 3. Pair the extension (the loopback peer is Chrome) and report attempts with
	//    its token: −10, then −20 after the dedupe window (global escalation).
	var code engine.PairingCodeResponse
	sys.call(req{method: "POST", path: "/v1/pairing/code", body: map[string]any{}, token: sys.token}, http.StatusCreated, &code)
	var claim engine.PairingClaimResponse
	sys.call(req{method: "POST", path: "/v1/pairing/claim", origin: pinnedOrigin, body: map[string]any{
		"code": code.Code, "browser": "chrome", "browserVersion": "131.0.6778.86", "extVersion": "0.1.0",
	}}, http.StatusCreated, &claim)
	if !strings.HasPrefix(claim.Token, "cte_") || claim.RulesPublicKey == "" {
		t.Fatalf("claim = %+v", claim)
	}
	attempt := map[string]any{
		"layer": "extension", "target": map[string]any{"type": "domain", "value": "www.youtube.com"},
		"browser": "chrome", "incognito": false,
	}
	var a1, a2 engine.AttemptResponse
	sys.call(req{method: "POST", path: "/v1/attempts", body: attempt, token: claim.Token, origin: pinnedOrigin}, http.StatusOK, &a1)
	if !a1.Blocked || !a1.Counted || a1.PointsDelta != -10 {
		t.Fatalf("first attempt = %+v, want counted −10", a1)
	}
	sys.advance(31 * time.Second)
	sys.call(req{method: "POST", path: "/v1/attempts", body: attempt, token: claim.Token, origin: pinnedOrigin}, http.StatusOK, &a2)
	if !a2.Counted || a2.PointsDelta != -20 {
		t.Fatalf("second attempt = %+v, want counted −20", a2)
	}
	// The app token may not speak for the extension layer.
	if r := sys.do(req{method: "POST", path: "/v1/attempts", body: attempt, token: sys.token}); r.status != http.StatusForbidden {
		t.Fatalf("extension attempt with the app token = %d %s", r.status, r.body)
	}

	// 4. A forward wall-clock jump: the real remaining time does not change, the
	//    display endsAt moves with the clock («suma ese salto a endsAt»).
	before := sys.getBlock(block.ID)
	clk.JumpWall(2 * time.Hour)
	sys.advance(2 * time.Second)
	after := sys.getBlock(block.ID)
	if d := parseTime(t, after.EndsAt).Sub(parseTime(t, before.EndsAt)); d != 2*time.Hour {
		t.Fatalf("display endsAt moved by %s, want 2h (%s → %s)", d, before.EndsAt, after.EndsAt)
	}
	if after.Status != engine.StatusActive {
		t.Fatalf("a wall jump ended the block: %+v", after)
	}
	if jumps := eventsOf(sys.events(), engine.EvClockJump); len(jumps) == 0 {
		t.Fatal("no clock_jump event for the wall jump")
	}

	// 5. Past endsAt: the section is gone (the file is byte-identical to the user's),
	//    and block_completed credits +60 (no clean bonus: attempts were counted).
	sys.advance(61 * time.Minute)
	done := sys.getBlock(block.ID)
	if done.Status != engine.StatusCompleted {
		t.Fatalf("block after endsAt = %+v", done)
	}
	if got := sys.hostsFile(); got != userHosts {
		t.Fatalf("hosts file after the block = %q, want %q", got, userHosts)
	}
	evs := sys.events()
	completed := eventsOf(evs, engine.EvBlockCompleted)
	if len(completed) != 1 {
		t.Fatalf("block_completed events = %d", len(completed))
	}
	var data engine.BlockCompletedData
	if err := json.Unmarshal(completed[0].Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.BlockID != block.ID || completed[0].Points != 60 || data.CreditedMinutes != 60 || data.AttemptsCounted != 2 {
		t.Fatalf("block_completed = points %d, %+v; want +60, 60 minutes, 2 attempts", completed[0].Points, data)
	}
	var points engine.PointsResponse
	sys.call(req{method: "GET", path: "/v1/points", token: sys.token}, http.StatusOK, &points)
	if points.Points.Balance != 60-10-20 {
		t.Fatalf("balance = %d, want %d", points.Points.Balance, 60-10-20)
	}
	if lvl, err := engine.HasActiveWith(sys.dataDir, clk); err != nil || lvl != engine.ActiveNone {
		t.Fatalf("has-active after the block = %v, %v", lvl, err)
	}

	// No secret and no blocked domain ever reaches the logs (§9.2, logx).
	logs := sys.logs.String()
	for _, secret := range []string{oldToken, sys.token, claim.Token, code.Code, "youtube.com"} {
		if strings.Contains(logs, secret) {
			t.Fatalf("the logs contain %q", secret)
		}
	}
	sys.stop()
}

// TestHasActiveLevels checks the has-active answer (exit 10 or 11) for each kind of
// block, read from state.json like the CLI does, with the guardian stopped.
func TestHasActiveLevels(t *testing.T) {
	clk := engine.NewFakeClock(testStart)
	sys := newSystem(t, clk)
	if lvl, err := engine.HasActiveWith(sys.dataDir, clk); err != nil || lvl != engine.ActiveNone {
		t.Fatalf("never installed = %v, %v", lvl, err)
	}
	sys.start()
	sys.createBlock(engine.ModeNormal, 30, "youtube")
	sys.stop()
	if lvl, err := engine.HasActiveWith(sys.dataDir, clk); err != nil || lvl != engine.ActiveNormal {
		t.Fatalf("normal block = %v, %v", lvl, err)
	}
	sys.start()
	sys.createBlock(engine.ModeHardcore, 20, "tiktok")
	sys.stop()
	if lvl, err := engine.HasActiveWith(sys.dataDir, clk); err != nil || lvl != engine.ActiveStrong {
		t.Fatalf("hardcore block = %v, %v", lvl, err)
	}
	// Time passes while the guardian is stopped: has-active still sees the ends.
	clk.Advance(21 * time.Minute)
	if lvl, err := engine.HasActiveWith(sys.dataDir, clk); err != nil || lvl != engine.ActiveNormal {
		t.Fatalf("after the hardcore end = %v, %v", lvl, err)
	}
	clk.Advance(10 * time.Minute)
	if lvl, err := engine.HasActiveWith(sys.dataDir, clk); err != nil || lvl != engine.ActiveNone {
		t.Fatalf("after every end = %v, %v", lvl, err)
	}
}

// TestStopDuringBlock prices a same-boot stop of more than 60 s during a block like an
// emergency (tamper_detected{service_stopped}, §10.12 step 9), unless the stop was part
// of an OS shutdown (the guardian wrote the planned-stop marker itself, §13) or an
// update: `centrate-guardian prepare-update` writes the marker (svc.WritePlannedStop,
// reason update) before it stops the service, and the marker only covers a restart
// within store.PlannedStopTTL.
func TestStopDuringBlock(t *testing.T) {
	for _, tc := range []struct {
		name        string
		stop        string // "plain", "shutdown" or "update"
		down        time.Duration
		wantPenalty bool
	}{
		{"plain stop", "plain", 5 * time.Minute, true},
		{"stop during an OS shutdown", "shutdown", 5 * time.Minute, false},
		{"prepare-update", "update", 5 * time.Minute, false},
		{"prepare-update without a restart in time", "update", store.PlannedStopTTL + time.Minute, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			start := testStart
			if tc.stop == "update" {
				// The CLI dates its marker with the machine's clock.
				start = time.Now().UTC().Truncate(time.Millisecond)
			}
			clk := engine.NewFakeClock(start)
			sys := newSystem(t, clk)
			sys.start()
			block := sys.createBlock(engine.ModeNormal, 60, "youtube")
			switch tc.stop {
			case "shutdown":
				if err := sys.r.Shutdown(t.Context()); err != nil {
					t.Fatal(err)
				}
				sys.r = nil
			case "update":
				if err := svc.WritePlannedStop(svc.PlannedStopUpdate); err != nil {
					t.Fatal(err)
				}
				sys.stop()
			default:
				sys.stop()
			}
			clk.ServiceRestart(tc.down)
			sys.start()
			var tampers []engine.TamperDetectedData
			for _, ev := range eventsOf(sys.events(), engine.EvTamperDetected) {
				var d engine.TamperDetectedData
				if err := json.Unmarshal(ev.Data, &d); err != nil {
					t.Fatal(err)
				}
				if d.Kind == "service_stopped" {
					tampers = append(tampers, d)
				}
			}
			switch {
			case tc.wantPenalty && (len(tampers) != 1 || tampers[0].BalanceCorrection >= 0 || !tampers[0].VoidStreak):
				t.Fatalf("service_stopped = %+v, want one penalty that voids the streak", tampers)
			case !tc.wantPenalty && len(tampers) != 0:
				t.Fatalf("a planned stop was priced: %+v", tampers)
			}
			// Either way the block goes on: stopping never ends it.
			if b := sys.getBlock(block.ID); b.Status != engine.StatusActive {
				t.Fatalf("block after the stop = %+v", b)
			}
			sys.stop()
		})
	}
}
