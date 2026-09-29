package api

import (
	"net/http"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

// testRouter is the router of this build.
func testRouter(t *testing.T) *router {
	t.Helper()
	rt, err := newRouter(embedded.API().Endpoints, handlerTable(), testHooks)
	if err != nil {
		t.Fatalf("newRouter: %v", err)
	}
	return rt
}

// TestRoutesEqualTheEmbeddedTable is the route-table test of §15: the router serves
// exactly the api.json endpoints (testOnly ones only with the testhooks tag).
func TestRoutesEqualTheEmbeddedTable(t *testing.T) {
	rt := testRouter(t)
	var want, got []string
	for _, ep := range embedded.API().Endpoints {
		if ep.TestOnly && !testHooks {
			continue
		}
		want = append(want, ep.ID+" "+ep.Method+" "+ep.Path)
	}
	for _, r := range rt.routes {
		got = append(got, r.spec.ID+" "+r.spec.Method+" "+r.spec.Path)
	}
	slices.Sort(want)
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Fatalf("routes differ from api.json:\n got %v\nwant %v", got, want)
	}
	if len(embedded.API().Endpoints) != 45 {
		t.Fatalf("api.json has %d endpoints, the contract 45", len(embedded.API().Endpoints))
	}
	// Every route matches its own template with a sample id, and the method is served.
	for _, r := range rt.routes {
		path := strings.ReplaceAll(r.spec.Path, idParam, "blk_0123456789abcdefghijkl")
		tm, _ := rt.match(path)
		if tm == nil || tm.methods[r.spec.Method] != r {
			t.Fatalf("%s %s does not route to itself", r.spec.Method, r.spec.Path)
		}
	}
}

// TestNoRouteEndsABlock mirrors the vitest test: /v1/blocks only creates, reads and
// extends; no route ends, shortens, edits or deletes a block (§2).
func TestNoRouteEndsABlock(t *testing.T) {
	rt := testRouter(t)
	var blockRoutes []string
	forbidden := regexp.MustCompile(`shorten|unblock|finish|terminate|stop|end-now|reset`)
	for _, r := range rt.routes {
		if forbidden.MatchString(r.spec.Path) {
			t.Fatalf("route %s %s", r.spec.Method, r.spec.Path)
		}
		if strings.HasPrefix(r.spec.Path, "/v1/blocks") {
			blockRoutes = append(blockRoutes, r.spec.Method+" "+r.spec.Path)
			if r.spec.Method != http.MethodGet && r.spec.Method != http.MethodPost {
				t.Fatalf("block route %s %s", r.spec.Method, r.spec.Path)
			}
		}
	}
	slices.Sort(blockRoutes)
	want := []string{"GET /v1/blocks", "GET /v1/blocks/{id}", "POST /v1/blocks", "POST /v1/blocks/{id}/extend"}
	if !slices.Equal(blockRoutes, want) {
		t.Fatalf("block routes = %v", blockRoutes)
	}
}

func TestTestOnlyRoutesNeedTheTag(t *testing.T) {
	rt := testRouter(t)
	for _, r := range rt.routes {
		if r.spec.TestOnly && !testHooks {
			t.Fatalf("testOnly route %s routed without the testhooks tag", r.spec.ID)
		}
	}
	if tm, _ := rt.match("/v1/_test/clock"); (tm != nil) != testHooks {
		t.Fatalf("/v1/_test/clock routed = %v, testhooks = %v", tm != nil, testHooks)
	}
	if TestHooksEnabled() != testHooks {
		t.Fatal("TestHooksEnabled disagrees with the build")
	}
}

func TestRouterRejectsMismatchedHandlers(t *testing.T) {
	eps := embedded.API().Endpoints
	h := handlerTable()
	delete(h, "health")
	if _, err := newRouter(eps, h, testHooks); err == nil {
		t.Fatal("an endpoint without handler was accepted")
	}
	h = handlerTable()
	h["shortenBlock"] = handlerSpec{serve: func(*call) {}}
	if _, err := newRouter(eps, h, testHooks); err == nil {
		t.Fatal("a handler without endpoint was accepted")
	}
}

func TestRouterMatching(t *testing.T) {
	rt := testRouter(t)
	cases := []struct {
		path, template, id string
	}{
		{"/v1/study/sessions/current", "/v1/study/sessions/current", ""},
		{"/v1/study/sessions/stu_abc", "/v1/study/sessions/{id}", "stu_abc"},
		{"/v1/blocks/blk_x/extend", "/v1/blocks/{id}/extend", "blk_x"},
		{"/v1/blocks/blk_a%2Fb/extend", "", ""},
		{"/v1/blocks/", "", ""},
		{"/v1/blocks//extend", "", ""},
		{"/v1//blocks", "", ""},
		{"/v2/health", "", ""},
		{"/v1/health/", "", ""},
		{"/V1/health", "", ""},
	}
	for _, c := range cases {
		tm, id := rt.match(c.path)
		got := ""
		if tm != nil {
			got = tm.path
		}
		if got != c.template || id != c.id {
			t.Errorf("match(%q) = %q %q, want %q %q", c.path, got, id, c.template, c.id)
		}
	}
}

func TestNotFoundAndMethodNotAllowed(t *testing.T) {
	env := newTestEnv(t)
	expect(t, env.do("GET", "/v1/nope", nil, env.app()), http.StatusNotFound, codeNotFound)
	if !testHooks {
		expect(t, env.do("POST", "/v1/_test/clock", map[string]any{}, env.app()), http.StatusNotFound, codeNotFound)
	}
	r := env.do("DELETE", "/v1/blocks/blk_abc", nil, env.app())
	expect(t, r, http.StatusMethodNotAllowed, codeMethodNotAllowed)
	if got := r.header.Get("Allow"); got != "GET" {
		t.Fatalf("Allow = %q", got)
	}
	r = env.do("PATCH", "/v1/blocks", nil, env.app())
	expect(t, r, http.StatusMethodNotAllowed, codeMethodNotAllowed)
	if got := r.header.Get("Allow"); got != "GET, POST" {
		t.Fatalf("Allow = %q", got)
	}
}
