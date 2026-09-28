package engine

// Extension pairing (docs/ARCHITECTURE.md §9.3, §8.8 «Pairing», «POST /v1/ext/heartbeat»,
// §10.8 «Browsers without the extension»).
//
// Paired extensions live in secret/extensions.json ({schemaVersion: 1, extensions:
// [{id, sha256, boundOrigin, browser, pairedAt, extVersion}]}) under e.o.DataDir,
// written with platform.WriteSecretFile inside platform.EnsurePrivateDir; only token
// digests are stored, never tokens. That file is what authenticates extension tokens;
// the events (extension_paired, extension_revoked) and the persisted pairingState only
// carry what the UI shows (the last heartbeat of each extension). Pairing codes and the
// claim rate window live in memory only.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// Token scopes of Request.Scope (§8.2).
const (
	scopeApp = "app"
	scopeExt = "ext"
)

const (
	// secretDirName and the files of §11.1 this file owns.
	secretDirName      = "secret"
	extensionsFileName = "extensions.json"
	// extensionsSchemaVersion is secret/extensions.json's schemaVersion (§11.5).
	extensionsSchemaVersion = 1
	// extTokenPrefix is EXT_TOKEN_PREFIX (guardian-api.ts); extTokenBytes the random part.
	extTokenPrefix = "cte_"
	extTokenBytes  = 32
	// pairingCodeDigits is the length of a pairing code (pairingCodeResponseSchema).
	pairingCodeDigits = 6
	// maxPairedExtensions mirrors the list caps of PairedExtensionsResponse and
	// ProtectionStatus.extensions (64): pairing one more drops the stalest one.
	maxPairedExtensions = 64
	// maxSecretFileBytes bounds what a secret file read accepts.
	maxSecretFileBytes = 1 << 20
	// browserScanEvery is how often browsersWithoutExtension lists processes.
	browserScanEvery = 5 * time.Second
	// maxOriginLength is the boundOrigin cap of the response schemas.
	maxOriginLength = 200
)

// versionStringRE is versionString of guardian-api.ts (1…64 characters).
var versionStringRE = regexp.MustCompile(`^[0-9A-Za-z.+_-]{1,64}$`)

// pairingState is the persisted pairing state (state.json "engine.pairing"): the last
// heartbeat of each paired extension (tokens stay in secret/extensions.json).
type pairingState struct {
	// Extensions is keyed by extension id; the reducers add and remove entries.
	Extensions map[string]*extHeartbeatRec `json:"extensions,omitempty"`

	// mem is what never leaves memory (codes, the loaded secret file, scans).
	mem *pairingMem
}

// extHeartbeatRec is the last heartbeat of one extension (trusted time).
type extHeartbeatRec struct {
	Browser                string `json:"browser"`
	ExtVersion             string `json:"extVersion"`
	BrowserVersion         string `json:"browserVersion"`
	LastSeenAt             *int64 `json:"lastSeenAt"`
	IncognitoAllowed       bool   `json:"incognitoAllowed"`
	HostPermission         bool   `json:"hostPermission"`
	AppliedExtRulesVersion int64  `json:"appliedExtRulesVersion"`
}

// pairingMem is the in-memory part of the pairing state.
type pairingMem struct {
	loaded bool
	// readOnly: extensions.json was written by a newer schema; it is never rewritten.
	readOnly bool
	exts     []extEntry
	code     *pairingCode
	// claims are the boot-clock times of the claims inside the rate window.
	claims []time.Duration
	// Browser process scan (browsersWithoutExtension).
	scanned bool
	scanAt  time.Duration
	running map[string]*runningBrowser
}

// pairingCode is the one live pairing code.
type pairingCode struct {
	code      string
	expiresAt int64 // trusted ms
	failures  int
}

// runningBrowser is a browser family seen running without interruption since First.
type runningBrowser struct {
	First time.Duration // boot clock
	// Families are every extension family its executables may belong to (chrome.exe is
	// Chrome or Chromium); a protecting extension of any of them spares it.
	Families []string
}

