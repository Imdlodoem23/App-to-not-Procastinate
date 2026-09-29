package api

import (
	"context"
	"net"
	"net/http"
	"net/netip"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

// peerTimeout bounds one loopback peer lookup.
const peerTimeout = 5 * time.Second

// maxPeerLookups caps the loopback peer lookups in flight, so callers (the pairing
// claim needs no token) can never run lsof or /proc scans in parallel en masse.
const maxPeerLookups = 2

// authenticate is step 4 of §8.3 (§8.2): the bearer token and its scope. Missing or
// unknown token: 401 unauthorized (WWW-Authenticate: Bearer); wrong scope: 403
// insufficient_scope; an app token with any Origin, or an extension token with an
// Origin other than the one bound at pairing: 403 origin_not_allowed. Routes without
// auth (health, the pairing claim) ignore tokens.
func (s *Server) authenticate(c *call) *engine.APIError {
	need := c.route.spec.Auth
	if need == authNone {
		return nil
	}
	tok, ok := bearerToken(c.r)
	if !ok {
		return unauthorized()
	}
	if s.isAppToken(tok) {
		if c.origin != "" {
			return apiError(codeOriginNotAllowed, "app-token requests must not carry an Origin", nil)
		}
		if need != authApp && need != authAppOrExt {
			return apiError(codeInsufficientScope, "this route needs an extension token", nil)
		}
		c.auth = authInfo{scope: authApp, key: authApp}
		return nil
	}
	if !strings.HasPrefix(tok, extTokenPrefix) {
		return unauthorized()
	}
	a, ok := s.eng.AuthenticateExtension(c.ctx, tok)
	if !ok {
		return unauthorized()
	}
	if a.BoundOrigin != "" && c.origin != "" && c.origin != a.BoundOrigin {
		return apiError(codeOriginNotAllowed, "the Origin differs from the one bound at pairing", nil)
	}
	if need != authExt && need != authAppOrExt {
		return apiError(codeInsufficientScope, "this route needs the app token", nil)
	}
	c.auth = authInfo{scope: authExt, extID: a.ExtensionID, boundOrigin: a.BoundOrigin, key: "ext:" + a.ExtensionID}
	return nil
}

func unauthorized() *engine.APIError {
	return apiError(codeUnauthorized, "missing or unknown token", nil)
}

// bearerToken reads the single "Authorization: Bearer <token>" header.
func bearerToken(r *http.Request) (string, bool) {
	vals := r.Header.Values("Authorization")
	if len(vals) != 1 {
		return "", false
	}
	scheme, tok, ok := strings.Cut(strings.TrimSpace(vals[0]), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	tok = strings.TrimSpace(tok)
	if tok == "" || len(tok) > maxTokenLength {
		return "", false
	}
	return tok, true
}

// isAppToken compares tok with the current app token as SHA-256 digests in constant
// time (§8.2).
func (s *Server) isAppToken(tok string) bool {
	want := s.appDigest.Load()
	if want == nil {
		return false
	}
	return digestEqual(tokenDigest(tok), *want)
}

// checkPeer is the loopback peer check of step 4 (§9.3, §10.5). For the pairing
// claim and extension heartbeats it tells the engine which executable is at the other
// end (only a process in an interactive session counts; the engine requires a browser
// of the claimed family). For Nuclear heartbeats the peer must be the desktop app at
// config.json appPath in the console session, else 403 insufficient_scope.
func (s *Server) checkPeer(c *call) *engine.APIError {
	kind := c.route.h.peer
	if kind == peerNone {
		return nil
	}
	info, ok := s.lookupPeer(c)
	switch kind {
	case peerBrowser:
		c.peer = engine.PairingPeer{Origin: c.origin}
		if ok && info.Interactive {
			c.peer.PeerProcess = info.Name
		}
	case peerApp:
		if !ok || !info.Console || !s.isAppPath(info.Path) {
			return apiError(codeInsufficientScope, "the peer is not the Céntrate app", map[string]any{"reason": "peer_not_app"})
		}
	}
	return nil
}

// lookupPeer resolves the process at the other end of the request's connection.
func (s *Server) lookupPeer(c *call) (PeerInfo, bool) {
	client, err := netip.ParseAddrPort(c.r.RemoteAddr)
	if err != nil {
		return PeerInfo{}, false
	}
	la, _ := c.r.Context().Value(http.LocalAddrContextKey).(net.Addr)
	server, err := netip.ParseAddrPort(addrString(la))
	if err != nil {
		return PeerInfo{}, false
	}
	ctx, cancel := context.WithTimeout(c.ctx, peerTimeout)
	defer cancel()
	select {
	case s.peerSem <- struct{}{}:
		defer func() { <-s.peerSem }()
	case <-ctx.Done():
		s.log.Debug("loopback peer not resolved", "route", c.routeID(), "errType", "busy")
		return PeerInfo{}, false
	}
	info, err := s.peers.Resolve(ctx, client, server)
	if err != nil {
		s.log.Debug("loopback peer not resolved", "route", c.routeID(), "errType", errType(err))
		return PeerInfo{}, false
	}
	return info, true
}

func addrString(a net.Addr) string {
	if a == nil {
		return ""
	}
	return a.String()
}

// isAppPath reports whether path is config.json appPath (never a match by name or
// bundle id, §10.5). Windows paths compare case-insensitively.
func (s *Server) isAppPath(path string) bool {
	want := s.cfg.AppPath
	if want == "" || path == "" {
		return false
	}
	a, b := filepath.Clean(path), filepath.Clean(want)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}
