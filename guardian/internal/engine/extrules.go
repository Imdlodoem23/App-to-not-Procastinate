package engine

// Extension rules (docs/ARCHITECTURE.md §8.8 «GET /v1/ext/rules», §8.5 long poll,
// §10.10).
//
// The core renders enforcement into e.enf on every change and bumps
// e.state.Versions.ExtRules, broadcasting e.rulesNotify. GetExtRules waits on that
// notifier outside the engine goroutine (like Events), then builds the payload in one
// engine turn and signs the exact body bytes with ECDSA P-256 / SHA-256 (raw r‖s, 64
// bytes, base64url) using secret/rules.key, which is generated on first use (PKCS#8
// PEM, written with platform.WriteSecretFile). The request nonce is echoed inside the
// signed body, so a recorded body can never answer another request.

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"slices"
	"time"
)

const (
	// rulesKeyFileName is secret/rules.key (§11.1).
	rulesKeyFileName = "rules.key"
	// rulesKeyPEMType is the PEM block type of the PKCS#8 key.
	rulesKeyPEMType = "PRIVATE KEY"
	// rulesSignaturePrefix is the X-Centrate-Signature scheme (SIGNATURE_PREFIX).
	rulesSignaturePrefix = "v1="
	// rulesScalarBytes is the size of r and s for P-256.
	rulesScalarBytes = 32
)

// rulesNonceRE is nonceText of guardian-api.ts: 16…64 base64url characters (the client
// sends 16 random bytes, 22 characters).
var rulesNonceRE = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

// punishmentSeverity is PUNISHMENT_LEVELS from the mildest to the strictest (the ext rules
// summary shows the highest active level).
var punishmentSeverity = []string{"distractions", "whitelist", "nuclear"}

// extRulesState is the extension-rules state. Nothing is persisted: the version counter
// lives in engineState.Versions and the key in secret/rules.key.
type extRulesState struct {
	mem *extRulesMem
}

// extRulesMem is the in-memory part: the loaded key and when the current
// extRulesVersion was first observed (for the protecting grace of extensions).
type extRulesMem struct {
	key         *ecdsa.PrivateKey
	pub         string
	seenVersion int64
	changedAt   int64 // trusted ms
}

// ExtRuleBlock mirrors ExtRuleBlock.
type ExtRuleBlock struct {
	ID            string   `json:"id"`
	Kind          string   `json:"kind"`
	Mode          string   `json:"mode"`
	EndsAt        string   `json:"endsAt"`
	Reason        string   `json:"reason"`
	ServiceIDs    []string `json:"serviceIds"`
	Domains       []string `json:"domains"`
	WhitelistOnly bool     `json:"whitelistOnly"`
}

// ExtWhitelistRules mirrors ExtWhitelistRules.
type ExtWhitelistRules struct {
	AllowDomains      []string `json:"allowDomains"`
	AllowHostPatterns []string `json:"allowHostPatterns"`
}

// ExtAllowance is one ExtRulesResponse.allowances entry.
type ExtAllowance struct {
	ServiceID string `json:"serviceId"`
	EndsAt    string `json:"endsAt"`
}

// ExtPunishmentSummary is ExtRulesResponse.punishment.
type ExtPunishmentSummary struct {
	EndsAt string `json:"endsAt"`
	Level  string `json:"level"`
}

// ExtRulesResponse mirrors ExtRulesResponse.
type ExtRulesResponse struct {
	ExtRulesVersion  int64                 `json:"extRulesVersion"`
	Nonce            string                `json:"nonce"`
	ServerNow        string                `json:"serverNow"`
	BlockDomains     []string              `json:"blockDomains"`
	ExcludedDomains  []string              `json:"excludedDomains"`
	Whitelist        *ExtWhitelistRules    `json:"whitelist"`
	Blocks           []ExtRuleBlock        `json:"blocks"`
	Allowances       []ExtAllowance        `json:"allowances"`
	Punishment       *ExtPunishmentSummary `json:"punishment"`
	NextChangeAt     *string               `json:"nextChangeAt"`
	PenaltiesEnabled bool                  `json:"penaltiesEnabled"`
}

// ExtRulesQuery is GET /v1/ext/rules?nonce=&waitVersion=&waitMs=.
type ExtRulesQuery struct {
	Nonce       string
	WaitVersion *int64
	WaitMs      int
}

// SignedExtRules is the answer: Body is the exact JSON the signature covers (write it
// verbatim), Signature the X-Centrate-Signature header value ("v1=<base64url>"),
// Version the extRulesVersion (ETag "r-<Version>"; the API layer answers 304 when
// If-None-Match names it).
type SignedExtRules struct {
	Body      []byte
	Signature string
	Version   int64
}