// extEntry is one secret/extensions.json entry.
type extEntry struct {
	ID string `json:"id"`
	// SHA256 is hex(sha256(token)).
	SHA256      string  `json:"sha256"`
	BoundOrigin *string `json:"boundOrigin"`
	Browser     string  `json:"browser"`
	// PairedAt is trusted time.
	PairedAt   string `json:"pairedAt"`
	ExtVersion string `json:"extVersion,omitempty"`
}

// extensionsFile is secret/extensions.json.
type extensionsFile struct {
	SchemaVersion int        `json:"schemaVersion"`
	Extensions    []extEntry `json:"extensions"`
}

// PairingCodeResponse mirrors PairingCodeResponse.
type PairingCodeResponse struct {
	Code      string `json:"code"`
	ExpiresAt string `json:"expiresAt"`
	Port      int    `json:"port"`
}

// PairingClaimRequest mirrors PairingClaimRequest.
type PairingClaimRequest struct {
	Code           string `json:"code"`
	Browser        string `json:"browser"`
	BrowserVersion string `json:"browserVersion"`
	ExtVersion     string `json:"extVersion"`
}

// PairingClaimResponse mirrors PairingClaimResponse.
type PairingClaimResponse struct {
	ExtensionID     string  `json:"extensionId"`
	Token           string  `json:"token"`
	GuardianVersion string  `json:"guardianVersion"`
	BoundOrigin     *string `json:"boundOrigin"`
	RulesPublicKey  string  `json:"rulesPublicKey"`
}

// PairingPeer is what the API layer learned about a claim or heartbeat request: its
// Origin (empty when absent) and the verified loopback peer process (§9.3). The API
// layer fills PeerFamily (a BrowserFamily it resolved itself), PeerProcess (the peer's
// executable name, mapped here with the catalog: several browsers share an executable,
// chrome.exe is Chrome or Chromium) or both; both empty means the peer is not a browser.
type PairingPeer struct {
	Origin      string
	PeerFamily  string
	PeerProcess string
}

// PairedExtension mirrors PairedExtension.
type PairedExtension struct {
	ID          string  `json:"id"`
	Browser     string  `json:"browser"`
	ExtVersion  string  `json:"extVersion"`
	PairedAt    string  `json:"pairedAt"`
	LastSeenAt  *string `json:"lastSeenAt"`
	BoundOrigin *string `json:"boundOrigin"`
}

// PairedExtensionsResponse mirrors PairedExtensionsResponse.
type PairedExtensionsResponse struct {
	Extensions []PairedExtension `json:"extensions"`
}

// ExtHeartbeatRequest mirrors ExtHeartbeatRequest.
type ExtHeartbeatRequest struct {
	ExtVersion             string `json:"extVersion"`
	Browser                string `json:"browser"`
	BrowserVersion         string `json:"browserVersion"`
	IncognitoAllowed       bool   `json:"incognitoAllowed"`
	HostPermission         bool   `json:"hostPermission"`
	AppliedExtRulesVersion int64  `json:"appliedExtRulesVersion"`
}

// ExtHeartbeatResponse mirrors ExtHeartbeatResponse.
type ExtHeartbeatResponse struct {
	ExtRulesVersion int64  `json:"extRulesVersion"`
	ServerNow       string `json:"serverNow"`
}

// ExtensionAuth is a verified extension token. BoundOrigin is "" when the token is not
// bound to an origin; otherwise every request with that token that carries an Origin
// must carry exactly this one (the API layer checks it, §9.3).
type ExtensionAuth struct {
	ExtensionID string
	Browser     string
	BoundOrigin string
}

// CreatePairingCode is POST /v1/pairing/code (201): a new 6-digit code from
// crypto/rand that replaces the previous one.
func (e *Engine) CreatePairingCode(ctx context.Context, r Request) (PairingCodeResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem, status: 201}, func() (PairingCodeResponse, error) { return e.createPairingCode() })
}

