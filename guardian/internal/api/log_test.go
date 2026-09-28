package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

// TestLogsNeverContainSecrets is the logger test of §15 for the API layer: tokens,
// Authorization headers, pairing codes, idempotency keys, nonces, bodies and ids in
// paths never reach the log, at debug level included.
func TestLogsNeverContainSecrets(t *testing.T) {
	env := newTestEnv(t)
	secrets := []string{env.token}

	// A pairing round: the code and the extension token.
	r := env.do("POST", "/v1/pairing/code", map[string]any{}, env.app())
	var code engine.PairingCodeResponse
	r.decode(t, &code)
	secrets = append(secrets, code.Code)
	wrong := "13579" + code.Code[5:]
	if wrong == code.Code {
		wrong = "24680" + code.Code[5:]
	}
	env.do("POST", "/v1/pairing/claim", map[string]any{"code": wrong, "browser": "chrome", "browserVersion": "1", "extVersion": "1"})
	r = env.do("POST", "/v1/pairing/claim", map[string]any{
		"code": code.Code, "browser": "chrome", "browserVersion": "1", "extVersion": "1",
	}, withOrigin(pinnedOrigin))
	expect(t, r, http.StatusCreated, "")
	var claim engine.PairingClaimResponse
	r.decode(t, &claim)
	secrets = append(secrets, claim.Token, wrong)

	// Requests carrying secrets and personal data in every place a logger could look.
	nonce := "NonceSecretNonceSecret42"
	idemKey := "idem-key-secret-0123456789"
	bogus := "cta_bogusTokenThatMustNotBeLogged0123456789abcd"
	reason := "Motivo privadisimo del usuario"
	domain := "secret-domain-example.org"
	secrets = append(secrets, nonce, idemKey, bogus, reason, domain)

	body := blockBody(30)
	body["reason"] = reason
	body["targets"].(map[string]any)["customDomains"] = []string{domain}
	r = env.do("POST", "/v1/blocks", body, env.app(), withHeader("Idempotency-Key", idemKey))
	expect(t, r, http.StatusCreated, "")
	var blk engine.CreateBlockResponse
	r.decode(t, &blk)
	secrets = append(secrets, blk.Block.ID)
	env.do("GET", "/v1/blocks/"+blk.Block.ID, nil, env.app())
	env.do("GET", "/v1/ext/rules?nonce="+nonce, nil, withToken(claim.Token))
	env.do("GET", "/v1/state", nil, withToken(bogus))
	env.do("GET", "/v1/state", nil, withHeader("Authorization", "Basic "+env.token))
	env.do("POST", "/v1/attempts", map[string]any{
		"layer": "extension", "target": map[string]any{"type": "domain", "value": domain}, "browser": "chrome", "incognito": false,
	}, withToken(claim.Token))
	env.do("POST", "/v1/blocks", `{"reason":"`+reason+`",}`, env.app())
	env.do("GET", "/v1/"+domain, nil, env.app())
	env.do("GET", "/v1/health", nil, withOrigin("https://"+domain))

	logs := env.logs.String()
	if !strings.Contains(logs, "api request") {
		t.Fatalf("no request was logged at debug level:\n%s", logs)
	}
	for _, s := range secrets {
		if s != "" && strings.Contains(logs, s) {
			t.Errorf("the log contains %q", s)
		}
	}
	for _, s := range []string{"Bearer", "Authorization", "Idempotency-Key", "nonce="} {
		if strings.Contains(logs, s) {
			t.Errorf("the log mentions %q", s)
		}
	}
	// client.json holds the token, the log never does (checked above); the log does say
	// that the server listens.
	if !strings.Contains(logs, "guardian API listening") {
		t.Error("no listening message")
	}
}
