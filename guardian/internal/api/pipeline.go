package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/engine"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// Headers (GUARDIAN_HEADERS of guardian-api.ts, plus the API version header).
const (
	headerSignature  = "X-Centrate-Signature"
	headerReplayed   = "Idempotent-Replayed"
	headerIdemKey    = "Idempotency-Key"
	headerRetryAfter = "Retry-After"
	// headerAPIVersion carries health.apiVersion on every response (§8.4): the version
	// of the /v1 contract this guardian serves.
	headerAPIVersion = "X-Centrate-Api-Version"
)

// idemKeyRE is the Idempotency-Key alphabet (§8.6); the length comes from the
// embedded idempotencyKeyMaxLength.
var idemKeyRE = regexp.MustCompile(`^[A-Za-z0-9_.:-]+$`)

// authInfo is who authenticated a request (§8.2).
type authInfo struct {
	// scope is "app", "ext" or "" (a route without auth).
	scope       string
	extID       string
	boundOrigin string
	// key identifies the token for rate limits and long polls ("app", "ext:<id>").
	key string
}

// call is one request on its way through the pipeline.
type call struct {
	s      *Server
	w      *statusWriter
	r      *http.Request
	ctx    context.Context
	tmpl   *template
	route  *route
	id     string
	origin string
	auth   authInfo
	peer   engine.PairingPeer
	query  query
	body   []byte
	idem   *engine.Idempotency
	// errCode is the error code answered, for the request log.
	errCode string
}

// routeID names the route for logs ("-" when none matched).
func (c *call) routeID() string {
	if c.route == nil {
		return "-"
	}
	return c.route.spec.ID
}

// request is what the engine learns about the request besides its body.
func (c *call) request() engine.Request {
	return engine.Request{Scope: c.auth.scope, ExtensionID: c.auth.extID, Idem: c.idem}
}

// ServeHTTP runs the request pipeline of docs/ARCHITECTURE.md §8.3, in order: Host,
// Origin (and preflight), route and method, auth and scope (with the bound-origin and
// loopback peer checks), rate limit, mode, body, then the handler (idempotency and one
// engine turn).
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	sw := &statusWriter{ResponseWriter: w}
	c := &call{s: s, w: sw, r: r, ctx: r.Context()}
	defer func() {
		if p := recover(); p != nil {
			if p == http.ErrAbortHandler {
				panic(p)
			}
			s.log.Error("api handler panicked", "route", c.routeID(), "panic", fmt.Sprintf("%T", p))
			if !sw.wrote {
				c.fail(apiError(codeInternal, "internal error", nil))
			}
		}
		s.logRequest(c, time.Since(start))
	}()
	h := sw.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set(headerAPIVersion, strconv.Itoa(embedded.API().APIVersion))
	h.Set("Vary", "Origin")
	s.serve(c)
}