func (e *Engine) createPairingCode() (PairingCodeResponse, error) {
	m := e.pairingMem()
	c := &pairingCode{code: randomDigits(pairingCodeDigits), expiresAt: e.now + int64(limits().PairingCodeTTLMs)}
	m.code = c
	return PairingCodeResponse{Code: c.code, ExpiresAt: e.display(c.expiresAt), Port: e.o.Port}, nil
}

// randomDigits returns n uniformly random decimal digits (crypto/rand, rejection
// sampling).
func randomDigits(n int) string {
	limit := uint32(1)
	for range n {
		limit *= 10
	}
	bound := (math.MaxUint32 / limit) * limit
	var buf [4]byte
	for {
		_, _ = rand.Read(buf[:]) // never fails (crypto/rand aborts instead)
		if v := binary.BigEndian.Uint32(buf[:]); v < bound {
			return fmt.Sprintf("%0*d", n, v%limit)
		}
	}
}

// ClaimPairing is POST /v1/pairing/claim (no token; 201). Checks, in order: the global
// claim rate (429), the request shape (422), the loopback peer (403 peer_not_browser),
// the code (409 pairing_no_code, 410 pairing_code_expired, 401 pairing_code_invalid; 5
// failures burn it) and the Origin (403 origin_not_allowed).
func (e *Engine) ClaimPairing(ctx context.Context, peer PairingPeer, req PairingClaimRequest) (PairingClaimResponse, error) {
	return run(e, ctx, cmdOpts{write: true, status: 201}, func() (PairingClaimResponse, error) { return e.claimPairing(peer, req) })
}

func (e *Engine) claimPairing(peer PairingPeer, req PairingClaimRequest) (PairingClaimResponse, error) {
	m := e.pairingMem()
	l := limits()
	window := msDuration(int64(l.PairingClaimWindowMs))
	m.claims = slices.DeleteFunc(m.claims, func(at time.Duration) bool { return e.bootNow-at >= window })
	if len(m.claims) >= l.PairingClaimsPerWindow {
		retry := max(m.claims[0]+window-e.bootNow, time.Millisecond)
		return PairingClaimResponse{}, apiErr("rate_limited", "too many pairing claims", map[string]any{"retryAfterMs": retry.Milliseconds()})
	}
	m.claims = append(m.claims, e.bootNow)
	if err := e.validateClaim(req); err != nil {
		return PairingClaimResponse{}, err
	}
	if !e.peerIsBrowser(peer, req.Browser) {
		return PairingClaimResponse{}, peerNotBrowser()
	}
	c := m.code
	switch {
	case c == nil:
		return PairingClaimResponse{}, apiErr("pairing_no_code", "no pairing code is active", nil)
	case e.now >= c.expiresAt:
		return PairingClaimResponse{}, apiErr("pairing_code_expired", "the pairing code expired", nil)
	}
	if subtle.ConstantTimeCompare([]byte(req.Code), []byte(c.code)) != 1 {
		c.failures++
		if c.failures >= l.PairingMaxFailures {
			m.code = nil
		}
		return PairingClaimResponse{}, apiErr("pairing_code_invalid", "wrong pairing code", nil)
	}
	var bound *string
	if peer.Origin != "" {
		if !isExtensionOrigin(peer.Origin) {
			return PairingClaimResponse{}, apiErr("origin_not_allowed", "only extension origins may pair", nil)
		}
		bound = ptr(peer.Origin)
	}
	if m.readOnly {
		return PairingClaimResponse{}, readOnly("schema_too_new")
	}
	pub, err := e.rulesPublicKey()
	if err != nil {
		return PairingClaimResponse{}, err
	}
	token := newExtensionToken()
	entry := extEntry{
		ID: newID("ext"), SHA256: tokenDigest(token), BoundOrigin: bound, Browser: req.Browser,
		PairedAt: fmtMs(e.now), ExtVersion: req.ExtVersion,
	}
	b := e.newBatch()
	next := slices.Clone(m.exts)
	if len(next) >= maxPairedExtensions {
		// Drop the stalest pairing (reinstalled extensions leave dead entries behind).
		i := e.stalestExtension(next)
		b.add(EvExtensionRevoked, ExtensionRevokedData{ExtensionID: next[i].ID})
		next = slices.Delete(next, i, i+1)
	}
	next = append(next, entry)
	b.add(EvExtensionPaired, ExtensionPairedData{ExtensionID: entry.ID, Browser: entry.Browser, BoundOrigin: bound})
	if err := e.commitExtensions(b, next); err != nil {
		return PairingClaimResponse{}, err
	}
	if hb := e.state.Pairing.Extensions[entry.ID]; hb != nil {
		hb.ExtVersion, hb.BrowserVersion = req.ExtVersion, req.BrowserVersion
	}
	m.code = nil
	return PairingClaimResponse{
		ExtensionID: entry.ID, Token: token, GuardianVersion: e.o.Version, BoundOrigin: bound, RulesPublicKey: pub,
	}, nil
}

