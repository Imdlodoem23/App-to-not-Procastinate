package engine

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// Pairing tests (docs/ARCHITECTURE.md §9.3, §8.8 «Pairing», «POST /v1/ext/heartbeat»,
// §10.8 «Browsers without the extension»). Helpers are prefixed pair.

const pairOrigin = "chrome-extension://dlabilkpafinafimngfclcfmeghilcah"

// pairPeer is a verified browser peer of the family (as the API layer reports it).
func pairPeer(family string) PairingPeer { return PairingPeer{Origin: pairOrigin, PeerFamily: family} }

func pairClaimReq(code, family string) PairingClaimRequest {
	return PairingClaimRequest{Code: code, Browser: family, BrowserVersion: "131.0.6778.86", ExtVersion: "0.1.0"}
}

// pairCode asks for a new pairing code.
func pairCode(t *testing.T, env *testEnv) PairingCodeResponse {
	t.Helper()
	c, err := env.e.CreatePairingCode(bg, Request{Scope: scopeApp})
	if err != nil {
		t.Fatalf("CreatePairingCode: %v", err)
	}
	return c
}

// pairExt pairs an extension of the family and returns the claim response.
func pairExt(t *testing.T, env *testEnv, family string) PairingClaimResponse {
	t.Helper()
	c := pairCode(t, env)
	res, err := env.e.ClaimPairing(bg, pairPeer(family), pairClaimReq(c.Code, family))
	if err != nil {
		t.Fatalf("ClaimPairing: %v", err)
	}
	return res
}

// pairFile reads secret/extensions.json.
func pairFile(t *testing.T, env *testEnv) extensionsFile {
	t.Helper()
	var f extensionsFile
	raw, err := os.ReadFile(filepath.Join(env.dir, secretDirName, extensionsFileName))
	if err != nil {
		if os.IsNotExist(err) {
			return f
		}
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("extensions.json: %v", err)
	}
	return f
}

// pairHeartbeat sends a protecting heartbeat applying the version.
func pairHeartbeat(env *testEnv, id, family string, applied int64) (ExtHeartbeatResponse, error) {
	return env.e.ExtHeartbeat(bg, Request{Scope: scopeExt, ExtensionID: id}, pairPeer(family), ExtHeartbeatRequest{
		ExtVersion: "0.1.1", Browser: family, BrowserVersion: "131.0", IncognitoAllowed: true, HostPermission: true,
		AppliedExtRulesVersion: applied,
	})
}

func pairStatus(t *testing.T, env *testEnv, id string) ExtensionStatus {
	t.Helper()
	for _, s := range env.state().Protection.Extensions {
		if s.ID == id {
			return s
		}
	}
	t.Fatalf("extension %s not in the state", id)
	return ExtensionStatus{}
}

// pairParseKey decodes a rulesPublicKey.
func pairParseKey(t *testing.T, s string) *ecdsa.PublicKey {
	t.Helper()
	der, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		t.Fatalf("rulesPublicKey is not base64url: %v", err)
	}
	k, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		t.Fatalf("rulesPublicKey is not SPKI: %v", err)
	}
	pub, ok := k.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		t.Fatalf("rulesPublicKey is %T, not P-256", k)
	}
	return pub
}