func (s *Server) serve(c *call) {
	r := c.r
	// 1. Host (anti DNS rebinding).
	if !s.hostAllowed(r.Host) {
		c.fail(apiError(codeHostNotAllowed, "the Host header must be 127.0.0.1:<port> or localhost:<port>", nil))
		return
	}
	// 2. Origin: absent, or an allowed extension origin (on every route).
	origins := r.Header.Values("Origin")
	if len(origins) > 1 || (len(origins) == 1 && !s.originAllowed(origins[0])) {
		c.fail(apiError(codeOriginNotAllowed, "origin not allowed", nil))
		return
	}
	if len(origins) == 1 {
		c.origin = origins[0]
		setCORSHeaders(c.w.Header(), c.origin)
	}
	if r.Method == http.MethodOptions {
		s.preflight(c)
		return
	}
	// 3. Route and method.
	c.tmpl, c.id = s.router.match(r.URL.EscapedPath())
	if c.tmpl == nil {
		c.fail(apiError(codeNotFound, "route not found", nil))
		return
	}
	c.route = c.tmpl.methods[r.Method]
	if c.route == nil {
		c.w.Header().Set("Allow", c.tmpl.allow())
		c.fail(apiError(codeMethodNotAllowed, "method not allowed", nil))
		return
	}
	if err := s.engineReady(); err != nil {
		c.fail(err)
		return
	}
	// 4. Auth and scope, bound origin.
	if err := s.authenticate(c); err != nil {
		c.fail(err)
		return
	}
	// 5. Rate limit. It runs before the loopback peer check (a deliberate swap of
	// §8.3 steps 4 and 5): the peer lookup is costly (lsof on macOS, a /proc scan on
	// Linux) and claimPairing needs no token, so a refused caller must never reach it.
	if err := s.rateLimit(c); err != nil {
		c.fail(err)
		return
	}
	// 4b. Loopback peer process.
	if err := s.checkPeer(c); err != nil {
		c.fail(err)
		return
	}
	// 6. Mode: writes are refused in frozen and safe mode.
	if c.route.h.write {
		if err := s.checkMode(c.ctx); err != nil {
			c.fail(err)
			return
		}
	}
	// 7. Query and body (media type, size, JSON; the handler decodes the shape).
	q, aerr := parseQuery(r.URL.RawQuery, c.route.h.query)
	if aerr != nil {
		c.fail(aerr)
		return
	}
	c.query = q
	if err := c.readBody(); err != nil {
		c.fail(err)
		return
	}
	// 8. Idempotency (in the handler, after the shape) and the engine turn.
	c.route.h.serve(c)
}

// hostAllowed reports whether host is exactly 127.0.0.1:<port> or localhost:<port>.
func (s *Server) hostAllowed(host string) bool {
	port := strconv.Itoa(int(s.port.Load()))
	return host == "127.0.0.1:"+port || strings.EqualFold(host, "localhost:"+port)
}

// engineReady answers 503 read_only while the engine is starting, or when its startup
// failed.
func (s *Server) engineReady() *engine.APIError {
	select {
	case <-s.eng.Ready():
	default:
		return readOnly(reasonStarting)
	}
	if s.eng.OpenErr() != nil {
		return readOnly(reasonStartupFailed)
	}
	return nil
}

// rateLimit applies the token buckets of §9.6 (step 5).
func (s *Server) rateLimit(c *call) *engine.APIError {
	now := s.now()
	var ok bool
	var wait time.Duration
	switch {
	case c.route.spec.ID == "claimPairing":
		ok, wait = s.claims.allow(now)
	case c.auth.scope == authApp:
		ok, wait = s.limits.take(c.auth.key, now, appRate, appBurst)
	case c.auth.scope == authExt:
		ok, wait = s.limits.take(c.auth.key, now, extRate, extBurst)
		if ok && c.route.spec.ID == "reportAttempt" {
			ok, wait = s.limits.take("att:"+c.auth.extID, now, attemptRate, attemptBurst)
		}
	default:
		return nil
	}
	if ok {
		return nil
	}
	return c.rateLimited(wait, "rate limit exceeded")
}

// rateLimited is 429 rate_limited; fail turns details.retryAfterMs into Retry-After.
func (c *call) rateLimited(wait time.Duration, message string) *engine.APIError {
	return apiError(codeRateLimited, message, map[string]any{"retryAfterMs": max(wait.Milliseconds(), 1)})
}

// checkMode refuses a write in frozen or safe mode (step 6). The mode is fixed by the
// startup ladder, so it is read once and cached (health and state refresh it).
func (s *Server) checkMode(ctx context.Context) *engine.APIError {
	mode := s.cachedMode()
	if mode == "" {
		h, err := s.eng.Health(ctx)
		if err != nil {
			return nil // the engine turn repeats the check
		}
		mode = h.Mode
		s.noteMode(mode)
	}
	switch mode {
	case engine.ModeGuardianFrozen:
		return readOnly("schema_too_new")
	case engine.ModeGuardianSafe:
		return readOnly("safe_mode")
	}
	return nil
}

func (s *Server) cachedMode() string {
	if m := s.mode.Load(); m != nil {
		return *m
	}
	return ""
}