// validateClaim checks pairingClaimRequestSchema.
func (e *Engine) validateClaim(req PairingClaimRequest) error {
	if len(req.Code) != pairingCodeDigits || strings.Trim(req.Code, "0123456789") != "" {
		return issueErr("code", "pattern", "six digits")
	}
	if !e.isBrowserFamily(req.Browser) {
		return issueErr("browser", "enum", "browser family")
	}
	if !versionStringRE.MatchString(req.BrowserVersion) {
		return issueErr("browserVersion", "pattern", "version string")
	}
	if !versionStringRE.MatchString(req.ExtVersion) {
		return issueErr("extVersion", "pattern", "version string")
	}
	return nil
}

func peerNotBrowser() *APIError {
	return apiErr("insufficient_scope", "the loopback peer is not a browser of that family", map[string]any{"reason": "peer_not_browser"})
}

// isBrowserFamily reports whether f is a BrowserFamily: the extension families of the
// embedded catalog's browsers (chrome, edge, brave, opera, vivaldi, chromium, firefox,
// other).
func (e *Engine) isBrowserFamily(f string) bool {
	return f != "" && slices.ContainsFunc(e.cat.Browsers(), func(b catalog.Browser) bool { return b.ExtensionFamily == f })
}

// peerIsBrowser reports whether the verified loopback peer is a browser of family.
func (e *Engine) peerIsBrowser(peer PairingPeer, family string) bool {
	if peer.PeerFamily != "" && peer.PeerFamily == family {
		return true
	}
	if peer.PeerProcess == "" {
		return false
	}
	return slices.ContainsFunc(e.cat.BrowsersForProcess(peer.PeerProcess, e.platform), func(b catalog.Browser) bool {
		return b.ExtensionFamily == family
	})
}

// isExtensionOrigin is the shape of an extension origin (§9.4); the API layer checks
// the allowed extension ids.
func isExtensionOrigin(o string) bool {
	if len(o) > maxOriginLength {
		return false
	}
	for _, p := range []string{"chrome-extension://", "moz-extension://"} {
		if id, ok := strings.CutPrefix(o, p); ok {
			return id != "" && strings.Trim(id, "abcdefghijklmnopqrstuvwxyz0123456789-") == ""
		}
	}
	return false
}

// newExtensionToken is cte_ plus 32 random bytes (base64url).
func newExtensionToken() string {
	var buf [extTokenBytes]byte
	_, _ = rand.Read(buf[:])
	return extTokenPrefix + base64.RawURLEncoding.EncodeToString(buf[:])
}