func TestPairingCodeAndClaim(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	c := pairCode(t, env)
	if len(c.Code) != pairingCodeDigits || strings.Trim(c.Code, "0123456789") != "" || c.Port != e.o.Port ||
		c.ExpiresAt != e.display(e.now+int64(limits().PairingCodeTTLMs)) {
		t.Fatalf("code %+v", c)
	}
	res, err := e.ClaimPairing(bg, pairPeer("chrome"), pairClaimReq(c.Code, "chrome"))
	if err != nil {
		t.Fatalf("ClaimPairing: %v", err)
	}
	if !strings.HasPrefix(res.ExtensionID, "ext_") || !strings.HasPrefix(res.Token, extTokenPrefix) || len(res.Token) < 40 ||
		res.GuardianVersion != e.o.Version || res.BoundOrigin == nil || *res.BoundOrigin != pairOrigin {
		t.Fatalf("claim %+v", res)
	}
	pairParseKey(t, res.RulesPublicKey)
	if pub, err := e.RulesPublicKey(bg); err != nil || pub != res.RulesPublicKey {
		t.Fatalf("RulesPublicKey %q %v", pub, err)
	}
	ev := env.eventsOf(EvExtensionPaired)
	if len(ev) != 1 {
		t.Fatalf("%d extension_paired", len(ev))
	}
	if d := mustDecode[ExtensionPairedData](t, ev[0]); d.ExtensionID != res.ExtensionID || d.Browser != "chrome" || d.BoundOrigin == nil || *d.BoundOrigin != pairOrigin {
		t.Fatalf("extension_paired %+v", d)
	}
	for _, x := range env.events() {
		if strings.Contains(string(x.Data), res.Token) {
			t.Fatal("the token reached the event log")
		}
	}
	// Only the token's digest is stored, in a file only administrators read.
	path := filepath.Join(env.dir, secretDirName, extensionsFileName)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	f := pairFile(t, env)
	if strings.Contains(string(raw), res.Token) || f.SchemaVersion != 1 || len(f.Extensions) != 1 ||
		f.Extensions[0].SHA256 != tokenDigest(res.Token) || f.Extensions[0].ID != res.ExtensionID || f.Extensions[0].Browser != "chrome" {
		t.Fatalf("extensions.json %s", raw)
	}
	if runtime.GOOS != "windows" {
		if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
			t.Fatalf("extensions.json mode %v %v", fi.Mode(), err)
		}
	}
	// The code is single use.
	if _, err := e.ClaimPairing(bg, pairPeer("chrome"), pairClaimReq(c.Code, "chrome")); apiCode(err) != "pairing_no_code" {
		t.Fatalf("second claim: %v", err)
	}
	// The token authenticates; anything else does not.
	a, ok := e.AuthenticateExtension(bg, res.Token)
	if !ok || a.ExtensionID != res.ExtensionID || a.Browser != "chrome" || a.BoundOrigin != pairOrigin {
		t.Fatalf("AuthenticateExtension %+v %v", a, ok)
	}
	for _, bad := range []string{"", "cte_", res.Token + "x", strings.TrimPrefix(res.Token, extTokenPrefix), "cta_" + res.Token[4:]} {
		if _, ok := e.AuthenticateExtension(bg, bad); ok {
			t.Fatalf("token %q authenticated", bad)
		}
	}
	list, err := e.ListExtensions(bg)
	if err != nil || len(list.Extensions) != 1 {
		t.Fatalf("ListExtensions %+v %v", list, err)
	}
	p := list.Extensions[0]
	if p.ID != res.ExtensionID || p.Browser != "chrome" || p.ExtVersion != "0.1.0" || p.PairedAt != e.display(e.now) ||
		p.LastSeenAt != nil || p.BoundOrigin == nil || *p.BoundOrigin != pairOrigin {
		t.Fatalf("paired extension %+v", p)
	}
	// Not connected until the first heartbeat.
	if s := pairStatus(t, env, res.ExtensionID); s.Connected || s.Protecting || s.LastSeenAt != nil {
		t.Fatalf("status before a heartbeat %+v", s)
	}
	// Without an Origin the token is not bound.
	c = pairCode(t, env)
	res2, err := e.ClaimPairing(bg, PairingPeer{PeerFamily: "firefox"}, pairClaimReq(c.Code, "firefox"))
	if err != nil || res2.BoundOrigin != nil {
		t.Fatalf("claim without Origin %+v %v", res2, err)
	}
	if a, ok := e.AuthenticateExtension(bg, res2.Token); !ok || a.BoundOrigin != "" || a.Browser != "firefox" {
		t.Fatalf("unbound token %+v", a)
	}
}

