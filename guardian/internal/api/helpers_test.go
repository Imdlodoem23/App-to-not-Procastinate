package api

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
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/engine"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// testStart is the fake clock's start (§15: no real time, no admin rights).
var testStart = time.Date(2026, 9, 28, 10, 0, 0, 0, time.UTC)

// pinnedOrigin is the chrome-extension:// origin of the embedded extension id.
var pinnedOrigin = chromeOriginPrefix + embedded.API().ChromiumExtensionID

// testAppPath is the app executable of the test config.json (absolute on every OS:
// config.json ignores a relative appPath).
var testAppPath = func() string {
	p, err := filepath.Abs(filepath.FromSlash("/opt/centrate/centrate"))
	if err != nil {
		panic(err)
	}
	return p
}()

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

// fakeNow is the rate limiters' clock.
type fakeNow struct {
	mu sync.Mutex
	t  time.Time
}

func (f *fakeNow) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.t
}

func (f *fakeNow) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.t = f.t.Add(d)
}

// fakePeer is a PeerResolver answering a fixed process.
type fakePeer struct {
	mu   sync.Mutex
	info PeerInfo
	err  error
}

func (f *fakePeer) set(info PeerInfo, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.info, f.err = info, err
}

func (f *fakePeer) Resolve(context.Context, netip.AddrPort, netip.AddrPort) (PeerInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.info, f.err
}

// browserPeer is a Chrome process of an interactive user (engine platform linux).
func browserPeer() PeerInfo {
	return PeerInfo{PID: 4242, Name: "chrome", Path: "/opt/google/chrome/chrome", Interactive: true, Console: true}
}

// appPeer is the desktop app at the configured appPath in the console session.
func appPeer() PeerInfo {
	return PeerInfo{PID: 4343, Name: "centrate", Path: testAppPath, Interactive: true, Console: true}
}

// testEnv is a real engine (every dependency faked, §15) behind a real server on
// 127.0.0.1:<ephemeral port>.
type testEnv struct {
	t      *testing.T
	dir    string
	clk    *engine.FakeClock
	eng    *engine.Engine
	srv    *Server
	base   string
	port   int
	token  string
	logs   *syncBuffer
	peer   *fakePeer
	now    *fakeNow
	client *http.Client
	cfg    Config
}

type envOption func(*testEnv)

// withConfig sets the config.json values of the server.
func withConfig(c Config) envOption { return func(env *testEnv) { env.cfg = c } }

func newTestEnv(t *testing.T, opts ...envOption) *testEnv {
	t.Helper()
	env := &testEnv{
		t:    t,
		dir:  filepath.Join(t.TempDir(), "centrate"),
		clk:  engine.NewFakeClock(testStart),
		logs: &syncBuffer{},
		peer: &fakePeer{info: browserPeer()},
		now:  &fakeNow{t: testStart},
		cfg:  Config{AppPath: testAppPath},
	}
	for _, o := range opts {
		o(env)
	}
	logger := slog.New(slog.NewTextHandler(env.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	env.eng = env.openEngine(logger)
	cfg := env.cfg
	srv, err := New(Options{
		Engine:  env.eng,
		DataDir: env.dir,
		Config:  &cfg,
		Version: "0.1.0-test",
		Logger:  logger,
		Peers:   env.peer,
		Now:     env.now.Now,
		Listen: func(ctx context.Context, _ string) (net.Listener, error) {
			var lc net.ListenConfig
			return lc.Listen(ctx, "tcp4", "127.0.0.1:0")
		},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	env.srv = srv
	if err := srv.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = srv.Stop() })
	select {
	case <-srv.Bound():
	case <-time.After(5 * time.Second):
		t.Fatal("server never bound")
	}
	env.port = srv.Addr().(*net.TCPAddr).Port
	env.base = "http://" + srv.Addr().String()
	env.token = env.clientFile().Token
	env.client = &http.Client{Timeout: 40 * time.Second}
	return env
}

// openEngine opens a real engine on env.dir with every dependency faked.
func (env *testEnv) openEngine(logger *slog.Logger) *engine.Engine {
	env.t.Helper()
	procs := &engine.FakeProcesses{}
	e, err := engine.New(engine.Options{
		DataDir:             env.dir,
		Clock:               env.clk,
		Hosts:               engine.NewFakeHosts(),
		DNS:                 &engine.FakeDNS{},
		NetworkTime:         engine.NewFakeNetworkTime(env.clk.Real),
		ProcessLister:       procs,
		ProcessKiller:       procs,
		Anchor:              store.NewMemAnchor(),
		Platform:            catalog.PlatformLinux,
		Logger:              logger,
		Version:             "0.1.0-test",
		HostsPath:           "/etc/hosts",
		HostsPathRedirected: func() bool { return false },
		DetectTimezone:      func() string { return "Europe/Madrid" },
		DisableWatchers:     true,
	})
	if err != nil {
		env.t.Fatalf("engine.New: %v", err)
	}
	if err := e.Open(); err != nil {
		env.t.Fatalf("engine.Open: %v", err)
	}
	env.t.Cleanup(func() { _ = e.Stop() })
	return e
}

// clientFile reads client.json.
func (env *testEnv) clientFile() ClientFile {
	env.t.Helper()
	raw, err := os.ReadFile(filepath.Join(env.dir, ClientFileName))
	if err != nil {
		env.t.Fatalf("read client.json: %v", err)
	}
	var f ClientFile
	if err := json.Unmarshal(raw, &f); err != nil {
		env.t.Fatalf("parse client.json: %v", err)
	}
	return f
}

type reqOpt func(*http.Request)

func withToken(tok string) reqOpt {
	return func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+tok) }
}