// tokenDigest is hex(sha256(token)).
func tokenDigest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// stalestExtension is the index of the extension seen least recently (never seen
// first, then the oldest pairing).
func (e *Engine) stalestExtension(list []extEntry) int {
	best, bestSeen := 0, int64(math.MaxInt64)
	for i, x := range list {
		seen := int64(math.MinInt64)
		if hb := e.state.Pairing.Extensions[x.ID]; hb != nil && hb.LastSeenAt != nil {
			seen = *hb.LastSeenAt
		}
		if i == 0 || seen < bestSeen {
			best, bestSeen = i, seen
		}
	}
	return best
}

// commitExtensions writes the new extension list and commits b: the secret file first
// (a token must never outlive its revocation), then the batch; when the batch fails the
// file is restored, so a failed write changes nothing (§8.1).
func (e *Engine) commitExtensions(b *batch, next []extEntry) error {
	m := e.pairingMem()
	if err := e.writeExtensions(next); err != nil {
		e.countError("extensions_write")
		e.log.Warn("secret/extensions.json write failed", "err", err)
		return readOnly("io_error")
	}
	if err := e.commit(b); err != nil {
		if rerr := e.writeExtensions(m.exts); rerr != nil {
			e.log.Error("secret/extensions.json could not be restored", "err", rerr)
		}
		return err
	}
	m.exts = next
	return nil
}

// ListExtensions is GET /v1/pairing/extensions.
func (e *Engine) ListExtensions(ctx context.Context) (PairedExtensionsResponse, error) {
	return run(e, ctx, cmdOpts{}, func() (PairedExtensionsResponse, error) { return e.listExtensions() })
}

func (e *Engine) listExtensions() (PairedExtensionsResponse, error) {
	out := PairedExtensionsResponse{Extensions: []PairedExtension{}}
	for _, x := range e.pairingMem().exts {
		p := PairedExtension{ID: x.ID, Browser: x.Browser, ExtVersion: e.extVersionOf(x), PairedAt: e.displayWire(x.PairedAt), BoundOrigin: x.BoundOrigin}
		if hb := e.state.Pairing.Extensions[x.ID]; hb != nil {
			p.LastSeenAt = e.displayPtr(hb.LastSeenAt)
		}
		out.Extensions = append(out.Extensions, p)
	}
	return out, nil
}

// displayWire converts a trusted wire timestamp to display time.
func (e *Engine) displayWire(s string) string {
	if ms, ok := parseMs(s); ok {
		return e.display(ms)
	}
	return s
}

// extVersionOf is the extension's latest known version.
func (e *Engine) extVersionOf(x extEntry) string {
	if hb := e.state.Pairing.Extensions[x.ID]; hb != nil && hb.ExtVersion != "" {
		return hb.ExtVersion
	}
	if x.ExtVersion != "" {
		return x.ExtVersion
	}
	return "0"
}

// RevokeExtension is DELETE /v1/pairing/extensions/{id} (204): the token stops working
// at once and the extension's rules long polls return 401.
func (e *Engine) RevokeExtension(ctx context.Context, r Request, id string) error {
	_, err := run(e, ctx, cmdOpts{write: true, idem: r.Idem, status: 204}, func() (struct{}, error) {
		return struct{}{}, e.revokeExtension(id)
	})
	return err
}

func (e *Engine) revokeExtension(id string) error {
	m := e.pairingMem()
	i := slices.IndexFunc(m.exts, func(x extEntry) bool { return x.ID == id })
	if i < 0 {
		return notFound("extension")
	}
	if m.readOnly {
		return readOnly("schema_too_new")
	}
	next := slices.Delete(slices.Clone(m.exts), i, i+1)
	b := e.newBatch()
	b.add(EvExtensionRevoked, ExtensionRevokedData{ExtensionID: id})
	if err := e.commitExtensions(b, next); err != nil {
		return err
	}
	// Wake the rules long polls: the revoked extension's ones answer 401 now.
	e.rulesNotify.broadcast()
	return nil
}

