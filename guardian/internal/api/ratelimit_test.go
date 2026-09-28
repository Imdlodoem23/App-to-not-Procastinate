package api

import (
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

func TestAppTokenRateLimit(t *testing.T) {
	env := newTestEnv(t)
	for i := range appBurst {
		if r := env.do("GET", "/v1/points", nil, env.app()); r.status != http.StatusOK {
			t.Fatalf("request %d: %d %s", i, r.status, r.body)
		}
	}
	r := env.do("GET", "/v1/points", nil, env.app())
	expect(t, r, http.StatusTooManyRequests, codeRateLimited)
	if got := r.header.Get(headerRetryAfter); got != "1" {
		t.Fatalf("Retry-After = %q", got)
	}
	// Unauthenticated health is not limited by the app bucket.
	expect(t, env.do("GET", "/v1/health", nil), http.StatusOK, "")
	// 50 tokens per second come back.
	env.now.Advance(time.Second)
	for i := range appRate {
		if r := env.do("GET", "/v1/points", nil, env.app()); r.status != http.StatusOK {
			t.Fatalf("refilled request %d: %d", i, r.status)
		}
	}
	expect(t, env.do("GET", "/v1/points", nil, env.app()), http.StatusTooManyRequests, codeRateLimited)
}

func TestExtensionRateLimits(t *testing.T) {
	env := newTestEnv(t)
	a := env.pair(pinnedOrigin)
	b := env.pair("")
	attempt := map[string]any{"layer": "extension", "target": map[string]any{"type": "domain", "value": "www.youtube.com"}, "browser": "chrome", "incognito": false}
	// 5 attempts per second per extension token.
	for range attemptBurst {
		expect(t, env.do("POST", "/v1/attempts", attempt, withToken(a.token)), http.StatusOK, "")
	}
	expect(t, env.do("POST", "/v1/attempts", attempt, withToken(a.token)), http.StatusTooManyRequests, codeRateLimited)
	// Each token has its own buckets.
	expect(t, env.do("POST", "/v1/attempts", attempt, withToken(b.token)), http.StatusOK, "")
	// 20 requests of burst per extension token (6 spent above, one refused).
	rules := "/v1/ext/rules?nonce=q3Jd0W3y8kqj3n7mW2Wm8A"
	for i := range extBurst - attemptBurst - 1 {
		if r := env.do("GET", rules, nil, withToken(a.token)); r.status != http.StatusOK {
			t.Fatalf("request %d: %d %s", i, r.status, r.body)
		}
	}
	expect(t, env.do("GET", rules, nil, withToken(a.token)), http.StatusTooManyRequests, codeRateLimited)
	expect(t, env.do("GET", rules, nil, withToken(b.token)), http.StatusOK, "")
	env.now.Advance(time.Second)
	expect(t, env.do("GET", rules, nil, withToken(a.token)), http.StatusOK, "")
}

func TestPairingClaimsLimitedGlobally(t *testing.T) {
	env := newTestEnv(t)
	l := embedded.API().Limits
	bad := map[string]any{"code": "000000", "browser": "chrome", "browserVersion": "1", "extVersion": "1"}
	for i := range l.PairingClaimsPerWindow {
		r := env.do("POST", "/v1/pairing/claim", bad)
		if r.status == http.StatusTooManyRequests {
			t.Fatalf("claim %d limited", i)
		}
	}
	r := env.do("POST", "/v1/pairing/claim", bad)
	expect(t, r, http.StatusTooManyRequests, codeRateLimited)
	retry, err := strconv.Atoi(r.header.Get(headerRetryAfter))
	if err != nil || retry < 1 || retry > l.PairingClaimWindowMs/1000 {
		t.Fatalf("Retry-After = %q", r.header.Get(headerRetryAfter))
	}
	env.now.Advance(embedded.Millis(l.PairingClaimWindowMs))
	// The API window is open again; the engine keeps its own window (boot clock).
	env.clk.Advance(embedded.Millis(l.PairingClaimWindowMs))
	r = env.do("POST", "/v1/pairing/claim", bad)
	if r.status == http.StatusTooManyRequests {
		t.Fatalf("still limited after the window: %s", r.body)
	}
}

func TestRateLimiterBuckets(t *testing.T) {
	l := newRateLimiter()
	now := time.Unix(0, 0)
	for range 3 {
		if ok, _ := l.take("k", now, 1, 3); !ok {
			t.Fatal("burst refused")
		}
	}
	ok, wait := l.take("k", now, 1, 3)
	if ok || wait != time.Second {
		t.Fatalf("empty bucket: %v %v", ok, wait)
	}
	if ok, _ := l.take("k", now.Add(time.Second), 1, 3); !ok {
		t.Fatal("no refill")
	}
	// The table stays bounded.
	for i := range maxBuckets * 2 {
		l.take("x"+strconv.Itoa(i), now.Add(time.Hour), 1, 3)
	}
	if len(l.buckets) > maxBuckets+1 {
		t.Fatalf("%d buckets", len(l.buckets))
	}
	w := &windowLimiter{n: 2, window: time.Minute}
	w.allow(now)
	w.allow(now.Add(time.Second))
	if ok, wait := w.allow(now.Add(2 * time.Second)); ok || wait != 58*time.Second {
		t.Fatalf("window: %v %v", ok, wait)
	}
	if ok, _ := w.allow(now.Add(time.Minute)); !ok {
		t.Fatal("window did not slide")
	}
}

// TestEngineRateLimitedMapsRetryAfter: the engine's own claim limiter reports
// details.retryAfterMs, which becomes Retry-After.
func TestEngineRateLimitedMapsRetryAfter(t *testing.T) {
	if got := retryAfterSeconds(map[string]any{"retryAfterMs": int64(1500)}); got != 2 {
		t.Fatalf("1500 ms → %d s", got)
	}
	if got := retryAfterSeconds(nil); got != 1 {
		t.Fatalf("nil → %d s", got)
	}
}