func (s *Server) noteMode(mode string) {
	if mode != "" {
		s.mode.Store(&mode)
	}
}

// readBody reads and checks the body (step 7): POST and PUT need application/json
// (415) and at most maxBodyBytes (413); GET and DELETE take none.
func (c *call) readBody() *engine.APIError {
	r := c.r
	max := int64(embedded.API().Limits.MaxBodyBytes)
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		if r.ContentLength > 0 {
			return apiError(codeInvalidJSON, r.Method+" requests take no body", nil)
		}
		if r.ContentLength < 0 {
			var one [1]byte
			if n, _ := io.ReadFull(r.Body, one[:]); n > 0 {
				return apiError(codeInvalidJSON, r.Method+" requests take no body", nil)
			}
		}
		return nil
	}
	mt, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		return apiError(codeUnsupportedMedia, "requests with a body must be application/json", nil)
	}
	if cs, ok := params["charset"]; ok && !strings.EqualFold(cs, "utf-8") {
		return apiError(codeUnsupportedMedia, "the body must be UTF-8", nil)
	}
	if r.ContentLength > max {
		return c.tooLarge(max)
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if err != nil {
		return apiError(codeInvalidJSON, "the body could not be read", nil)
	}
	if int64(len(body)) > max {
		return c.tooLarge(max)
	}
	c.body = body
	return nil
}

func (c *call) tooLarge(max int64) *engine.APIError {
	return apiError(codeBodyTooLarge, "the body is too large", map[string]any{"maxBytes": max})
}

// prepareIdempotency reads the Idempotency-Key of an idempotent route (§8.6): 1–128
// characters of [A-Za-z0-9_.:-]. The engine stores (scope, method, concrete path,
// key) → (sha256(path | body), status, response) and replays or refuses a reuse.
// Routes that are not idempotent ignore the header.
func (c *call) prepareIdempotency() *engine.APIError {
	if !c.route.spec.IdempotencyKey {
		return nil
	}
	vals := c.r.Header.Values(headerIdemKey)
	if len(vals) == 0 {
		return nil
	}
	key := ""
	if len(vals) == 1 {
		key = vals[0]
	}
	if n := len(key); n < 1 || n > embedded.API().Limits.IdempotencyKeyMaxLength {
		return apiError(codeValidationFailed, "invalid Idempotency-Key", map[string]any{"path": headerIdemKey, "issue": "length"})
	}
	if !idemKeyRE.MatchString(key) {
		return apiError(codeValidationFailed, "invalid Idempotency-Key", map[string]any{"path": headerIdemKey, "issue": "pattern"})
	}
	scope, method, path := c.auth.scope, c.r.Method, c.r.URL.EscapedPath()
	c.idem = &engine.Idempotency{
		Lookup:      hexSHA256(scope + "|" + key),
		Scope:       scope,
		Method:      method,
		Path:        path,
		RequestHash: hexSHA256(path + "|" + string(c.body)),
		Req:         store.ReqFingerprint(scope, method, path, key),
	}
	return nil
}

func hexSHA256(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// ---------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------

// respond writes res with status, or the error.
func (c *call) respond(status int, res any, err error) {
	if err != nil {
		c.fail(err)
		return
	}
	c.ok(status, res)
}

// ok writes a JSON body encoded like the engine's stored responses (EncodeResponse),
// so an idempotent replay is byte for byte the first answer.
func (c *call) ok(status int, res any) {
	body, err := engine.EncodeResponse(res)
	if err != nil {
		c.s.log.Error("api response encoding failed", "route", c.routeID())
		c.fail(apiError(codeInternal, "the response could not be encoded", nil))
		return
	}
	c.writeJSON(status, body)
}

func (c *call) writeJSON(status int, body []byte) {
	h := c.w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	c.w.WriteHeader(status)
	_, _ = c.w.Write(body)
}

func (c *call) noContent() { c.w.WriteHeader(http.StatusNoContent) }

// conditional sets the ETag and answers 304 without a body when If-None-Match names
// it (§8.5); otherwise it calls write.
func (c *call) conditional(etag string, write func()) {
	c.w.Header().Set("ETag", etag)
	if etagMatches(c.r.Header.Values("If-None-Match"), etag) {
		c.w.WriteHeader(http.StatusNotModified)
		return
	}
	write()
}

// etagMatches implements If-None-Match: a list of entity tags (weak ones compared
// weakly) or "*".
func etagMatches(values []string, etag string) bool {
	for _, v := range values {
		for part := range strings.SplitSeq(v, ",") {
			p := strings.TrimSpace(part)
			if p == "*" || strings.TrimPrefix(p, "W/") == etag {
				return true
			}
		}
	}
	return false
}

// errorEnvelope is GuardianErrorBody.
type errorEnvelope struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details"`
}