// ExtHeartbeat is POST /v1/ext/heartbeat (ext token): the browser must be the family
// bound at pairing (403 browser_mismatch) and the loopback peer a browser of it (403
// peer_not_browser).
func (e *Engine) ExtHeartbeat(ctx context.Context, r Request, peer PairingPeer, req ExtHeartbeatRequest) (ExtHeartbeatResponse, error) {
	return run(e, ctx, cmdOpts{}, func() (ExtHeartbeatResponse, error) { return e.extHeartbeat(r, peer, req) })
}

func (e *Engine) extHeartbeat(r Request, peer PairingPeer, req ExtHeartbeatRequest) (ExtHeartbeatResponse, error) {
	x, err := e.requestExtension(r)
	if err != nil {
		return ExtHeartbeatResponse{}, err
	}
	switch {
	case !versionStringRE.MatchString(req.ExtVersion):
		return ExtHeartbeatResponse{}, issueErr("extVersion", "pattern", "version string")
	case !e.isBrowserFamily(req.Browser):
		return ExtHeartbeatResponse{}, issueErr("browser", "enum", "browser family")
	case !versionStringRE.MatchString(req.BrowserVersion):
		return ExtHeartbeatResponse{}, issueErr("browserVersion", "pattern", "version string")
	case req.AppliedExtRulesVersion < 0:
		return ExtHeartbeatResponse{}, issueErr("appliedExtRulesVersion", "range", "a non-negative integer")
	}
	if req.Browser != x.Browser {
		return ExtHeartbeatResponse{}, apiErr("insufficient_scope", "the browser differs from the one bound at pairing", map[string]any{"reason": "browser_mismatch"})
	}
	if x.BoundOrigin != nil && peer.Origin != "" && peer.Origin != *x.BoundOrigin {
		return ExtHeartbeatResponse{}, apiErr("origin_not_allowed", "the Origin differs from the bound origin", nil)
	}
	if !e.peerIsBrowser(peer, x.Browser) {
		return ExtHeartbeatResponse{}, peerNotBrowser()
	}
	e.extRulesChangedAt() // observe the current version before the extension reports it
	hb := e.heartbeatRec(x.ID)
	*hb = extHeartbeatRec{
		Browser: x.Browser, ExtVersion: req.ExtVersion, BrowserVersion: req.BrowserVersion, LastSeenAt: ptr(e.now),
		IncognitoAllowed: req.IncognitoAllowed, HostPermission: req.HostPermission, AppliedExtRulesVersion: req.AppliedExtRulesVersion,
	}
	e.markDirty(false)
	return ExtHeartbeatResponse{ExtRulesVersion: e.state.Versions.ExtRules, ServerNow: e.serverNow()}, nil
}

// heartbeatRec returns the extension's heartbeat record, creating it.
func (e *Engine) heartbeatRec(id string) *extHeartbeatRec {
	if e.state.Pairing.Extensions == nil {
		e.state.Pairing.Extensions = map[string]*extHeartbeatRec{}
	}
	hb := e.state.Pairing.Extensions[id]
	if hb == nil {
		hb = &extHeartbeatRec{}
		e.state.Pairing.Extensions[id] = hb
	}
	return hb
}

// requestExtension is the paired extension of an ext-token request: 403 for another
// scope, 401 when the extension is not (or no longer) paired.
func (e *Engine) requestExtension(r Request) (*extEntry, error) {
	if r.Scope != scopeExt {
		return nil, apiErr("insufficient_scope", "an extension token is required", nil)
	}
	m := e.pairingMem()
	for i := range m.exts {
		if m.exts[i].ID == r.ExtensionID {
			return &m.exts[i], nil
		}
	}
	return nil, apiErr("unauthorized", "the extension is not paired", nil)
}

// AuthenticateExtension verifies an extension bearer token (compared as SHA-256 digests
// in constant time, §8.2); ok is false for an unknown or revoked token.
func (e *Engine) AuthenticateExtension(ctx context.Context, token string) (ExtensionAuth, bool) {
	a, err := run(e, ctx, cmdOpts{}, func() (ExtensionAuth, error) { return e.authenticateExtension(token) })
	return a, err == nil
}

