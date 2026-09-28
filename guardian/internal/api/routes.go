package api

import (
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

// The router is generated from the embedded route table (GUARDIAN_ENDPOINTS in
// api.json, docs/ARCHITECTURE.md §8.7): every endpoint must have a handler here and
// every handler an endpoint, or New fails. testOnly endpoints are routed only in
// builds with the testhooks tag. There is deliberately no route that ends, shortens,
// edits or deletes a block (§2): /v1/blocks only has create, read and extend.

// Endpoint auth kinds (EndpointAuth).
const (
	authNone     = "none"
	authApp      = "app"
	authExt      = "ext"
	authAppOrExt = "app_or_ext"
)

// idParam is the id placeholder of a path template.
const idParam = "{id}"

// idSegmentRE is what an {id} segment may be: guardian ids are prefix_base62, so an
// escaped character (%2F…) never reaches the engine.
var idSegmentRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// peerKind is the loopback peer check of a route (§8.3 step 4).
type peerKind uint8

const (
	peerNone peerKind = iota
	// peerBrowser: the peer process is reported to the engine, which requires a
	// browser of the claimed family (pairing claim, extension heartbeat, §9.3).
	peerBrowser
	// peerApp: the peer must be the desktop app at config.json appPath in the
	// console session (Nuclear heartbeat, §10.5).
	peerApp
)

// handlerSpec is how one endpoint is served.
type handlerSpec struct {
	serve func(c *call)
	// write marks a mutation, refused in frozen and safe mode (§8.3 step 6). It mirrors
	// the engine's own check, which runs again in the engine turn.
	write bool
	// query are the accepted query parameters (anything else is 400 bad_query).
	query []string
	peer  peerKind
}

// route is one endpoint with its handler.
type route struct {
	spec embedded.EndpointSpec
	h    handlerSpec
}

// template is one path template with its routes by method.
type template struct {
	path     string
	segs     []string
	literals int
	methods  map[string]*route
}

// allow is the Allow header value of the template (§8.3 step 3).
func (t *template) allow() string {
	return strings.Join(slices.Sorted(maps.Keys(t.methods)), ", ")
}

// router matches request paths against the templates, most specific first
// (/v1/study/sessions/current before /v1/study/sessions/{id}).
type router struct {
	templates []*template
	routes    []*route
}

// newRouter builds the router of endpoints with handlers; testOnly endpoints are
// included only when withTestOnly.
func newRouter(endpoints []embedded.EndpointSpec, handlers map[string]handlerSpec, withTestOnly bool) (*router, error) {
	rt := &router{}
	byPath := map[string]*template{}
	used := map[string]bool{}
	for _, ep := range endpoints {
		if ep.TestOnly && !withTestOnly {
			continue
		}
		h, ok := handlers[ep.ID]
		if !ok || h.serve == nil {
			return nil, fmt.Errorf("api: endpoint %q has no handler", ep.ID)
		}
		used[ep.ID] = true
		t := byPath[ep.Path]
		if t == nil {
			segs, literals, err := splitTemplate(ep.Path)
			if err != nil {
				return nil, err
			}
			t = &template{path: ep.Path, segs: segs, literals: literals, methods: map[string]*route{}}
			byPath[ep.Path] = t
			rt.templates = append(rt.templates, t)
		}
		if t.methods[ep.Method] != nil {
			return nil, fmt.Errorf("api: duplicate route %s %s", ep.Method, ep.Path)
		}
		r := &route{spec: ep, h: h}
		t.methods[ep.Method] = r
		rt.routes = append(rt.routes, r)
	}
	for id := range handlers {
		if !used[id] {
			return nil, fmt.Errorf("api: handler %q has no endpoint in the route table", id)
		}
	}
	slices.SortStableFunc(rt.templates, func(a, b *template) int { return b.literals - a.literals })
	return rt, nil
}

// splitTemplate validates a path template and splits it into segments.
func splitTemplate(path string) ([]string, int, error) {
	if !strings.HasPrefix(path, "/v1/") {
		return nil, 0, fmt.Errorf("api: route %q is outside /v1", path)
	}
	segs := strings.Split(path, "/")
	literals := 0
	for _, s := range segs[1:] {
		switch {
		case s == idParam:
		case s == "" || strings.ContainsAny(s, "{}%"):
			return nil, 0, fmt.Errorf("api: malformed route %q", path)
		default:
			literals++
		}
	}
	return segs, literals, nil
}

// match returns the template matching an escaped request path and its id segment.
func (rt *router) match(escapedPath string) (*template, string) {
	segs := strings.Split(escapedPath, "/")
	for _, t := range rt.templates {
		if len(t.segs) != len(segs) {
			continue
		}
		id, ok := "", true
		for i, s := range t.segs {
			if s == idParam {
				if !idSegmentRE.MatchString(segs[i]) {
					ok = false
					break
				}
				id = segs[i]
				continue
			}
			if s != segs[i] {
				ok = false
				break
			}
		}
		if ok {
			return t, id
		}
	}
	return nil, ""
}

// errNoRoutes is returned when the embedded table yields no route at all.
var errNoRoutes = errors.New("api: the embedded route table is empty")
