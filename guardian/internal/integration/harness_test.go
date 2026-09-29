package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/api"
	"github.com/imdlodoem23/centrate/guardian/internal/awake"
	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
	"github.com/imdlodoem23/centrate/guardian/internal/daemon"
	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/engine"
	"github.com/imdlodoem23/centrate/guardian/internal/platform"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// userHosts is the user's own hosts file: it must come back byte for byte.
const userHosts = "127.0.0.1 localhost\n::1 localhost\n"

// testStart is the fake clock's start: a fixed instant, so local days never roll over
// in the middle of a test.
var testStart = time.Date(2026, 9, 28, 8, 0, 0, 0, time.UTC)

// pinnedOrigin is the chrome-extension:// origin of the embedded extension id.
var pinnedOrigin = "chrome-extension://" + embedded.API().ChromiumExtensionID

// syncBuffer is a goroutine-safe log sink.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// system is one machine: a data directory, a hosts file, a fake clock and the guardian
// (internal/daemon) as the binary assembles it, restartable on the same files.
type system struct {
	t         *testing.T
	dataDir   string
	hostsPath string
	// clk is the injected fake clock; nil lets the daemon pick its default (the
	// persisted fake clock of testhooks builds).
	clk   *engine.FakeClock
	procs *engine.FakeProcesses
	// inh is the keep-awake inhibitor of every start (the machine's, reused).
	inh    *awake.Fake
	anchor store.AnchorStore
	logs   *syncBuffer
	// version is the guardian version the next start runs ("" is the default build);
	// changing it changes the binary identity sealed in run/clock.json, like an update.
	version string

	r      *daemon.Runner
	base   string
	port   int
	token  string
	client *http.Client
}

// newSystem prepares the temporary machine. CENTRATE_DATA_DIR and CENTRATE_HOSTS_PATH
// point at it, so the daemon's defaults (platform.DataDir, platform.HostsPath) and
// engine.HasActive find it like the binary would.
func newSystem(t *testing.T, clk *engine.FakeClock) *system {
	t.Helper()
	base := t.TempDir()
	s := &system{
		t:         t,
		dataDir:   filepath.Join(base, "centrate"),
		hostsPath: filepath.Join(base, "hosts"),
		clk:       clk,
		procs:     &engine.FakeProcesses{},
		inh:       awake.NewFake(nil),
		logs:      &syncBuffer{},
		client:    &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{Proxy: nil}},
	}
	t.Setenv(platform.EnvDataDir, s.dataDir)
	t.Setenv(platform.EnvHostsPath, s.hostsPath)
	if err := os.WriteFile(s.hostsPath, []byte(userHosts), 0o644); err != nil {
		t.Fatal(err)
	}
	// The development anchor next to the data directory (store.DefaultAnchor with
	// CENTRATE_DATA_DIR), so it survives restarts like the OS anchor does.
	s.anchor = &store.FileAnchor{Path: s.dataDir + ".anchor.json"}
	t.Cleanup(s.stopIfRunning)
	return s
}

