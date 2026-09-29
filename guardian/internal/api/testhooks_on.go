//go:build testhooks

package api

import "github.com/imdlodoem23/centrate/guardian/internal/engine"

// testHooks reports whether this build routes the testOnly endpoints (POST
// /v1/_test/clock, docs/ARCHITECTURE.md §8.8): only builds with the testhooks tag,
// which also report the testhooks capability (engine.Options.TestHooks).
const testHooks = true

// testOnlyHandlers are the handlers of the testOnly endpoints.
func testOnlyHandlers() map[string]handlerSpec {
	return map[string]handlerSpec{
		"testClock": {serve: bodyCmd(200, func(c *call, req engine.TestClockRequest) (engine.TestClockResponse, error) {
			tc, ok := c.s.eng.(TestClocker)
			if !ok {
				return engine.TestClockResponse{}, apiError(codeNotFound, "route not found", nil)
			}
			return tc.TestClock(c.ctx, req)
		})},
	}
}