func (e *Engine) authenticateExtension(token string) (ExtensionAuth, error) {
	want := sha256.Sum256([]byte(token))
	found := -1
	exts := e.pairingMem().exts
	for i, x := range exts {
		got, err := hex.DecodeString(x.SHA256)
		if err == nil && len(got) == len(want) && subtle.ConstantTimeCompare(got, want[:]) == 1 {
			found = i
		}
	}
	if found < 0 || !strings.HasPrefix(token, extTokenPrefix) {
		return ExtensionAuth{}, apiErr("unauthorized", "unknown extension token", nil)
	}
	x := exts[found]
	a := ExtensionAuth{ExtensionID: x.ID, Browser: x.Browser}
	if x.BoundOrigin != nil {
		a.BoundOrigin = *x.BoundOrigin
	}
	return a, nil
}

// ---------------------------------------------------------------------------------------
// secret/extensions.json
// ---------------------------------------------------------------------------------------

// pairingMem returns the in-memory pairing state, loading secret/extensions.json the
// first time (on the engine goroutine).
func (e *Engine) pairingMem() *pairingMem {
	p := &e.state.Pairing
	if p.mem == nil {
		p.mem = &pairingMem{running: map[string]*runningBrowser{}}
	}
	m := p.mem
	if !m.loaded {
		m.loaded = true
		exts, readOnlyFile, err := e.readExtensions()
		if err != nil {
			e.countError("extensions_read")
			e.log.Warn("secret/extensions.json unreadable; paired extensions must pair again", "err", err)
		}
		m.exts, m.readOnly = exts, readOnlyFile
	}
	return m
}

func (e *Engine) secretPath(name string) string {
	return filepath.Join(e.o.DataDir, secretDirName, name)
}

// readSecretFile reads a file of secret/ without following links.
func readSecretFile(path string) ([]byte, error) {
	f, err := platform.OpenRegularFile(path, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, maxSecretFileBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxSecretFileBytes {
		return nil, errors.New("secret file too large")
	}
	return data, nil
}

// writeSecretFile writes a file of secret/ atomically, readable by administrators only.
func (e *Engine) writeSecretFile(name string, data []byte) error {
	dir := filepath.Join(e.o.DataDir, secretDirName)
	if err := platform.EnsurePrivateDir(dir); err != nil {
		return err
	}
	return platform.WriteSecretFile(filepath.Join(dir, name), data)
}

// readExtensions loads secret/extensions.json (a missing file is an empty list). A
// newer schemaVersion is read (additive fields are ignored) but never rewritten.
func (e *Engine) readExtensions() ([]extEntry, bool, error) {
	data, err := readSecretFile(e.secretPath(extensionsFileName))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var f extensionsFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, false, err
	}
	if f.SchemaVersion < 1 {
		return nil, false, fmt.Errorf("extensions.json schemaVersion %d", f.SchemaVersion)
	}
	out := make([]extEntry, 0, len(f.Extensions))
	for _, x := range f.Extensions {
		if x.ID == "" || len(x.SHA256) != sha256.Size*2 || x.Browser == "" {
			continue
		}
		out = append(out, x)
	}
	return out, f.SchemaVersion > extensionsSchemaVersion, nil
}

// writeExtensions replaces secret/extensions.json.
func (e *Engine) writeExtensions(list []extEntry) error {
	if list == nil {
		list = []extEntry{}
	}
	raw, err := json.MarshalIndent(extensionsFile{SchemaVersion: extensionsSchemaVersion, Extensions: list}, "", "  ")
	if err != nil {
		return err
	}
	return e.writeSecretFile(extensionsFileName, append(raw, '\n'))
}

// ---------------------------------------------------------------------------------------
// Hooks the core calls
// ---------------------------------------------------------------------------------------