// options are the daemon options of this machine: everything real except the clock,
// the process table, the peer lookup and the listener (an ephemeral port).
func (s *system) options() daemon.Options {
	o := daemon.Options{
		Logger:         slog.New(slog.NewTextHandler(s.logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		Version:        "0.1.0-e2e",
		ServiceManager: "integration-test",
		ProcessLister:  s.procs,
		ProcessKiller:  s.procs,
		Anchor:         s.anchor,
		Peers:          api.PeerResolverFunc(chromePeer),
		DetectTimezone: func() string { return "Europe/Madrid" },
		ShuttingDown:   func() bool { return false },
		OnFatal:        func(err error) { s.t.Errorf("guardian startup failed: %v", err) },
		NewInhibitor: func(onChange func()) awake.Inhibitor {
			s.inh.SetOnChange(onChange)
			s.inh.Reopen()
			return s.inh
		},
		Listen: func(ctx context.Context, _ string) (net.Listener, error) {
			var lc net.ListenConfig
			return lc.Listen(ctx, "tcp4", "127.0.0.1:0")
		},
	}
	if s.version != "" {
		o.Version = s.version
	}
	if s.clk != nil {
		o.Clock = s.clk
		o.NetworkTime = engine.NewFakeNetworkTime(s.clk.Real)
	}
	return o
}

// chromePeer answers that the loopback peer is Chrome in the user's session.
func chromePeer(context.Context, netip.AddrPort, netip.AddrPort) (api.PeerInfo, error) {
	return api.PeerInfo{PID: 4242, Name: chromeProcess(), Interactive: true, Console: true}, nil
}

// chromeProcess is Chrome's executable name on this OS, from the catalog.
func chromeProcess() string {
	b, ok := catalog.Default().Browser("chrome")
	if ok {
		if names := b.Processes.For(string(catalog.CurrentPlatform())); len(names) > 0 {
			return names[0]
		}
	}
	return "chrome"
}

// start runs the guardian and waits for its API, then reads client.json like the
// desktop app does.
func (s *system) start() {
	s.t.Helper()
	r := daemon.New(s.options())
	if err := r.Start(context.Background()); err != nil {
		s.t.Fatalf("Start: %v", err)
	}
	s.r = r
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := r.WaitBound(ctx); err != nil {
		s.t.Fatalf("the API never opened: %v", err)
	}
	cf := s.clientFile()
	if !strings.HasPrefix(cf.Token, "cta_") {
		s.t.Fatalf("client.json token %q", cf.Token)
	}
	addr := r.Addr().(*net.TCPAddr)
	if cf.Port != addr.Port {
		s.t.Fatalf("client.json port %d, bound %d", cf.Port, addr.Port)
	}
	s.port, s.token = cf.Port, cf.Token
	s.base = fmt.Sprintf("http://127.0.0.1:%d", cf.Port)
}

// stop stops the guardian cleanly (the service manager's stop).
func (s *system) stop() {
	s.t.Helper()
	if err := s.r.Stop(); err != nil {
		s.t.Fatalf("Stop: %v", err)
	}
	s.r = nil
}

func (s *system) stopIfRunning() {
	if s.r != nil {
		_ = s.r.Stop()
		s.r = nil
	}
}

// clientFile reads client.json.
func (s *system) clientFile() api.ClientFile {
	s.t.Helper()
	raw, err := os.ReadFile(filepath.Join(s.dataDir, api.ClientFileName))
	if err != nil {
		s.t.Fatalf("read client.json: %v", err)
	}
	var f api.ClientFile
	if err := json.Unmarshal(raw, &f); err != nil {
		s.t.Fatalf("parse client.json: %v", err)
	}
	return f
}

// hostsFile reads the hosts file.
func (s *system) hostsFile() string {
	s.t.Helper()
	raw, err := os.ReadFile(s.hostsPath)
	if err != nil {
		s.t.Fatalf("read hosts: %v", err)
	}
	return string(raw)
}

// response is a finished request.
type response struct {
	status int
	header http.Header
	body   []byte
}

func (r response) errCode() string {
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(r.body, &env)
	return env.Error.Code
}

// req describes one HTTP request.
type req struct {
	method, path string
	body         any
	token        string
	origin       string
	idemKey      string
}

// do sends a request to the guardian's API.
func (s *system) do(q req) response {
	s.t.Helper()
	var rd io.Reader
	if q.body != nil {
		raw, err := json.Marshal(q.body)
		if err != nil {
			s.t.Fatal(err)
		}
		rd = bytes.NewReader(raw)
	}
	hr, err := http.NewRequest(q.method, s.base+q.path, rd)
	if err != nil {
		s.t.Fatal(err)
	}
	if q.body != nil {
		hr.Header.Set("Content-Type", "application/json")
	}
	if q.token != "" {
		hr.Header.Set("Authorization", "Bearer "+q.token)
	}
	if q.origin != "" {
		hr.Header.Set("Origin", q.origin)
	}
	if q.idemKey != "" {
		hr.Header.Set("Idempotency-Key", q.idemKey)
	}
	res, err := s.client.Do(hr)
	if err != nil {
		s.t.Fatalf("%s %s: %v", q.method, q.path, err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		s.t.Fatal(err)
	}
	return response{status: res.StatusCode, header: res.Header, body: raw}
}

// call sends a request and decodes a successful answer into out (nil: ignore).
func (s *system) call(q req, want int, out any) response {
	s.t.Helper()
	r := s.do(q)
	if r.status != want {
		s.t.Fatalf("%s %s = %d %s, want %d", q.method, q.path, r.status, r.body, want)
	}
	if out != nil {
		if err := json.Unmarshal(r.body, out); err != nil {
			s.t.Fatalf("decode %s: %v", r.body, err)
		}
	}
	return r
}

// blockRequest is a CreateBlockRequest for catalog services.
func blockRequest(mode string, minutes int, services ...string) map[string]any {
	return map[string]any{
		"targets": map[string]any{
			"serviceIds": services, "categoryIds": []string{}, "appIds": []string{},
			"customDomains": []string{}, "customProcesses": []string{},
		},
		"whitelistOnly":          false,
		"allow":                  map[string]any{"customDomains": []string{}, "customProcesses": []string{}},
		"mode":                   mode,
		"durationMinutes":        minutes,
		"endsAt":                 nil,
		"reason":                 "Aprobar el examen de mates",
		"acknowledgeLong":        minutes > 240,
		"acknowledgeNoEmergency": mode == engine.ModeHardcore || mode == engine.ModeExam,
	}
}

// createBlock creates a block with the app token.
func (s *system) createBlock(mode string, minutes int, services ...string) engine.Block {
	s.t.Helper()
	var res engine.CreateBlockResponse
	s.call(req{method: "POST", path: "/v1/blocks", body: blockRequest(mode, minutes, services...), token: s.token,
		idemKey: fmt.Sprintf("e2e-%s-%d-%d", mode, minutes, time.Now().UnixNano())}, http.StatusCreated, &res)
	return res.Block
}

// getBlock reads one block.
func (s *system) getBlock(id string) engine.Block {
	s.t.Helper()
	var res engine.GetBlockResponse
	s.call(req{method: "GET", path: "/v1/blocks/" + id, token: s.token}, http.StatusOK, &res)
	return res.Block
}

// advance moves the fake clock with the machine awake, one engine tick at a time (the
// engine's TestClock command, which POST /v1/_test/clock serves in testhooks builds).
func (s *system) advance(d time.Duration) {
	s.t.Helper()
	ms := d.Milliseconds()
	if _, err := s.r.Engine().TestClock(context.Background(), engine.TestClockRequest{AdvanceMs: &ms}); err != nil {
		s.t.Fatalf("advance %s: %v", d, err)
	}
}

// wireEvent is the part of a /v1/events line the tests read.
type wireEvent struct {
	Seq    int64           `json:"seq"`
	Type   string          `json:"type"`
	Points int64           `json:"points"`
	Data   json.RawMessage `json:"data"`
}

// events reads the whole current epoch through GET /v1/events.
func (s *system) events() []wireEvent {
	s.t.Helper()
	var st engine.GuardianStateResponse
	s.call(req{method: "GET", path: "/v1/state", token: s.token}, http.StatusOK, &st)
	var out []wireEvent
	after := int64(0)
	for {
		var page struct {
			Events  []wireEvent `json:"events"`
			LastSeq int64       `json:"lastSeq"`
			HasMore bool        `json:"hasMore"`
		}
		s.call(req{method: "GET", path: fmt.Sprintf("/v1/events?epoch=%s&after=%d", st.Epoch, after), token: s.token}, http.StatusOK, &page)
		out = append(out, page.Events...)
		if !page.HasMore {
			return out
		}
		after = page.LastSeq
	}
}

// eventsOf keeps the events of one type.
func eventsOf(evs []wireEvent, typ string) []wireEvent {
	var out []wireEvent
	for _, ev := range evs {
		if ev.Type == typ {
			out = append(out, ev)
		}
	}
	return out
}

// parseTime parses a wire timestamp.
func parseTime(t *testing.T, s string) time.Time {
	t.Helper()
	v, err := time.Parse("2006-01-02T15:04:05.000Z", s)
	if err != nil {
		t.Fatalf("timestamp %q: %v", s, err)
	}
	return v
}
