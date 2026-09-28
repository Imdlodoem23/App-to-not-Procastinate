package engine

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// Extension rules tests (docs/ARCHITECTURE.md §8.8 «GET /v1/ext/rules», §8.5, §10.10).
// Helpers are prefixed xr.

const xrNonce = "q3Jd0W3y8kqj3n7mW2Wm8A"

// xrGet fetches the rules without waiting and fails the test on an error.
func xrGet(t *testing.T, env *testEnv, x PairingClaimResponse, nonce string) SignedExtRules {
	t.Helper()
	s, err := env.e.GetExtRules(bg, Request{Scope: scopeExt, ExtensionID: x.ExtensionID}, ExtRulesQuery{Nonce: nonce})
	if err != nil {
		t.Fatalf("GetExtRules: %v", err)
	}
	return s
}

// xrVerify checks the signature header over the exact body, like verifyRulesSignature.
func xrVerify(t *testing.T, pub *ecdsa.PublicKey, body []byte, header string) bool {
	t.Helper()
	enc, ok := strings.CutPrefix(header, "v1=")
	if !ok {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil || len(sig) != 64 {
		return false
	}
	digest := sha256.Sum256(body)
	return ecdsa.Verify(pub, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:]))
}

func xrDecode(t *testing.T, s SignedExtRules) ExtRulesResponse {
	t.Helper()
	var r ExtRulesResponse
	if err := json.Unmarshal(s.Body, &r); err != nil {
		t.Fatalf("rules body: %v", err)
	}
	return r
}

func TestExtRulesSignedPayload(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	x := pairExt(t, env, "chrome")
	pub := pairParseKey(t, x.RulesPublicKey)

	// Without blocks: empty lists, nulls, signed.
	s := xrGet(t, env, x, xrNonce)
	if !xrVerify(t, pub, s.Body, s.Signature) {
		t.Fatal("empty rules not signed")
	}
	for _, frag := range []string{`"blockDomains":[]`, `"excludedDomains":[]`, `"whitelist":null`, `"blocks":[]`, `"allowances":[]`,
		`"punishment":null`, `"nextChangeAt":null`, `"nonce":"` + xrNonce + `"`} {
		if !strings.Contains(string(s.Body), frag) {
			t.Fatalf("empty rules lack %s: %s", frag, s.Body)
		}
	}

	yt := env.create(durationReq(ModeStrict, 90, "youtube"))
	custom := durationReq(ModeNormal, 30)
	custom.Targets.CustomDomains = []string{"example.org"}
	cb := env.create(custom)
	s = xrGet(t, env, x, xrNonce)
	if !xrVerify(t, pub, s.Body, s.Signature) {
		t.Fatal("signature does not verify")
	}
	r := xrDecode(t, s)
	if r.ExtRulesVersion != s.Version || s.Version != e.state.Versions.ExtRules || r.Nonce != xrNonce || r.ServerNow != e.serverNow() {
		t.Fatalf("header fields %+v (version %d)", r, s.Version)
	}
	if !slices.Equal(r.BlockDomains, e.enf.BlockDomains) || !slices.Contains(r.BlockDomains, "youtube.com") ||
		!slices.Contains(r.BlockDomains, "www.example.org") || !slices.Equal(r.ExcludedDomains, e.enf.ExcludedDomains) {
		t.Fatalf("domains %v / %v", r.BlockDomains, r.ExcludedDomains)
	}
	for _, h := range e.cat.AlwaysAllowedHosts() {
		if slices.Contains(r.BlockDomains, h) {
			t.Fatalf("always-allowed %s in blockDomains", h)
		}
	}
	if r.Whitelist != nil || r.Punishment != nil || len(r.Allowances) != 0 || !r.PenaltiesEnabled {
		t.Fatalf("rules %+v", r)
	}
	if len(r.Blocks) != 2 || r.Blocks[0].ID != yt.ID || r.Blocks[1].ID != cb.ID {
		t.Fatalf("blocks %+v", r.Blocks)
	}
	b0 := r.Blocks[0]
	if b0.Kind != KindManual || b0.Mode != ModeStrict || b0.EndsAt != yt.EndsAt || !slices.Equal(b0.ServiceIDs, []string{"youtube"}) ||
		!slices.Equal(b0.Domains, e.block(yt.ID).Resolved.Domains) || b0.WhitelistOnly {
		t.Fatalf("block entry %+v", b0)
	}
	if r.NextChangeAt == nil || *r.NextChangeAt != cb.EndsAt {
		t.Fatalf("nextChangeAt %v, want %s", r.NextChangeAt, cb.EndsAt)
	}
	// Any change to the body breaks the signature; the nonce is inside the signed body.
	tampered := slices.Clone(s.Body)
	tampered[len(tampered)/2] ^= 1
	if xrVerify(t, pub, tampered, s.Signature) {
		t.Fatal("a tampered body verifies")
	}
	other := xrGet(t, env, x, "AAAAAAAAAAAAAAAAAAAAAA")
	if xrDecode(t, other).Nonce != "AAAAAAAAAAAAAAAAAAAAAA" || !xrVerify(t, pub, other.Body, other.Signature) || xrVerify(t, pub, other.Body, s.Signature) {
		t.Fatal("nonce echo or per-body signature broken")
	}
	// Penalties off shows in the payload and bumps the version.
	v := s.Version
	_ = e.exec(bg, func() { e.state.Settings.AttemptPenalties = false; e.enfDirty = true })
	if r := xrDecode(t, xrGet(t, env, x, xrNonce)); r.PenaltiesEnabled || r.ExtRulesVersion <= v {
		t.Fatalf("penalties off %+v", r)
	}
}

// Whitelist blocks, allowances and punishments in the payload.
func TestExtRulesWhitelistAllowancesPunishments(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	x := pairExt(t, env, "firefox")
	env.create(durationReq(ModeNormal, 120, "youtube", "instagram"))
	_ = e.exec(bg, func() { e.state.Ledger.Balance += 1000; e.markDirty(true) })
	red, err := e.RedeemReward(bg, Request{Scope: scopeApp}, RedeemRewardRequest{OfferID: "youtube-15"})
	if err != nil {
		t.Fatalf("RedeemReward: %v", err)
	}
	r := xrDecode(t, xrGet(t, env, x, xrNonce))
	if len(r.Allowances) != 1 || r.Allowances[0].ServiceID != "youtube" || r.Allowances[0].EndsAt != red.Allowance.EndsAt {
		t.Fatalf("allowances %+v", r.Allowances)
	}
	if slices.Contains(r.BlockDomains, "youtube.com") || !slices.Contains(r.BlockDomains, "instagram.com") {
		t.Fatal("the allowance does not open youtube.com in blockDomains")
	}
	if r.NextChangeAt == nil || *r.NextChangeAt != red.Allowance.EndsAt {
		t.Fatalf("nextChangeAt %v, want the allowance end", r.NextChangeAt)
	}
	wl := durationReq(ModeNormal, 60)
	wl.WhitelistOnly = true
	wl.Allow.CustomDomains = []string{"myuniversity.edu"}
	w := env.create(wl)
	r = xrDecode(t, xrGet(t, env, x, xrNonce))
	if r.Whitelist == nil || !slices.Contains(r.Whitelist.AllowDomains, "myuniversity.edu") ||
		!slices.Contains(r.Whitelist.AllowDomains, e.cat.StudyWhitelistDomains()[0]) || r.Whitelist.AllowHostPatterns == nil {
		t.Fatalf("whitelist %+v", r.Whitelist)
	}
	i := slices.IndexFunc(r.Blocks, func(b ExtRuleBlock) bool { return b.ID == w.ID })
	if i < 0 || !r.Blocks[i].WhitelistOnly || r.Blocks[i].Domains == nil || len(r.Blocks[i].Domains) != 0 {
		t.Fatalf("whitelist block entry %+v", r.Blocks)
	}
	// Punishments stack: the latest end and the strictest level.
	var long, short Punishment
	_ = e.exec(bg, func() {
		e.timeStep()
		b := e.newBatch()
		_, long = e.addPunishmentEvents(b, nil, "mates", "abandoned", PunishmentPolicy{Level: "distractions", Minutes: 90})
		_, short = e.addPunishmentEvents(b, nil, "mates", "abandoned", PunishmentPolicy{Level: "whitelist", Minutes: 30})
		if err := e.commit(b); err != nil {
			t.Error(err)
		}
		e.afterTurn()
	})
	r = xrDecode(t, xrGet(t, env, x, xrNonce))
	if r.Punishment == nil || r.Punishment.Level != "whitelist" || r.Punishment.EndsAt != e.display(e.punishment(long.ID).EndsAt) {
		t.Fatalf("punishment %+v (long %s, short %s)", r.Punishment, long.ID, short.ID)
	}
	if len(r.Allowances) != 0 {
		t.Fatal("a punishment revokes allowances")
	}
}

// extRulesVersion is strictly increasing, also across restarts (§8.5), and the rules
// key stays the same.
func TestExtRulesVersionAcrossRestart(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	x := pairExt(t, env, "chrome")
	v1 := xrGet(t, env, x, xrNonce).Version
	env.create(durationReq(ModeNormal, 30, "youtube"))
	v2 := xrGet(t, env, x, xrNonce).Version
	if v2 <= v1 {
		t.Fatalf("version %d after a change, was %d", v2, v1)
	}
	if again := xrGet(t, env, x, xrNonce).Version; again != v2 {
		t.Fatalf("version moved without a change: %d → %d", v2, again)
	}
	e = env.restart()
	s := xrGet(t, env, x, xrNonce)
	if s.Version <= v2 {
		t.Fatalf("version %d after a restart, was %d", s.Version, v2)
	}
	if !xrVerify(t, pairParseKey(t, x.RulesPublicKey), s.Body, s.Signature) {
		t.Fatal("the rules key changed across a restart")
	}
	raw, err := os.ReadFile(filepath.Join(env.dir, secretDirName, rulesKeyFileName))
	if err != nil {
		t.Fatal(err)
	}
	if blk, _ := pem.Decode(raw); blk == nil || blk.Type != "PRIVATE KEY" {
		t.Fatal("rules.key is not a PKCS#8 PEM key")
	}
	_ = e
}

// A rules.key that is not a P-256 key is replaced (the extensions must pair again).
func TestExtRulesKeyReplacedWhenInvalid(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	x := pairExt(t, env, "chrome")
	if err := env.e.Stop(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(env.dir, secretDirName, rulesKeyFileName), []byte("garbage"), 0o600); err != nil {
		t.Fatal(err)
	}
	e := env.open()
	pub, err := e.RulesPublicKey(bg)
	if err != nil || pub == x.RulesPublicKey {
		t.Fatalf("key not replaced: %v", err)
	}
	s := xrGet(t, env, x, xrNonce)
	if !xrVerify(t, pairParseKey(t, pub), s.Body, s.Signature) {
		t.Fatal("not signed with the new key")
	}
}

func TestExtRulesQueryErrors(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	x := pairExt(t, env, "chrome")
	r := Request{Scope: scopeExt, ExtensionID: x.ExtensionID}
	neg := int64(-1)
	for _, c := range []struct {
		name string
		r    Request
		q    ExtRulesQuery
		code string
	}{
		{"no nonce", r, ExtRulesQuery{}, "bad_query"},
		{"short nonce", r, ExtRulesQuery{Nonce: "abc"}, "bad_query"},
		{"nonce with padding", r, ExtRulesQuery{Nonce: "q3Jd0W3y8kqj3n7mW2Wm8A=="}, "bad_query"},
		{"long nonce", r, ExtRulesQuery{Nonce: strings.Repeat("a", 65)}, "bad_query"},
		{"waitMs over the max", r, ExtRulesQuery{Nonce: xrNonce, WaitMs: limits().LongPollMaxMs + 1}, "bad_query"},
		{"negative waitMs", r, ExtRulesQuery{Nonce: xrNonce, WaitMs: -1}, "bad_query"},
		{"negative waitVersion", r, ExtRulesQuery{Nonce: xrNonce, WaitVersion: &neg}, "bad_query"},
		{"app token", Request{Scope: scopeApp}, ExtRulesQuery{Nonce: xrNonce}, "insufficient_scope"},
		{"unknown extension", Request{Scope: scopeExt, ExtensionID: "ext_nope"}, ExtRulesQuery{Nonce: xrNonce}, "unauthorized"},
	} {
		if _, err := e.GetExtRules(bg, c.r, c.q); apiCode(err) != c.code {
			t.Fatalf("%s: %v, want %s", c.name, err, c.code)
		}
	}
}