func withOrigin(o string) reqOpt { return func(r *http.Request) { r.Header.Set("Origin", o) } }

func withHeader(k, v string) reqOpt { return func(r *http.Request) { r.Header.Set(k, v) } }

func withHost(h string) reqOpt { return func(r *http.Request) { r.Host = h } }

// app authenticates with the app token.
func (env *testEnv) app() reqOpt { return withToken(env.token) }

// response is a finished request.
type response struct {
	status int
	header http.Header
	body   []byte
}

// errCode is the error code of an error envelope ("" otherwise).
func (r response) errCode() string {
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(r.body, &env)
	return env.Error.Code
}

// errDetails is the details of an error envelope.
func (r response) errDetails() map[string]any {
	var env struct {
		Error struct {
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	_ = json.Unmarshal(r.body, &env)
	return env.Error.Details
}

func (r response) decode(t *testing.T, v any) {
	t.Helper()
	if err := json.Unmarshal(r.body, v); err != nil {
		t.Fatalf("decode %s: %v", r.body, err)
	}
}

// do sends a request. body is nil (none), a string or []byte (raw) or a value
// (JSON); a body gets Content-Type: application/json unless an option replaces it.
func (env *testEnv) do(method, path string, body any, opts ...reqOpt) response {
	env.t.Helper()
	return env.doCtx(context.Background(), method, path, body, opts...)
}

func (env *testEnv) doCtx(ctx context.Context, method, path string, body any, opts ...reqOpt) response {
	env.t.Helper()
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case io.Reader:
		rd = struct{ io.Reader }{b} // unknown length: sent chunked
	case string:
		rd = strings.NewReader(b)
	case []byte:
		rd = bytes.NewReader(b)
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			env.t.Fatalf("marshal: %v", err)
		}
		rd = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, env.base+path, rd)
	if err != nil {
		env.t.Fatalf("NewRequest: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for _, o := range opts {
		o(req)
	}
	res, err := env.client.Do(req)
	if err != nil {
		env.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		env.t.Fatalf("read body: %v", err)
	}
	return response{status: res.StatusCode, header: res.Header, body: raw}
}

// expect fails unless r has status (and, for errors, code).
func expect(t *testing.T, r response, status int, code string) {
	t.Helper()
	if r.status != status || r.errCode() != code {
		t.Fatalf("got %d %q (%s), want %d %q", r.status, r.errCode(), r.body, status, code)
	}
}

// blockBody is a valid CreateBlockRequest.
func blockBody(minutes int) map[string]any {
	return map[string]any{
		"targets": map[string]any{
			"serviceIds": []string{"youtube"}, "categoryIds": []string{}, "appIds": []string{},
			"customDomains": []string{}, "customProcesses": []string{},
		},
		"whitelistOnly":          false,
		"allow":                  map[string]any{"customDomains": []string{}, "customProcesses": []string{}},
		"mode":                   "strict",
		"durationMinutes":        minutes,
		"endsAt":                 nil,
		"reason":                 "Quiero aprobar mates",
		"acknowledgeLong":        false,
		"acknowledgeNoEmergency": false,
	}
}

// createBlock creates a block with the app token and returns its id.
func (env *testEnv) createBlock(minutes int, opts ...reqOpt) string {
	env.t.Helper()
	r := env.do("POST", "/v1/blocks", blockBody(minutes), append([]reqOpt{env.app()}, opts...)...)
	expect(env.t, r, http.StatusCreated, "")
	var res engine.CreateBlockResponse
	r.decode(env.t, &res)
	return res.Block.ID
}

// paired is a paired extension.
type paired struct {
	token, id, publicKey, origin string
}

// pair creates a pairing code with the app token and claims it from origin (the fake
// peer is a Chrome process).
func (env *testEnv) pair(origin string) paired {
	env.t.Helper()
	r := env.do("POST", "/v1/pairing/code", map[string]any{}, env.app())
	expect(env.t, r, http.StatusCreated, "")
	var code engine.PairingCodeResponse
	r.decode(env.t, &code)
	var opts []reqOpt
	if origin != "" {
		opts = append(opts, withOrigin(origin))
	}
	r = env.do("POST", "/v1/pairing/claim", map[string]any{
		"code": code.Code, "browser": "chrome", "browserVersion": "130.0.1", "extVersion": "0.1.0",
	}, opts...)
	expect(env.t, r, http.StatusCreated, "")
	var claim engine.PairingClaimResponse
	r.decode(env.t, &claim)
	return paired{token: claim.Token, id: claim.ExtensionID, publicKey: claim.RulesPublicKey, origin: origin}
}

// waitFor polls cond until it holds (or fails the test after 5 s).
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// runtimeIsUnix reports whether file modes are meaningful.
func runtimeIsUnix() bool { return runtime.GOOS != "windows" }

// eventsPoll is the events long-poll path from the current end of the log.
func (env *testEnv) eventsPoll(waitMs int) string {
	env.t.Helper()
	r := env.do("GET", "/v1/state", nil, env.app())
	expect(env.t, r, http.StatusOK, "")
	var st engine.GuardianStateResponse
	r.decode(env.t, &st)
	return fmt.Sprintf("/v1/events?epoch=%s&after=%d&waitMs=%d", st.Epoch, st.LastEventSeq, waitMs)
}

// discardLogger drops everything.
func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }
