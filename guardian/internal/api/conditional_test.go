package api

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

func TestStateETag(t *testing.T) {
	env := newTestEnv(t)
	r := env.do("GET", "/v1/state", nil, env.app())
	expect(t, r, http.StatusOK, "")
	var st engine.GuardianStateResponse
	r.decode(t, &st)
	etag := r.header.Get("ETag")
	if etag != fmt.Sprintf(`"s-%d"`, st.StateVersion) {
		t.Fatalf("ETag %q for stateVersion %d", etag, st.StateVersion)
	}
	r = env.do("GET", "/v1/state", nil, env.app(), withHeader("If-None-Match", etag))
	if r.status != http.StatusNotModified || len(r.body) != 0 || r.header.Get("ETag") != etag {
		t.Fatalf("conditional: %d %q %q", r.status, r.body, r.header.Get("ETag"))
	}
	for _, v := range []string{`"x", ` + etag, "W/" + etag, "*"} {
		expect(t, env.do("GET", "/v1/state", nil, env.app(), withHeader("If-None-Match", v)), http.StatusNotModified, "")
	}
	env.createBlock(30)
	r = env.do("GET", "/v1/state", nil, env.app(), withHeader("If-None-Match", etag))
	expect(t, r, http.StatusOK, "")
	if r.header.Get("ETag") == etag {
		t.Fatal("the ETag did not change with the state")
	}
}

// verifyRulesSignature checks X-Centrate-Signature like verifyRulesSignature in
// guardian-api.ts: ECDSA P-256 / SHA-256 over the exact body, raw r‖s, base64url.
func verifyRulesSignature(t *testing.T, publicKey string, body []byte, header string) {
	t.Helper()
	der, err := base64.RawURLEncoding.DecodeString(publicKey)
	if err != nil {
		t.Fatalf("public key: %v", err)
	}
	pk, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		t.Fatalf("public key: %v", err)
	}
	sigText, ok := strings.CutPrefix(header, "v1=")
	if !ok {
		t.Fatalf("signature header %q", header)
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigText)
	if err != nil || len(sig) != 64 {
		t.Fatalf("signature: %v (%d bytes)", err, len(sig))
	}
	sum := sha256.Sum256(body)
	r, s := new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])
	if !ecdsa.Verify(pk.(*ecdsa.PublicKey), sum[:], r, s) {
		t.Fatal("the rules signature does not verify")
	}
}

func TestExtRulesSignedETagAndLongPoll(t *testing.T) {
	env := newTestEnv(t)
	ext := env.pair(pinnedOrigin)
	nonce := "q3Jd0W3y8kqj3n7mW2Wm8A"
	r := env.do("GET", "/v1/ext/rules?nonce="+nonce, nil, withToken(ext.token), withOrigin(pinnedOrigin))
	expect(t, r, http.StatusOK, "")
	verifyRulesSignature(t, ext.publicKey, r.body, r.header.Get(headerSignature))
	var rules engine.ExtRulesResponse
	r.decode(t, &rules)
	if rules.Nonce != nonce {
		t.Fatalf("nonce %q", rules.Nonce)
	}
	etag := r.header.Get("ETag")
	if etag != fmt.Sprintf(`"r-%d"`, rules.ExtRulesVersion) {
		t.Fatalf("ETag %q for version %d", etag, rules.ExtRulesVersion)
	}
	if r.header.Get("Access-Control-Allow-Origin") != pinnedOrigin {
		t.Fatal("no CORS header for the extension")
	}
	r = env.do("GET", "/v1/ext/rules?nonce="+nonce, nil, withToken(ext.token), withHeader("If-None-Match", etag))
	if r.status != http.StatusNotModified || len(r.body) != 0 || r.header.Get(headerSignature) != "" {
		t.Fatalf("conditional: %d %q", r.status, r.body)
	}
	expect(t, env.do("GET", "/v1/ext/rules", nil, withToken(ext.token)), http.StatusBadRequest, codeBadQuery)

	// Long poll: it waits while the version is unchanged and wakes on a new block.
	path := fmt.Sprintf("/v1/ext/rules?nonce=%s&waitVersion=%d&waitMs=20000", nonce, rules.ExtRulesVersion)
	done := make(chan response, 1)
	start := time.Now()
	go func() { done <- env.do("GET", path, nil, withToken(ext.token)) }()
	waitFor(t, "the rules long poll", func() bool { return env.srv.polls.inFlight("ext:"+ext.id) == 1 })
	select {
	case r := <-done:
		t.Fatalf("returned before any change: %d %s", r.status, r.body)
	case <-time.After(50 * time.Millisecond):
	}
	env.createBlock(30)
	select {
	case r = <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the long poll did not wake")
	}
	if time.Since(start) > 10*time.Second {
		t.Fatal("woke too late")
	}
	expect(t, r, http.StatusOK, "")
	verifyRulesSignature(t, ext.publicKey, r.body, r.header.Get(headerSignature))
	var next engine.ExtRulesResponse
	r.decode(t, &next)
	if next.ExtRulesVersion <= rules.ExtRulesVersion || len(next.Blocks) != 1 {
		t.Fatalf("after the block: version %d → %d, %d blocks", rules.ExtRulesVersion, next.ExtRulesVersion, len(next.Blocks))
	}
	if env.srv.polls.inFlight("ext:"+ext.id) != 0 {
		t.Fatal("the long poll slot was not released")
	}
}

func TestEventsLongPollWakes(t *testing.T) {
	env := newTestEnv(t)
	path := env.eventsPoll(20000)
	done := make(chan response, 1)
	go func() { done <- env.do("GET", path, nil, env.app()) }()
	waitFor(t, "the events long poll", func() bool { return env.srv.polls.inFlight(authApp) == 1 })
	select {
	case r := <-done:
		t.Fatalf("returned before any event: %d %s", r.status, r.body)
	case <-time.After(50 * time.Millisecond):
	}
	env.createBlock(30)
	var r response
	select {
	case r = <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the long poll did not wake")
	}
	expect(t, r, http.StatusOK, "")
	var page engine.EventsResponse
	r.decode(t, &page)
	if len(page.Events) == 0 || page.Reset {
		t.Fatalf("page = %s", r.body)
	}
	if !strings.Contains(string(r.body), `"block_created"`) {
		t.Fatalf("no block_created in %s", r.body)
	}
}

func TestLongPollsPerTokenCapped(t *testing.T) {
	env := newTestEnv(t)
	path := env.eventsPoll(20000)
	done := make(chan response, maxLongPollsPerToken)
	for range maxLongPollsPerToken {
		go func() { done <- env.do("GET", path, nil, env.app()) }()
	}
	waitFor(t, "four long polls", func() bool { return env.srv.polls.inFlight(authApp) == maxLongPollsPerToken })
	r := env.do("GET", path, nil, env.app())
	expect(t, r, http.StatusTooManyRequests, codeRateLimited)
	if r.header.Get(headerRetryAfter) == "" {
		t.Fatal("429 without Retry-After")
	}
	// A plain (non-waiting) request of the same token still works.
	expect(t, env.do("GET", "/v1/points", nil, env.app()), http.StatusOK, "")
	env.createBlock(30)
	for range maxLongPollsPerToken {
		select {
		case r := <-done:
			expect(t, r, http.StatusOK, "")
		case <-time.After(10 * time.Second):
			t.Fatal("a long poll did not wake")
		}
	}
	waitFor(t, "slots released", func() bool { return env.srv.polls.inFlight(authApp) == 0 })
}