func TestPairingCodeFailuresAndExpiry(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	claim := func(code string) error {
		_, err := e.ClaimPairing(bg, pairPeer("chrome"), pairClaimReq(code, "chrome"))
		return err
	}
	if err := claim("123456"); apiCode(err) != "pairing_no_code" {
		t.Fatalf("without a code: %v", err)
	}
	c := pairCode(t, env).Code
	wrong := "000000"
	if wrong == c {
		wrong = "000001"
	}
	for i := 1; i <= limits().PairingMaxFailures; i++ {
		if err := claim(wrong); apiCode(err) != "pairing_code_invalid" {
			t.Fatalf("failure %d: %v", i, err)
		}
	}
	if err := claim(c); apiCode(err) != "pairing_no_code" {
		t.Fatalf("the code survived %d failures: %v", limits().PairingMaxFailures, err)
	}
	// Four failures leave it usable.
	c = pairCode(t, env).Code
	wrong = "999999"
	if wrong == c {
		wrong = "999998"
	}
	for range limits().PairingMaxFailures - 1 {
		_ = claim(wrong)
	}
	if err := claim(c); err != nil {
		t.Fatalf("after %d failures: %v", limits().PairingMaxFailures-1, err)
	}
	// Expiry after the TTL.
	c = pairCode(t, env).Code
	env.clk.Advance(time.Duration(limits().PairingCodeTTLMs) * time.Millisecond)
	e.Step()
	if err := claim(c); apiCode(err) != "pairing_code_expired" {
		t.Fatalf("expired code: %v", err)
	}
	// A new code replaces the previous one.
	first := pairCode(t, env).Code
	second := pairCode(t, env).Code
	for second == first {
		second = pairCode(t, env).Code
	}
	if err := claim(first); apiCode(err) != "pairing_code_invalid" {
		t.Fatalf("replaced code: %v", err)
	}
	if err := claim(second); err != nil {
		t.Fatalf("new code: %v", err)
	}
	// Shape errors (422) before anything else.
	pairCode(t, env)
	for _, c := range []struct {
		req  PairingClaimRequest
		path string
	}{
		{pairClaimReq("12345", "chrome"), "code"},
		{pairClaimReq("12345a", "chrome"), "code"},
		{pairClaimReq("123456", "netscape"), "browser"},
		{PairingClaimRequest{Code: "123456", Browser: "chrome", BrowserVersion: "", ExtVersion: "1"}, "browserVersion"},
		{PairingClaimRequest{Code: "123456", Browser: "chrome", BrowserVersion: "1", ExtVersion: "1 0"}, "extVersion"},
	} {
		_, err := e.ClaimPairing(bg, pairPeer("chrome"), c.req)
		if apiCode(err) != "validation_failed" || apiDetails(err)["path"] != c.path {
			t.Fatalf("%+v: %v %v", c.req, err, apiDetails(err))
		}
	}
}

