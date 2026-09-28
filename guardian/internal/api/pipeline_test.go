package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

func TestHostHeaderRebindingRejected(t *testing.T) {
	env := newTestEnv(t)
	port := fmt.Sprint(env.port)
	cases := []struct {
		host string
		ok   bool
	}{
		{"127.0.0.1:" + port, true},
		{"localhost:" + port, true},
		{"LocalHost:" + port, true},
		{"evil.example:" + port, false},
		{"127.0.0.1:1", false},
		{"127.0.0.1", false},
		{"localhost", false},
		{"[::1]:" + port, false},
		{"127.0.0.2:" + port, false},
		{"127.0.0.1:" + port + ".evil.example", false},
	}
	for _, c := range cases {
		r := env.do("GET", "/v1/health", nil, withHost(c.host))
		if c.ok {
			expect(t, r, http.StatusOK, "")
			continue
		}
		expect(t, r, http.StatusForbidden, codeHostNotAllowed)
		// Before anything else: even an app token or an unknown route gets 403.
		expect(t, env.do("GET", "/v1/nope", nil, withHost(c.host), env.app()), http.StatusForbidden, codeHostNotAllowed)
	}
}

func TestOriginRules(t *testing.T) {
	extra := "abcdefghijklmnopabcdefghijklmnop"
	env := newTestEnv(t, withConfig(Config{AppPath: testAppPath, ExtraExtensionIDs: []string{extra}}))
	firefox := firefoxOriginPrefix + "0b5c7c7e-3a51-4c49-9f3e-2f1c1f7d9a10"
	for _, o := range []string{pinnedOrigin, chromeOriginPrefix + extra, firefox} {
		r := env.do("GET", "/v1/health", nil, withOrigin(o))
		expect(t, r, http.StatusOK, "")
		if got := r.header.Get("Access-Control-Allow-Origin"); got != o {
			t.Fatalf("ACAO for %s = %q", o, got)
		}
		if got := r.header.Get("Access-Control-Expose-Headers"); got != corsExposeHeaders {
			t.Fatalf("Expose-Headers = %q", got)
		}
		if r.header.Get("Access-Control-Allow-Credentials") != "" {
			t.Fatal("Allow-Credentials must never be sent")
		}
	}
	for _, o := range []string{
		"https://evil.example", "null", "", "http://127.0.0.1:" + fmt.Sprint(env.port),
		chromeOriginPrefix + "ponmlkjihgfedcbaponmlkjihgfedcba", chromeOriginPrefix + embeddedIDUpper(),
		firefoxOriginPrefix + "not-a-uuid", firefoxOriginPrefix + "0B5C7C7E-3A51-4C49-9F3E-2F1C1F7D9A10",
		pinnedOrigin + "/", "chrome-extension://",
	} {
		// Every route, /v1/health included (no fingerprinting by web pages), without CORS headers.
		for _, path := range []string{"/v1/health", "/v1/state", "/v1/nope"} {
			r := env.do("GET", path, nil, withOrigin(o), env.app())
			expect(t, r, http.StatusForbidden, codeOriginNotAllowed)
			if r.header.Get("Access-Control-Allow-Origin") != "" {
				t.Fatalf("CORS header for disallowed origin %q", o)
			}
		}
	}
	// App-token requests must carry no Origin, even an allowed one.
	expect(t, env.do("GET", "/v1/state", nil, withOrigin(pinnedOrigin), env.app()), http.StatusForbidden, codeOriginNotAllowed)
	// Two Origin headers.
	r := env.do("GET", "/v1/health", nil, func(r *http.Request) {
		r.Header.Add("Origin", pinnedOrigin)
		r.Header.Add("Origin", pinnedOrigin)
	})
	expect(t, r, http.StatusForbidden, codeOriginNotAllowed)
}

func embeddedIDUpper() string {
	return strings.ToUpper(strings.TrimPrefix(pinnedOrigin, chromeOriginPrefix))
}