// fail answers err: an idempotent replay verbatim (Idempotent-Replayed: true), an
// *engine.APIError as {"error": {code, message, details}} with its embedded status,
// the engine's lifecycle errors as 503 read_only, anything else as 500 internal.
func (c *call) fail(err error) {
	var rep *engine.ReplayedResponse
	if errors.As(err, &rep) {
		c.w.Header().Set(headerReplayed, "true")
		if rep.Status == http.StatusNoContent || len(rep.Body) == 0 {
			c.w.WriteHeader(rep.Status)
			return
		}
		c.writeJSON(rep.Status, rep.Body)
		return
	}
	var ae *engine.APIError
	switch {
	case errors.As(err, &ae):
	case errors.Is(err, engine.ErrNotOpen):
		ae = readOnly(reasonStarting)
	case errors.Is(err, engine.ErrStopped), errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		ae = readOnly(reasonStopping)
	default:
		c.s.log.Warn("api request failed", "route", c.routeID(), "errType", fmt.Sprintf("%T", err))
		ae = apiError(codeInternal, "internal error", nil)
	}
	status := ae.Status()
	h := c.w.Header()
	switch ae.Code {
	case codeUnauthorized:
		h.Set("WWW-Authenticate", "Bearer")
	case codeRateLimited:
		h.Set(headerRetryAfter, strconv.FormatInt(retryAfterSeconds(ae.Details), 10))
	}
	body, jerr := engine.EncodeResponse(errorEnvelope{Error: errorBody{Code: ae.Code, Message: ae.Message, Details: ae.Details}})
	if jerr != nil {
		body = []byte(`{"error":{"code":"internal","message":"internal error","details":null}}`)
		status = http.StatusInternalServerError
	}
	c.errCode = ae.Code
	c.writeJSON(status, body)
}

// retryAfterSeconds is details.retryAfterMs rounded up to whole seconds (at least 1).
func retryAfterSeconds(details map[string]any) int64 {
	var ms int64
	switch v := details["retryAfterMs"].(type) {
	case int64:
		ms = v
	case int:
		ms = int64(v)
	case float64:
		ms = int64(v)
	}
	return max((ms+999)/1000, 1)
}

// statusWriter records the status for the request log.
type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (w *statusWriter) WriteHeader(code int) {
	if !w.wrote {
		w.status, w.wrote = code, true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the connection (long-poll deadlines).
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// logRequest logs one request without personal data or secrets: the route id (never
// the concrete path or query), method, status, error code and duration. Headers
// (Authorization, Idempotency-Key, Origin) and bodies are never logged.
func (s *Server) logRequest(c *call, d time.Duration) {
	status := c.w.status
	if !c.w.wrote {
		status = http.StatusOK
	}
	attrs := []any{"route", c.routeID(), "method", methodForLog(c.r.Method), "status", status, "ms", d.Milliseconds()}
	if c.errCode != "" {
		attrs = append(attrs, "code", c.errCode)
	}
	if status >= http.StatusInternalServerError {
		s.log.Warn("api request", attrs...)
		return
	}
	s.log.Debug("api request", attrs...)
}

// methodForLog keeps arbitrary method tokens out of the log.
func methodForLog(m string) string {
	switch m {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodOptions, http.MethodHead, http.MethodPatch:
		return m
	}
	return "other"
}