// The loopback peer must be a browser of the claimed family (§9.3): a program that read
// client.json and asked for a code cannot pair. Peer failures never consume the code.
func TestPairingPeerCheck(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	c := pairCode(t, env).Code
	for _, peer := range []PairingPeer{
		{Origin: pairOrigin},
		{Origin: pairOrigin, PeerFamily: "firefox"},
		{Origin: pairOrigin, PeerProcess: "curl"},
	} {
		_, err := e.ClaimPairing(bg, peer, pairClaimReq(c, "chrome"))
		if apiCode(err) != "insufficient_scope" || apiDetails(err)["reason"] != "peer_not_browser" {
			t.Fatalf("peer %+v: %v", peer, err)
		}
	}
	if _, err := e.ClaimPairing(bg, PairingPeer{Origin: "https://evil.example", PeerFamily: "chrome"}, pairClaimReq(c, "chrome")); apiCode(err) != "origin_not_allowed" {
		t.Fatalf("web origin: %v", err)
	}
	// The peer's executable maps to every family that runs as it (chrome.exe is Chrome
	// or Chromium on Windows).
	var proc string
	var families []string
	for _, b := range e.cat.Browsers() {
		if names := b.Processes.For(string(e.platform)); len(names) > 0 && b.ExtensionFamily != "other" {
			proc = names[0]
			for _, x := range e.cat.BrowsersForProcess(proc, e.platform) {
				families = append(families, x.ExtensionFamily)
			}
			break
		}
	}
	if proc == "" {
		t.Skip("no browser executable on this platform")
	}
	for _, fam := range families {
		c := pairCode(t, env).Code
		res, err := e.ClaimPairing(bg, PairingPeer{PeerProcess: proc}, pairClaimReq(c, fam))
		if err != nil {
			t.Fatalf("peer %s claiming %s: %v", proc, fam, err)
		}
		if a, ok := e.AuthenticateExtension(bg, res.Token); !ok || a.Browser != fam {
			t.Fatalf("family %s bound as %+v", fam, a)
		}
	}
	c = pairCode(t, env).Code
	other := "firefox"
	if slices.Contains(families, other) {
		other = "chrome"
	}
	if _, err := e.ClaimPairing(bg, PairingPeer{PeerProcess: proc}, pairClaimReq(c, other)); apiCode(err) != "insufficient_scope" {
		t.Fatalf("peer %s claiming %s: %v", proc, other, err)
	}
}

// At most pairingClaimsPerWindow claims per window, globally (§9.6).
func TestPairingClaimRateLimit(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	l := limits()
	for i := range l.PairingClaimsPerWindow {
		if _, err := e.ClaimPairing(bg, pairPeer("chrome"), pairClaimReq("123456", "chrome")); apiCode(err) != "pairing_no_code" {
			t.Fatalf("claim %d: %v", i, err)
		}
	}
	c := pairCode(t, env).Code
	_, err := e.ClaimPairing(bg, pairPeer("chrome"), pairClaimReq(c, "chrome"))
	if apiCode(err) != "rate_limited" {
		t.Fatalf("claim over the limit: %v", err)
	}
	if ms, ok := apiDetails(err)["retryAfterMs"].(int64); !ok || ms <= 0 || ms > int64(l.PairingClaimWindowMs) {
		t.Fatalf("details %v", apiDetails(err))
	}
	env.clk.Advance(time.Duration(l.PairingClaimWindowMs) * time.Millisecond)
	e.Step()
	c = pairCode(t, env).Code
	if _, err := e.ClaimPairing(bg, pairPeer("chrome"), pairClaimReq(c, "chrome")); err != nil {
		t.Fatalf("after the window: %v", err)
	}
}