// extensionsStatus is /v1/state.protection.extensions and diagnostics.extensions.
func (e *Engine) extensionsStatus() []ExtensionStatus {
	out := []ExtensionStatus{}
	for _, x := range e.pairingMem().exts {
		out = append(out, e.extensionStatus(x))
	}
	return out
}

// extensionStatus is one ExtensionStatus: connected with a heartbeat within
// extConnectedWindowMs; protecting when connected, with host permission, incognito
// allowed and the current extRulesVersion applied (or changed less than
// extRulesCurrentGraceMs ago).
func (e *Engine) extensionStatus(x extEntry) ExtensionStatus {
	st := ExtensionStatus{ID: x.ID, Browser: x.Browser, ExtVersion: e.extVersionOf(x)}
	hb := e.state.Pairing.Extensions[x.ID]
	if hb == nil || hb.LastSeenAt == nil {
		return st
	}
	l := limits()
	st.LastSeenAt = e.displayPtr(hb.LastSeenAt)
	st.IncognitoAllowed, st.HostPermission, st.AppliedExtRulesVersion = hb.IncognitoAllowed, hb.HostPermission, hb.AppliedExtRulesVersion
	st.Connected = e.now-*hb.LastSeenAt < int64(l.ExtConnectedWindowMs)
	current := hb.AppliedExtRulesVersion == e.state.Versions.ExtRules || e.now-e.extRulesChangedAt() < int64(l.ExtRulesCurrentGraceMs)
	st.Protecting = st.Connected && hb.HostPermission && hb.IncognitoAllowed && current
	return st
}

// browsersWithoutExtension is /v1/state.protection.browsersWithoutExtension: the
// browser families seen running for more than browserWithoutExtensionGraceMs without a
// protecting extension of their family (§10.8). Processes are listed at most every
// browserScanEvery; a family counts from the first scan that saw it until a scan does
// not.
func (e *Engine) browsersWithoutExtension() []string {
	m := e.pairingMem()
	if !m.scanned || e.bootNow-m.scanAt >= browserScanEvery {
		m.scanned, m.scanAt = true, e.bootNow
		if procs, err := e.o.ProcessLister.List(); err == nil {
			seen := map[string]bool{}
			for _, p := range procs {
				bs := e.cat.BrowsersForProcess(p.Name, e.platform)
				if len(bs) == 0 {
					continue
				}
				fam := bs[0].ExtensionFamily
				seen[fam] = true
				rb := m.running[fam]
				if rb == nil {
					rb = &runningBrowser{First: e.bootNow}
					m.running[fam] = rb
				}
				for _, b := range bs {
					if !slices.Contains(rb.Families, b.ExtensionFamily) {
						rb.Families = append(rb.Families, b.ExtensionFamily)
					}
				}
			}
			for fam := range m.running {
				if !seen[fam] {
					delete(m.running, fam)
				}
			}
		}
	}
	protected := map[string]bool{}
	for _, st := range e.extensionsStatus() {
		if st.Protecting {
			protected[st.Browser] = true
		}
	}
	grace := msDuration(int64(limits().BrowserWithoutExtensionGraceMs))
	out := []string{}
	for fam, rb := range m.running {
		if e.bootNow-rb.First < grace || slices.ContainsFunc(rb.Families, func(f string) bool { return protected[f] }) {
			continue
		}
		out = append(out, fam)
	}
	slices.Sort(out)
	return out
}

// Reducers.

// applyExtensionPaired starts the extension's heartbeat record (not seen yet).
func (e *Engine) applyExtensionPaired(ev *storeEvent) error {
	d, err := decode[ExtensionPairedData](ev)
	if err != nil {
		return err
	}
	e.heartbeatRec(d.ExtensionID).Browser = d.Browser
	return nil
}

// applyExtensionRevoked forgets the extension's heartbeat record.
func (e *Engine) applyExtensionRevoked(ev *storeEvent) error {
	d, err := decode[ExtensionRevokedData](ev)
	if err != nil {
		return err
	}
	delete(e.state.Pairing.Extensions, d.ExtensionID)
	return nil
}