func TestPreflight(t *testing.T) {
	env := newTestEnv(t)
	r := env.do("OPTIONS", "/v1/ext/rules", nil, withOrigin(pinnedOrigin),
		withHeader("Access-Control-Request-Method", "GET"),
		withHeader("Access-Control-Request-Headers", "authorization"))
	expect(t, r, http.StatusNoContent, "")
	want := map[string]string{
		"Access-Control-Allow-Origin":   pinnedOrigin,
		"Access-Control-Allow-Methods":  corsAllowMethods,
		"Access-Control-Allow-Headers":  corsAllowHeaders,
		"Access-Control-Expose-Headers": corsExposeHeaders,
		"Access-Control-Max-Age":        "600",
		"Vary":                          "Origin",
	}
	for k, v := range want {
		if got := r.header.Get(k); got != v {
			t.Fatalf("%s = %q, want %q", k, got, v)
		}
	}
	if r.header.Get("Access-Control-Allow-Private-Network") != "" {
		t.Fatal("Allow-Private-Network without a request for it")
	}
	r = env.do("OPTIONS", "/v1/attempts", nil, withOrigin(pinnedOrigin),
		withHeader("Access-Control-Request-Private-Network", "true"))
	expect(t, r, http.StatusNoContent, "")
	if r.header.Get("Access-Control-Allow-Private-Network") != "true" {
		t.Fatal("Allow-Private-Network missing")
	}
	// Disallowed or missing Origin: 403 without CORS headers; unknown path: 404.
	r = env.do("OPTIONS", "/v1/ext/rules", nil, withOrigin("https://evil.example"))
	expect(t, r, http.StatusForbidden, codeOriginNotAllowed)
	if r.header.Get("Access-Control-Allow-Origin") != "" || r.header.Get("Access-Control-Allow-Methods") != "" {
		t.Fatal("CORS headers on a refused preflight")
	}
	expect(t, env.do("OPTIONS", "/v1/ext/rules", nil), http.StatusForbidden, codeOriginNotAllowed)
	expect(t, env.do("OPTIONS", "/v1/nope", nil, withOrigin(pinnedOrigin)), http.StatusNotFound, codeNotFound)
}