func TestPairingRevokeAndPersistence(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	a := pairExt(t, env, "chrome")
	b := pairExt(t, env, "firefox")
	if _, err := pairHeartbeat(env, a.ExtensionID, "chrome", e.state.Versions.ExtRules); err != nil {
		t.Fatal(err)
	}
	// Tokens and pairings survive a restart; so does the rules key.
	e = env.restart()
	for _, x := range []PairingClaimResponse{a, b} {
		if _, ok := e.AuthenticateExtension(bg, x.Token); !ok {
			t.Fatalf("%s lost across a restart", x.ExtensionID)
		}
	}
	if pub, _ := e.RulesPublicKey(bg); pub != a.RulesPublicKey {
		t.Fatal("the rules key changed across a restart")
	}
	if s := pairStatus(t, env, a.ExtensionID); s.LastSeenAt == nil || s.ExtVersion != "0.1.1" {
		t.Fatalf("heartbeat lost across a restart %+v", s)
	}
	if err := e.RevokeExtension(bg, Request{Scope: scopeApp}, a.ExtensionID); err != nil {
		t.Fatalf("RevokeExtension: %v", err)
	}
	if _, ok := e.AuthenticateExtension(bg, a.Token); ok {
		t.Fatal("a revoked token still authenticates")
	}
	if _, ok := e.AuthenticateExtension(bg, b.Token); !ok {
		t.Fatal("revoking one extension revoked another")
	}
	ev := env.eventsOf(EvExtensionRevoked)
	if len(ev) != 1 || mustDecode[ExtensionRevokedData](t, ev[0]).ExtensionID != a.ExtensionID {
		t.Fatalf("extension_revoked %v", types(ev))
	}
	if f := pairFile(t, env); len(f.Extensions) != 1 || f.Extensions[0].ID != b.ExtensionID {
		t.Fatalf("extensions.json %+v", f)
	}
	if list, _ := e.ListExtensions(bg); len(list.Extensions) != 1 || list.Extensions[0].ID != b.ExtensionID {
		t.Fatalf("list %+v", list)
	}
	if _, ok := e.state.Pairing.Extensions[a.ExtensionID]; ok {
		t.Fatal("heartbeat record of a revoked extension kept")
	}
	if err := e.RevokeExtension(bg, Request{Scope: scopeApp}, a.ExtensionID); apiCode(err) != "not_found" {
		t.Fatalf("revoke twice: %v", err)
	}
	if _, err := pairHeartbeat(env, a.ExtensionID, "chrome", 0); apiCode(err) != "unauthorized" {
		t.Fatalf("heartbeat of a revoked extension: %v", err)
	}
	// Rebuilt from the log (state files lost), the revoked extension stays gone.
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"state.json", "state.prev.json"} {
		_ = os.Remove(filepath.Join(env.dir, n))
	}
	e = env.open()
	if _, ok := e.AuthenticateExtension(bg, a.Token); ok {
		t.Fatal("revoked token back after a rebuild")
	}
	if _, ok := e.state.Pairing.Extensions[b.ExtensionID]; !ok {
		t.Fatal("the rebuild lost the paired extension's record")
	}
}

// A failed append changes nothing (§8.1): the pairing or revocation is undone in
// secret/extensions.json and the code stays usable.
func TestPairingCommitFailure(t *testing.T) {
	env := newTestEnv(t)
	ffs := newFaultFS()
	env.fs = ffs
	e := env.open()
	kept := pairExt(t, env, "chrome")
	c := pairCode(t, env).Code
	ffs.setFailAppend(true)
	if _, err := e.ClaimPairing(bg, pairPeer("edge"), pairClaimReq(c, "edge")); apiCode(err) != "read_only" {
		t.Fatalf("claim with a failing log: %v", err)
	}
	if f := pairFile(t, env); len(f.Extensions) != 1 || f.Extensions[0].ID != kept.ExtensionID {
		t.Fatalf("extensions.json after a failed claim %+v", f)
	}
	if err := e.RevokeExtension(bg, Request{Scope: scopeApp}, kept.ExtensionID); apiCode(err) != "read_only" {
		t.Fatalf("revoke with a failing log: %v", err)
	}
	if _, ok := e.AuthenticateExtension(bg, kept.Token); !ok || len(pairFile(t, env).Extensions) != 1 {
		t.Fatal("a failed revocation revoked")
	}
	ffs.setFailAppend(false)
	if _, err := e.ClaimPairing(bg, pairPeer("edge"), pairClaimReq(c, "edge")); err != nil {
		t.Fatalf("the code did not survive the failure: %v", err)
	}
	if n := len(pairFile(t, env).Extensions); n != 2 {
		t.Fatalf("%d extensions", n)
	}
}