// GetExtRules is GET /v1/ext/rules (ext token; long poll while extRulesVersion equals
// WaitVersion, up to WaitMs, then the current rules). The wait happens outside the
// engine goroutine; a revocation of the extension ends it with 401. Errors: 400
// bad_query (nonce, waitMs, waitVersion), 403 insufficient_scope, 401 unauthorized.
func (e *Engine) GetExtRules(ctx context.Context, r Request, q ExtRulesQuery) (SignedExtRules, error) {
	return e.getExtRules(ctx, r, q)
}

// extRulesTurn is what one engine turn of GetExtRules decided.
type extRulesTurn struct {
	wait  bool
	rules SignedExtRules
}

func (e *Engine) getExtRules(ctx context.Context, r Request, q ExtRulesQuery) (SignedExtRules, error) {
	if !rulesNonceRE.MatchString(q.Nonce) {
		return SignedExtRules{}, badQuery("nonce must be 16 to 64 base64url characters")
	}
	if q.WaitMs < 0 || q.WaitMs > limits().LongPollMaxMs {
		return SignedExtRules{}, badQuery("waitMs out of range")
	}
	if q.WaitVersion != nil && *q.WaitVersion < 0 {
		return SignedExtRules{}, badQuery("waitVersion out of range")
	}
	var timer <-chan time.Time
	if q.WaitVersion != nil && q.WaitMs > 0 {
		t := time.NewTimer(time.Duration(q.WaitMs) * time.Millisecond)
		defer t.Stop()
		timer = t.C
	}
	for {
		woke := e.rulesNotify.wait()
		waiting := timer != nil
		turn, err := run(e, ctx, cmdOpts{}, func() (extRulesTurn, error) {
			if _, err := e.requestExtension(r); err != nil {
				return extRulesTurn{}, err
			}
			if e.enfDirty {
				e.reconcile() // the payload must match the version it carries
			}
			e.extRulesChangedAt()
			if waiting && e.state.Versions.ExtRules == *q.WaitVersion {
				return extRulesTurn{wait: true}, nil
			}
			s, err := e.signedExtRules(q.Nonce)
			return extRulesTurn{rules: s}, err
		})
		if err != nil {
			return SignedExtRules{}, err
		}
		if !turn.wait {
			return turn.rules, nil
		}
		select {
		case <-woke:
		case <-timer:
			timer = nil // one last turn answers with the current rules
		case <-ctx.Done():
			return SignedExtRules{}, ctx.Err()
		}
	}
}

// signedExtRules builds, encodes and signs the payload.
func (e *Engine) signedExtRules(nonce string) (SignedExtRules, error) {
	p := e.extRulesPayload(nonce)
	body, err := EncodeResponse(p)
	if err != nil {
		return SignedExtRules{}, apiErr("internal", "the rules could not be encoded", nil)
	}
	sig, err := e.signRules(body)
	if err != nil {
		return SignedExtRules{}, err
	}
	return SignedExtRules{Body: body, Signature: rulesSignaturePrefix + sig, Version: p.ExtRulesVersion}, nil
}

// extRulesPayload is ExtRulesResponse from the rendered enforcement (display time).
func (e *Engine) extRulesPayload(nonce string) ExtRulesResponse {
	p := ExtRulesResponse{
		ExtRulesVersion:  e.state.Versions.ExtRules,
		Nonce:            nonce,
		ServerNow:        e.serverNow(),
		BlockDomains:     nonNil(slices.Clone(e.enf.BlockDomains)),
		ExcludedDomains:  nonNil(slices.Clone(e.enf.ExcludedDomains)),
		Blocks:           []ExtRuleBlock{},
		Allowances:       []ExtAllowance{},
		PenaltiesEnabled: e.state.Settings.AttemptPenalties,
	}
	if wl := e.enf.Whitelist; wl != nil {
		p.Whitelist = &ExtWhitelistRules{
			AllowDomains:      nonNil(slices.Clone(wl.AllowDomains)),
			AllowHostPatterns: nonNil(slices.Clone(wl.AllowHostPatterns)),
		}
	}
	var next int64
	earliest := func(ms int64) {
		if next == 0 || ms < next {
			next = ms
		}
	}
	for _, b := range e.sortedActive() {
		p.Blocks = append(p.Blocks, ExtRuleBlock{
			ID: b.ID, Kind: b.Kind, Mode: b.Mode, EndsAt: e.display(b.EndsAt), Reason: b.Reason,
			ServiceIDs: nonNil(slices.Clone(b.Resolved.ServiceIDs)), Domains: nonNil(slices.Clone(b.Resolved.Domains)),
			WhitelistOnly: b.WhitelistOnly,
		})
		earliest(b.EndsAt)
	}
	for _, a := range e.liveAllowances(e.now) {
		p.Allowances = append(p.Allowances, ExtAllowance{ServiceID: a.ServiceID, EndsAt: e.display(a.EndsAt)})
		earliest(a.EndsAt)
	}
	if next != 0 {
		p.NextChangeAt = ptr(e.display(next))
	}
	var pun *ExtPunishmentSummary
	var latest int64
	for _, x := range e.activePunishments() {
		if pun == nil {
			pun = &ExtPunishmentSummary{Level: x.Level}
		}
		latest = max(latest, x.EndsAt)
		if slices.Index(punishmentSeverity, x.Level) > slices.Index(punishmentSeverity, pun.Level) {
			pun.Level = x.Level
		}
	}
	if pun != nil {
		pun.EndsAt = e.display(latest)
		p.Punishment = pun
	}
	return p
}