// TestAuthMatrix checks every token kind against every auth kind (§8.2).
func TestAuthMatrix(t *testing.T) {
	env := newTestEnv(t)
	ext := env.pair(pinnedOrigin)
	other := env.pair(firefoxOriginPrefix + "0b5c7c7e-3a51-4c49-9f3e-2f1c1f7d9a10")
	attemptApp := map[string]any{"layer": "window", "target": map[string]any{"type": "service", "value": "youtube"}, "browser": nil, "incognito": false}
	attemptExt := map[string]any{"layer": "extension", "target": map[string]any{"type": "domain", "value": "www.youtube.com"}, "browser": "chrome", "incognito": false}
	type tokenCase struct {
		name string
		opts []reqOpt
	}
	none := tokenCase{"none", nil}
	app := tokenCase{"app", []reqOpt{env.app()}}
	extTok := tokenCase{"ext", []reqOpt{withToken(ext.token)}}
	extOrigin := tokenCase{"ext+bound origin", []reqOpt{withToken(ext.token), withOrigin(pinnedOrigin)}}
	extWrongOrigin := tokenCase{"ext+other origin", []reqOpt{withToken(ext.token), withOrigin(other.origin)}}
	unknownApp := tokenCase{"unknown cta", []reqOpt{withToken(appTokenPrefix + strings.Repeat("A", 43))}}
	unknownExt := tokenCase{"unknown cte", []reqOpt{withToken(extTokenPrefix + strings.Repeat("A", 43))}}
	garbage := tokenCase{"garbage", []reqOpt{withToken("hello")}}
	basic := tokenCase{"basic scheme", []reqOpt{withHeader("Authorization", "Basic "+env.token)}}
	appOrigin := tokenCase{"app+origin", []reqOpt{env.app(), withOrigin(pinnedOrigin)}}

	type row struct {
		method, path string
		body         any
		tok          tokenCase
		status       int
		code         string
	}
	rows := []row{
		// none: tokens are ignored.
		{"GET", "/v1/health", nil, none, 200, ""},
		{"GET", "/v1/health", nil, garbage, 200, ""},
		{"GET", "/v1/health", nil, extTok, 200, ""},
		// app.
		{"GET", "/v1/state", nil, none, 401, codeUnauthorized},
		{"GET", "/v1/state", nil, app, 200, ""},
		{"GET", "/v1/state", nil, extTok, 403, codeInsufficientScope},
		{"GET", "/v1/state", nil, unknownApp, 401, codeUnauthorized},
		{"GET", "/v1/state", nil, unknownExt, 401, codeUnauthorized},
		{"GET", "/v1/state", nil, garbage, 401, codeUnauthorized},
		{"GET", "/v1/state", nil, basic, 401, codeUnauthorized},
		{"GET", "/v1/state", nil, appOrigin, 403, codeOriginNotAllowed},
		{"POST", "/v1/blocks", blockBody(30), extTok, 403, codeInsufficientScope},
		{"POST", "/v1/pairing/code", map[string]any{}, extOrigin, 403, codeInsufficientScope},
		// ext.
		{"GET", "/v1/ext/rules?nonce=q3Jd0W3y8kqj3n7mW2Wm8A", nil, none, 401, codeUnauthorized},
		{"GET", "/v1/ext/rules?nonce=q3Jd0W3y8kqj3n7mW2Wm8A", nil, app, 403, codeInsufficientScope},
		{"GET", "/v1/ext/rules?nonce=q3Jd0W3y8kqj3n7mW2Wm8A", nil, extTok, 200, ""},
		{"GET", "/v1/ext/rules?nonce=q3Jd0W3y8kqj3n7mW2Wm8A", nil, extOrigin, 200, ""},
		{"GET", "/v1/ext/rules?nonce=q3Jd0W3y8kqj3n7mW2Wm8A", nil, extWrongOrigin, 403, codeOriginNotAllowed},
		{"GET", "/v1/ext/rules?nonce=q3Jd0W3y8kqj3n7mW2Wm8A", nil, unknownExt, 401, codeUnauthorized},
		// app_or_ext, with the scope rules of the engine.
		{"POST", "/v1/attempts", attemptApp, none, 401, codeUnauthorized},
		{"POST", "/v1/attempts", attemptApp, app, 200, ""},
		{"POST", "/v1/attempts", attemptExt, extTok, 200, ""},
		{"POST", "/v1/attempts", attemptExt, app, 403, codeInsufficientScope},
		{"POST", "/v1/attempts", attemptApp, extTok, 403, codeInsufficientScope},
		{"POST", "/v1/attempts", attemptExt, extWrongOrigin, 403, codeOriginNotAllowed},
	}
	for _, rw := range rows {
		r := env.do(rw.method, rw.path, rw.body, rw.tok.opts...)
		if r.status != rw.status || r.errCode() != rw.code {
			t.Errorf("%s %s with %s: got %d %q (%s), want %d %q",
				rw.method, rw.path, rw.tok.name, r.status, r.errCode(), r.body, rw.status, rw.code)
		}
		if r.status == http.StatusUnauthorized && r.header.Get("WWW-Authenticate") != "Bearer" {
			t.Errorf("%s %s with %s: WWW-Authenticate = %q", rw.method, rw.path, rw.tok.name, r.header.Get("WWW-Authenticate"))
		}
	}

	// A revoked extension token is unknown at once.
	expect(t, env.do("DELETE", "/v1/pairing/extensions/"+ext.id, nil, env.app()), http.StatusNoContent, "")
	expect(t, env.do("GET", "/v1/ext/rules?nonce=q3Jd0W3y8kqj3n7mW2Wm8A", nil, withToken(ext.token)), http.StatusUnauthorized, codeUnauthorized)
}