// Pairing beyond the list cap drops the stalest extension in the same batch.
func TestPairingCap(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	first := pairExt(t, env, "chrome")
	fresh := pairExt(t, env, "firefox")
	if _, err := pairHeartbeat(env, first.ExtensionID, "chrome", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := pairHeartbeat(env, fresh.ExtensionID, "firefox", 0); err != nil {
		t.Fatal(err)
	}
	var never string
	_ = e.exec(bg, func() {
		m := e.pairingMem()
		for len(m.exts) < maxPairedExtensions {
			x := extEntry{ID: newID("ext"), SHA256: tokenDigest(newExtensionToken()), Browser: "edge", PairedAt: fmtMs(e.now), ExtVersion: "1"}
			if never == "" {
				never = x.ID
			}
			m.exts = append(m.exts, x)
		}
		if err := e.writeExtensions(m.exts); err != nil {
			t.Error(err)
		}
	})
	res := pairExt(t, env, "brave")
	list, _ := e.ListExtensions(bg)
	ids := make([]string, 0, len(list.Extensions))
	for _, x := range list.Extensions {
		ids = append(ids, x.ID)
	}
	if len(ids) != maxPairedExtensions || slices.Contains(ids, never) || !slices.Contains(ids, res.ExtensionID) ||
		!slices.Contains(ids, first.ExtensionID) || !slices.Contains(ids, fresh.ExtensionID) {
		t.Fatalf("%d extensions after the cap; stalest kept: %v", len(ids), slices.Contains(ids, never))
	}
	rev := env.eventsOf(EvExtensionRevoked)
	if len(rev) != 1 || mustDecode[ExtensionRevokedData](t, rev[0]).ExtensionID != never {
		t.Fatalf("revocations %v", types(rev))
	}
}

// Heartbeats: family binding, peer check, and the connected/protecting status (§8.8).
func TestExtHeartbeat(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	x := pairExt(t, env, "chrome")
	r := Request{Scope: scopeExt, ExtensionID: x.ExtensionID}
	v := e.state.Versions.ExtRules
	res, err := pairHeartbeat(env, x.ExtensionID, "chrome", v)
	if err != nil || res.ExtRulesVersion != v || res.ServerNow != e.serverNow() {
		t.Fatalf("heartbeat %+v %v", res, err)
	}
	s := pairStatus(t, env, x.ExtensionID)
	if !s.Connected || !s.Protecting || s.LastSeenAt == nil || *s.LastSeenAt != e.display(e.now) || s.ExtVersion != "0.1.1" ||
		!s.HostPermission || !s.IncognitoAllowed || s.AppliedExtRulesVersion != v || s.Browser != "chrome" {
		t.Fatalf("status %+v", s)
	}
	if list, _ := e.ListExtensions(bg); list.Extensions[0].LastSeenAt == nil || list.Extensions[0].ExtVersion != "0.1.1" {
		t.Fatalf("list after a heartbeat %+v", list.Extensions[0])
	}
	if d, _ := e.Diagnostics(bg); len(d.Extensions) != 1 || !d.Extensions[0].Protecting {
		t.Fatalf("diagnostics %+v", d.Extensions)
	}
	good := ExtHeartbeatRequest{ExtVersion: "0.1.1", Browser: "chrome", BrowserVersion: "131", IncognitoAllowed: true, HostPermission: true, AppliedExtRulesVersion: v}
	for _, c := range []struct {
		name   string
		r      Request
		peer   PairingPeer
		mod    func(*ExtHeartbeatRequest)
		code   string
		reason string
	}{
		{"another family", r, pairPeer("chrome"), func(q *ExtHeartbeatRequest) { q.Browser = "edge" }, "insufficient_scope", "browser_mismatch"},
		{"not a browser", r, PairingPeer{Origin: pairOrigin}, nil, "insufficient_scope", "peer_not_browser"},
		{"peer of another family", r, pairPeer("firefox"), nil, "insufficient_scope", "peer_not_browser"},
		{"other origin", r, PairingPeer{Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", PeerFamily: "chrome"}, nil, "origin_not_allowed", ""},
		{"app token", Request{Scope: scopeApp}, pairPeer("chrome"), nil, "insufficient_scope", ""},
		{"unknown extension", Request{Scope: scopeExt, ExtensionID: "ext_unknown"}, pairPeer("chrome"), nil, "unauthorized", ""},
		{"bad version", r, pairPeer("chrome"), func(q *ExtHeartbeatRequest) { q.ExtVersion = "" }, "validation_failed", ""},
		{"negative applied version", r, pairPeer("chrome"), func(q *ExtHeartbeatRequest) { q.AppliedExtRulesVersion = -1 }, "validation_failed", ""},
	} {
		q := good
		if c.mod != nil {
			c.mod(&q)
		}
		_, err := e.ExtHeartbeat(bg, c.r, c.peer, q)
		if apiCode(err) != c.code || (c.reason != "" && apiDetails(err)["reason"] != c.reason) {
			t.Fatalf("%s: %v %v", c.name, err, apiDetails(err))
		}
	}
	// Without host permission or incognito access it is connected but not protecting.
	for _, mod := range []func(*ExtHeartbeatRequest){
		func(q *ExtHeartbeatRequest) { q.HostPermission = false },
		func(q *ExtHeartbeatRequest) { q.IncognitoAllowed = false },
	} {
		q := good
		mod(&q)
		if _, err := e.ExtHeartbeat(bg, r, pairPeer("chrome"), q); err != nil {
			t.Fatal(err)
		}
		if s := pairStatus(t, env, x.ExtensionID); !s.Connected || s.Protecting {
			t.Fatalf("status %+v", s)
		}
	}
	// New rules: the previous version still counts for extRulesCurrentGraceMs.
	if _, err := pairHeartbeat(env, x.ExtensionID, "chrome", v); err != nil {
		t.Fatal(err)
	}
	env.create(durationReq(ModeStrict, 60, "youtube"))
	if e.state.Versions.ExtRules == v {
		t.Fatal("extRulesVersion did not change with a new block")
	}
	if s := pairStatus(t, env, x.ExtensionID); !s.Protecting {
		t.Fatalf("within the grace %+v", s)
	}
	env.clk.Advance(time.Duration(limits().ExtRulesCurrentGraceMs) * time.Millisecond)
	e.Step()
	if _, err := pairHeartbeat(env, x.ExtensionID, "chrome", v); err != nil {
		t.Fatal(err)
	}
	if s := pairStatus(t, env, x.ExtensionID); !s.Connected || s.Protecting {
		t.Fatalf("stale rules after the grace %+v", s)
	}
	if _, err := pairHeartbeat(env, x.ExtensionID, "chrome", e.state.Versions.ExtRules); err != nil {
		t.Fatal(err)
	}
	if s := pairStatus(t, env, x.ExtensionID); !s.Protecting {
		t.Fatalf("current rules %+v", s)
	}
	// Silent for extConnectedWindowMs: disconnected.
	env.clk.Advance(time.Duration(limits().ExtConnectedWindowMs) * time.Millisecond)
	e.Step()
	if s := pairStatus(t, env, x.ExtensionID); s.Connected || s.Protecting || s.LastSeenAt == nil {
		t.Fatalf("after silence %+v", s)
	}
}

// Browser families running for more than the grace without a protecting extension are
// listed (§10.8).
func TestBrowsersWithoutExtension(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	var proc, family string
	for _, b := range e.cat.Browsers() {
		if names := b.Processes.For(string(e.platform)); len(names) > 0 && b.ExtensionFamily != "other" {
			proc, family = names[0], e.cat.BrowsersForProcess(names[0], e.platform)[0].ExtensionFamily
			break
		}
	}
	if proc == "" {
		t.Skip("no browser executable on this platform")
	}
	env.procs.Start("some-editor")
	pid := env.procs.Start(proc)
	if got := env.state().Protection.BrowsersWithoutExtension; len(got) != 0 {
		t.Fatalf("at once: %v", got)
	}
	grace := time.Duration(limits().BrowserWithoutExtensionGraceMs) * time.Millisecond
	env.clk.Advance(grace / 2)
	e.Step()
	if got := env.state().Protection.BrowsersWithoutExtension; len(got) != 0 {
		t.Fatalf("within the grace: %v", got)
	}
	env.clk.Advance(grace / 2)
	e.Step()
	if got := env.state().Protection.BrowsersWithoutExtension; !slices.Equal(got, []string{family}) {
		t.Fatalf("after the grace: %v, want [%s]", got, family)
	}
	// A protecting extension of that family spares it.
	x := pairExt(t, env, family)
	if _, err := pairHeartbeat(env, x.ExtensionID, family, e.state.Versions.ExtRules); err != nil {
		t.Fatal(err)
	}
	if got := env.state().Protection.BrowsersWithoutExtension; len(got) != 0 {
		t.Fatalf("with a protecting extension: %v", got)
	}
	// Closed browsers leave the list after the next scan.
	if err := env.procs.Kill(pid, proc); err != nil {
		t.Fatal(err)
	}
	env.clk.Advance(browserScanEvery)
	e.Step()
	_ = env.state()
	if m := e.state.Pairing.mem; m == nil || len(m.running) != 0 {
		t.Fatalf("running browsers after the close: %+v", m.running)
	}
}

// A newer secret/extensions.json is read but never rewritten; an unreadable one counts
// as empty (the extensions pair again).
func TestPairingExtensionsFileSchema(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	token := newExtensionToken()
	newer := `{"schemaVersion":2,"extensions":[{"id":"ext_0123456789012345678901","sha256":"` + tokenDigest(token) +
		`","boundOrigin":null,"browser":"firefox","pairedAt":"2026-09-28T09:00:00.000Z","extVersion":"2.0","profile":"x"}],"extra":1}`
	path := filepath.Join(env.dir, secretDirName, extensionsFileName)
	if err := os.WriteFile(path, []byte(newer), 0o600); err != nil {
		t.Fatal(err)
	}
	e = env.open()
	if a, ok := e.AuthenticateExtension(bg, token); !ok || a.Browser != "firefox" {
		t.Fatalf("newer file not read: %+v", a)
	}
	c := pairCode(t, env).Code
	if _, err := e.ClaimPairing(bg, pairPeer("chrome"), pairClaimReq(c, "chrome")); apiCode(err) != "read_only" || apiDetails(err)["reason"] != "schema_too_new" {
		t.Fatalf("claim with a newer file: %v", err)
	}
	if err := e.RevokeExtension(bg, Request{Scope: scopeApp}, "ext_0123456789012345678901"); apiCode(err) != "read_only" {
		t.Fatalf("revoke with a newer file: %v", err)
	}
	if raw, _ := os.ReadFile(path); string(raw) != newer {
		t.Fatal("a newer extensions.json was rewritten")
	}
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	e = env.open()
	if list, err := e.ListExtensions(bg); err != nil || len(list.Extensions) != 0 {
		t.Fatalf("unreadable file: %+v %v", list, err)
	}
	if _, ok := e.AuthenticateExtension(bg, token); ok {
		t.Fatal("a token authenticated from an unreadable file")
	}
	d, _ := e.Diagnostics(bg)
	if !slices.ContainsFunc(d.Errors, func(x DiagnosticsError) bool { return x.Code == "extensions_read" }) {
		t.Fatalf("diagnostics errors %+v", d.Errors)
	}
	// Pairing again rewrites it.
	pairExt(t, env, "chrome")
	if f := pairFile(t, env); f.SchemaVersion != 1 || len(f.Extensions) != 1 {
		t.Fatalf("rewritten file %+v", f)
	}
}