// The long poll (§8.5): returns as soon as extRulesVersion differs from waitVersion,
// with the current rules at the timeout, on cancellation, and 401 when the extension
// is revoked meanwhile. It never holds the engine goroutine.
func TestExtRulesLongPoll(t *testing.T) {
	env := newTestEnv(t)
	o := env.options()
	e, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	env.e = e
	if err := e.Start(bg); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Stop() })
	<-e.Ready()
	x := pairExt(t, env, "chrome")
	r := Request{Scope: scopeExt, ExtensionID: x.ExtensionID}
	v := xrGet(t, env, x, xrNonce).Version

	type result struct {
		s   SignedExtRules
		err error
	}
	poll := func(ctx context.Context, wait int64, ms int) <-chan result {
		ch := make(chan result, 1)
		go func() {
			s, err := e.GetExtRules(ctx, r, ExtRulesQuery{Nonce: xrNonce, WaitVersion: &wait, WaitMs: ms})
			ch <- result{s, err}
		}()
		return ch
	}
	// A different waitVersion answers at once.
	select {
	case res := <-poll(bg, v-1, 20_000):
		if res.err != nil || res.s.Version != v {
			t.Fatalf("stale waitVersion: %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a stale waitVersion waited")
	}
	// A change wakes the poll; the engine keeps serving other requests meanwhile.
	ch := poll(bg, v, 20_000)
	time.Sleep(50 * time.Millisecond)
	if _, err := e.Health(bg); err != nil {
		t.Fatal(err)
	}
	select {
	case res := <-ch:
		t.Fatalf("returned without a change: %+v", res)
	default:
	}
	if _, err := e.CreateBlock(bg, Request{Scope: scopeApp}, durationReq(ModeStrict, 30, "youtube")); err != nil {
		t.Fatal(err)
	}
	var nv int64
	select {
	case res := <-ch:
		if res.err != nil || res.s.Version <= v || !slices.Contains(xrDecode(t, res.s).BlockDomains, "youtube.com") {
			t.Fatalf("after a change: %+v", res.err)
		}
		if !xrVerify(t, pairParseKey(t, x.RulesPublicKey), res.s.Body, res.s.Signature) {
			t.Fatal("long-poll answer not signed")
		}
		nv = res.s.Version
	case <-time.After(5 * time.Second):
		t.Fatal("the change did not wake the poll")
	}
	// Timeout: the current rules.
	start := time.Now()
	select {
	case res := <-poll(bg, nv, 100):
		if res.err != nil || res.s.Version != nv || time.Since(start) < 100*time.Millisecond {
			t.Fatalf("timeout answer %+v after %v", res.err, time.Since(start))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the timeout did not end the poll")
	}
	// Cancellation.
	ctx, cancel := context.WithCancel(bg)
	ch = poll(ctx, nv, 20_000)
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case res := <-ch:
		if res.err == nil {
			t.Fatal("a cancelled poll answered")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancellation did not end the poll")
	}
	// Revocation closes the extension's polls with 401.
	ch = poll(bg, nv, 20_000)
	time.Sleep(20 * time.Millisecond)
	if err := e.RevokeExtension(bg, Request{Scope: scopeApp}, x.ExtensionID); err != nil {
		t.Fatal(err)
	}
	select {
	case res := <-ch:
		if apiCode(res.err) != "unauthorized" {
			t.Fatalf("after the revocation: %v", res.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the revocation did not close the poll")
	}
}