func TestPairingClaimChecksThePeer(t *testing.T) {
	env := newTestEnv(t)
	code := func() string {
		r := env.do("POST", "/v1/pairing/code", map[string]any{}, env.app())
		expect(t, r, http.StatusCreated, "")
		var c engine.PairingCodeResponse
		r.decode(t, &c)
		return c.Code
	}
	claim := func(c string) response {
		return env.do("POST", "/v1/pairing/claim", map[string]any{
			"code": c, "browser": "chrome", "browserVersion": "130.0", "extVersion": "0.1.0",
		}, withOrigin(pinnedOrigin))
	}
	for _, peer := range []struct {
		name string
		info PeerInfo
		err  error
	}{
		{"curl", PeerInfo{PID: 1, Name: "curl", Interactive: true}, nil},
		{"system chrome", PeerInfo{PID: 1, Name: "chrome", Interactive: false}, nil},
		{"unresolved", PeerInfo{}, errors.New("no peer")},
	} {
		env.peer.set(peer.info, peer.err)
		r := claim(code())
		expect(t, r, http.StatusForbidden, codeInsufficientScope)
		if r.errDetails()["reason"] != "peer_not_browser" {
			t.Fatalf("%s: details = %v", peer.name, r.errDetails())
		}
	}
	env.peer.set(browserPeer(), nil)
	r := claim(code())
	expect(t, r, http.StatusCreated, "")
	var res engine.PairingClaimResponse
	r.decode(t, &res)
	if res.BoundOrigin == nil || *res.BoundOrigin != pinnedOrigin {
		t.Fatalf("boundOrigin = %v", res.BoundOrigin)
	}

	// The heartbeat checks the peer too.
	hb := map[string]any{
		"extVersion": "0.1.0", "browser": "chrome", "browserVersion": "130.0", "incognitoAllowed": true,
		"hostPermission": true, "appliedExtRulesVersion": 0,
	}
	expect(t, env.do("POST", "/v1/ext/heartbeat", hb, withToken(res.Token)), http.StatusOK, "")
	env.peer.set(PeerInfo{PID: 9, Name: "python3", Interactive: true}, nil)
	expect(t, env.do("POST", "/v1/ext/heartbeat", hb, withToken(res.Token)), http.StatusForbidden, codeInsufficientScope)
}

func TestNuclearHeartbeatOnlyFromTheApp(t *testing.T) {
	env := newTestEnv(t)
	body := map[string]any{"overlayShown": true, "displays": 1}
	env.peer.set(appPeer(), nil)
	expect(t, env.do("POST", "/v1/nuclear/heartbeat", body, env.app()), http.StatusOK, "")
	for _, p := range []PeerInfo{
		{PID: 1, Name: "centrate", Path: "/tmp/centrate", Interactive: true, Console: true},
		{PID: 1, Name: "centrate", Path: testAppPath, Interactive: true, Console: false},
		{PID: 1, Name: "curl", Path: "/usr/bin/curl", Interactive: true, Console: true},
	} {
		env.peer.set(p, nil)
		r := env.do("POST", "/v1/nuclear/heartbeat", body, env.app())
		expect(t, r, http.StatusForbidden, codeInsufficientScope)
		if r.errDetails()["reason"] != "peer_not_app" {
			t.Fatalf("details = %v", r.errDetails())
		}
	}
	// Without appPath in config.json nothing is accepted (fail closed).
	env2 := newTestEnv(t, withConfig(Config{}))
	env2.peer.set(appPeer(), nil)
	expect(t, env2.do("POST", "/v1/nuclear/heartbeat", body, env2.app()), http.StatusForbidden, codeInsufficientScope)
}

func TestBodyMediaTypeAndSize(t *testing.T) {
	env := newTestEnv(t)
	r := env.do("POST", "/v1/blocks", blockBody(30), env.app(), withHeader("Content-Type", "text/plain"))
	expect(t, r, http.StatusUnsupportedMediaType, codeUnsupportedMedia)
	r = env.do("POST", "/v1/blocks", blockBody(30), env.app(), withHeader("Content-Type", "application/json; charset=latin1"))
	expect(t, r, http.StatusUnsupportedMediaType, codeUnsupportedMedia)
	r = env.do("POST", "/v1/blocks", blockBody(30), env.app(), withHeader("Content-Type", "application/json; charset=UTF-8"))
	expect(t, r, http.StatusCreated, "")
	big := `{"reason":"` + strings.Repeat("a", 70_000) + `"}`
	expect(t, env.do("POST", "/v1/blocks", big, env.app()), http.StatusRequestEntityTooLarge, codeBodyTooLarge)
	// Chunked (unknown length) bodies are cut at the limit too.
	r = env.do("POST", "/v1/blocks", strings.NewReader(big), env.app())
	expect(t, r, http.StatusRequestEntityTooLarge, codeBodyTooLarge)
	// GET and DELETE take no body.
	expect(t, env.do("GET", "/v1/state", "{}", env.app()), http.StatusBadRequest, codeInvalidJSON)
	// POST without a body is not JSON.
	expect(t, env.do("POST", "/v1/pairing/code", "", env.app()), http.StatusBadRequest, codeInvalidJSON)
}

