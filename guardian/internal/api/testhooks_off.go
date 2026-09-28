//go:build !testhooks

package api

// testHooks reports whether this build routes the testOnly endpoints (POST
// /v1/_test/clock). Release builds never do: the route does not exist (404).
const testHooks = false

// testOnlyHandlers are the handlers of the testOnly endpoints: none in release builds.
func testOnlyHandlers() map[string]handlerSpec { return nil }