// extRulesChangedAt observes the current extRulesVersion and returns the trusted time it
// was first observed (the start of the grace in which an extension still applying the
// previous version counts as protecting).
func (e *Engine) extRulesChangedAt() int64 {
	m := e.extRulesMem()
	if v := e.state.Versions.ExtRules; v != m.seenVersion || m.changedAt == 0 {
		m.seenVersion, m.changedAt = v, e.now
	}
	return m.changedAt
}

func (e *Engine) extRulesMem() *extRulesMem {
	if e.state.ExtRules.mem == nil {
		e.state.ExtRules.mem = &extRulesMem{}
	}
	return e.state.ExtRules.mem
}

// RulesPublicKey is the base64url SPKI (DER) of secret/rules.key, returned at pairing.
func (e *Engine) RulesPublicKey(ctx context.Context) (string, error) {
	return run(e, ctx, cmdOpts{}, func() (string, error) { return e.rulesPublicKey() })
}

func (e *Engine) rulesPublicKey() (string, error) {
	m := e.extRulesMem()
	if m.pub != "" && m.key != nil {
		return m.pub, nil
	}
	key, err := e.rulesKey()
	if err != nil {
		return "", err
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return "", apiErr("internal", "the rules key could not be encoded", nil)
	}
	m.pub = base64.RawURLEncoding.EncodeToString(der)
	return m.pub, nil
}

// signRules signs body: base64url of r‖s (32-byte halves, not ASN.1) of the ECDSA
// P-256 signature of sha256(body).
func (e *Engine) signRules(body []byte) (string, error) {
	key, err := e.rulesKey()
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(body)
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		e.countError("rules_sign")
		return "", apiErr("internal", "the rules could not be signed", nil)
	}
	sig := make([]byte, 2*rulesScalarBytes)
	r.FillBytes(sig[:rulesScalarBytes])
	s.FillBytes(sig[rulesScalarBytes:])
	return base64.RawURLEncoding.EncodeToString(sig), nil
}

// rulesKey returns the rules signing key: secret/rules.key, generated on first use. A
// file that is not a P-256 PKCS#8 key is replaced (paired extensions then need to pair
// again); a read error other than a missing file is an internal error, so a transient
// failure never replaces a good key.
func (e *Engine) rulesKey() (*ecdsa.PrivateKey, error) {
	m := e.extRulesMem()
	if m.key != nil {
		return m.key, nil
	}
	data, err := readSecretFile(e.secretPath(rulesKeyFileName))
	switch {
	case err == nil:
		k, perr := parseRulesKey(data)
		if perr == nil {
			m.key, m.pub = k, ""
			return k, nil
		}
		e.countError("rules_key")
		e.log.Error("secret/rules.key is not a P-256 key; generating a new one (extensions must pair again)", "err", perr)
	case errors.Is(err, fs.ErrNotExist):
	default:
		e.countError("rules_key")
		e.log.Error("secret/rules.key unreadable", "err", err)
		return nil, apiErr("internal", "the rules key is unreadable", nil)
	}
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, apiErr("internal", "the rules key could not be generated", nil)
	}
	der, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		return nil, apiErr("internal", "the rules key could not be encoded", nil)
	}
	if err := e.writeSecretFile(rulesKeyFileName, pem.EncodeToMemory(&pem.Block{Type: rulesKeyPEMType, Bytes: der})); err != nil {
		e.countError("rules_key")
		e.log.Error("secret/rules.key could not be written", "err", err)
		return nil, apiErr("internal", "the rules key could not be stored", nil)
	}
	m.key, m.pub = k, ""
	return k, nil
}

// parseRulesKey parses a PEM PKCS#8 ECDSA P-256 private key.
func parseRulesKey(data []byte) (*ecdsa.PrivateKey, error) {
	blk, _ := pem.Decode(data)
	if blk == nil || blk.Type != rulesKeyPEMType {
		return nil, errors.New("no PKCS#8 PEM block")
	}
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		return nil, err
	}
	ek, ok := k.(*ecdsa.PrivateKey)
	if !ok || ek.Curve != elliptic.P256() {
		return nil, fmt.Errorf("not an ECDSA P-256 key (%T)", k)
	}
	return ek, nil
}
