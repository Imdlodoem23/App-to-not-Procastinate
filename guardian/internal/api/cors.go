package api

import (
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

// CORS and Origin (docs/ARCHITECTURE.md §9.4). Allowed origins: exactly
// chrome-extension://<id> for the pinned CHROMIUM_EXTENSION_ID and the admin-configured
// config.json extraExtensionIds, and any moz-extension://<uuid> (Firefox assigns a
// random UUID per profile; the token and its bound origin are the real gate). Any
// other Origin is 403 origin_not_allowed on every route, /v1/health included, and
// never gets CORS headers. Access-Control-Allow-Credentials is never sent.

const (
	chromeOriginPrefix  = "chrome-extension://"
	firefoxOriginPrefix = "moz-extension://"
	// corsMaxAgeSeconds is Access-Control-Max-Age of a preflight (§9.4).
	corsMaxAgeSeconds = 600
)

// Fixed CORS header values of §9.4.
const (
	corsAllowMethods  = "GET, POST, PUT, DELETE"
	corsAllowHeaders  = "Authorization, Content-Type, Idempotency-Key, If-None-Match"
	corsExposeHeaders = "ETag, X-Centrate-Signature, Idempotent-Replayed, Retry-After"
)

// mozUUIDRE is the UUID of a moz-extension:// origin.
var mozUUIDRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// originAllowed reports whether origin is an allowed extension origin.
func (s *Server) originAllowed(origin string) bool {
	if id, ok := strings.CutPrefix(origin, chromeOriginPrefix); ok {
		return id == embedded.API().ChromiumExtensionID || slices.Contains(s.cfg.ExtraExtensionIDs, id)
	}
	if id, ok := strings.CutPrefix(origin, firefoxOriginPrefix); ok {
		return mozUUIDRE.MatchString(id)
	}
	return false
}

// setCORSHeaders adds the headers every response to an allowed origin carries.
func setCORSHeaders(h http.Header, origin string) {
	h.Set("Access-Control-Allow-Origin", origin)
	h.Set("Access-Control-Expose-Headers", corsExposeHeaders)
}

// preflight answers OPTIONS: 204 with the CORS headers for an allowed origin and a
// known path; 403 origin_not_allowed without CORS headers when there is no Origin (a
// disallowed one was refused before); 404 for an unknown path.
func (s *Server) preflight(c *call) {
	if c.origin == "" {
		c.fail(apiError(codeOriginNotAllowed, "a preflight needs an allowed Origin", nil))
		return
	}
	if t, _ := s.router.match(c.r.URL.EscapedPath()); t == nil {
		c.fail(apiError(codeNotFound, "route not found", nil))
		return
	}
	h := c.w.Header()
	h.Set("Access-Control-Allow-Methods", corsAllowMethods)
	h.Set("Access-Control-Allow-Headers", corsAllowHeaders)
	h.Set("Access-Control-Max-Age", strconv.Itoa(corsMaxAgeSeconds))
	if strings.EqualFold(c.r.Header.Get("Access-Control-Request-Private-Network"), "true") {
		h.Set("Access-Control-Allow-Private-Network", "true")
	}
	c.noContent()
}