func TestQueryStrictness(t *testing.T) {
	env := newTestEnv(t)
	expect(t, env.do("GET", "/v1/state?x=1", nil, env.app()), http.StatusBadRequest, codeBadQuery)
	expect(t, env.do("GET", "/v1/blocks?status=ended&status=active", nil, env.app()), http.StatusBadRequest, codeBadQuery)
	expect(t, env.do("GET", "/v1/blocks?limit=0", nil, env.app()), http.StatusBadRequest, codeBadQuery)
	expect(t, env.do("GET", "/v1/blocks?limit=1e2", nil, env.app()), http.StatusBadRequest, codeBadQuery)
	expect(t, env.do("GET", "/v1/blocks?status=bogus", nil, env.app()), http.StatusBadRequest, codeBadQuery)
	expect(t, env.do("GET", "/v1/blocks?status=ended&limit=10", nil, env.app()), http.StatusOK, "")
	expect(t, env.do("GET", "/v1/events?waitMs=26000", nil, env.app()), http.StatusBadRequest, codeBadQuery)
	expect(t, env.do("GET", "/v1/events?after=%zz", nil, env.app()), http.StatusBadRequest, codeBadQuery)
	expect(t, env.do("GET", "/v1/emergency/preview?blockIds=blk_a,,blk_b", nil, env.app()), http.StatusBadRequest, codeBadQuery)
	expect(t, env.do("GET", "/v1/emergency/preview", nil, env.app()), http.StatusOK, "")
}

// TestEngineNotReady: while the engine starts every route answers 503 read_only.
func TestEngineNotReady(t *testing.T) {
	s, err := New(Options{Engine: notReadyEngine{Engine: nil}, DataDir: t.TempDir(), Config: &Config{}})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/v1/health", "/v1/state"} {
		req := httptest.NewRequest("GET", path, nil)
		req.Host = fmt.Sprintf("127.0.0.1:%d", s.port.Load())
		w := httptest.NewRecorder()
		s.ServeHTTP(w, req)
		r := response{status: w.Code, header: w.Header(), body: w.Body.Bytes()}
		expect(t, r, http.StatusServiceUnavailable, codeReadOnly)
		if r.errDetails()["reason"] != reasonStarting {
			t.Fatalf("details = %v", r.errDetails())
		}
	}
}

// notReadyEngine never finishes its startup.
type notReadyEngine struct {
	Engine
}

func (notReadyEngine) Ready() <-chan struct{} { return make(chan struct{}) }
func (notReadyEngine) OpenErr() error         { return nil }

// TestFrozenModeRefusesWritesBeforeTheBody: step 6 runs before the body is read.
func TestFrozenModeRefusesWritesBeforeTheBody(t *testing.T) {
	env := newTestEnv(t)
	frozen := engine.ModeGuardianFrozen
	env.srv.mode.Store(&frozen)
	r := env.do("POST", "/v1/blocks", "{not json", env.app())
	expect(t, r, http.StatusServiceUnavailable, codeReadOnly)
	if r.errDetails()["reason"] != "schema_too_new" {
		t.Fatalf("details = %v", r.errDetails())
	}
	expect(t, env.do("GET", "/v1/points", nil, env.app()), http.StatusOK, "")
	safe := engine.ModeGuardianSafe
	env.srv.mode.Store(&safe)
	r = env.do("PUT", "/v1/settings", "{}", env.app())
	expect(t, r, http.StatusServiceUnavailable, codeReadOnly)
	if r.errDetails()["reason"] != "safe_mode" {
		t.Fatalf("details = %v", r.errDetails())
	}
	// Health refreshes the cached mode from the engine (normal here).
	expect(t, env.do("GET", "/v1/health", nil), http.StatusOK, "")
	expect(t, env.do("POST", "/v1/blocks", blockBody(30), env.app()), http.StatusCreated, "")
}

func TestContextErrorsAreReadOnly(t *testing.T) {
	c := &call{s: &Server{}, w: &statusWriter{ResponseWriter: httptest.NewRecorder()}}
	c.s.log = discardLogger()
	c.fail(context.Canceled)
	if c.w.status != http.StatusServiceUnavailable || c.errCode != codeReadOnly {
		t.Fatalf("got %d %q", c.w.status, c.errCode)
	}
}
