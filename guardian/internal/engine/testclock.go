package engine

import "context"

// TestClock is POST /v1/_test/clock (testhooks builds only, §8.8): exactly one action
// on the FakeClock, then one engine step. It is 404 in release builds (the router has no
// route); here it fails unless the engine runs on a *FakeClock.
func (e *Engine) TestClock(ctx context.Context, req TestClockRequest) (TestClockResponse, error) {
	fc, ok := e.o.Clock.(*FakeClock)
	if !ok {
		return TestClockResponse{}, notFound("route")
	}
	n := 0
	for _, set := range []bool{req.AdvanceMs != nil, req.SuspendMs != nil, req.JumpMs != nil, req.Reboot} {
		if set {
			n++
		}
	}
	if n != 1 {
		return TestClockResponse{}, issueErr("$", "rule", "exactly one action")
	}
	if req.Reboot {
		// A reboot restarts the guardian: the test harness re-creates the Engine.
		fc.Reboot()
		return TestClockResponse{ServerNow: fmtTime(fc.Wall()), TrustedNow: fmtTime(fc.Wall())}, nil
	}
	return run(e, ctx, cmdOpts{}, func() (TestClockResponse, error) {
		switch {
		case req.AdvanceMs != nil:
			// Advance in tick-sized steps (at most testClockMaxSteps), like a running
			// guardian would see it, so crediting and completions behave as in real time.
			d := msDuration(*req.AdvanceMs)
			chunk := max(tickInterval, d/testClockMaxSteps)
			for d > 0 {
				s := min(chunk, d)
				fc.Advance(s)
				d -= s
				e.step()
			}
		case req.SuspendMs != nil:
			fc.Suspend(msDuration(*req.SuspendMs))
		case req.JumpMs != nil:
			fc.JumpWall(msDuration(*req.JumpMs))
		}
		e.step()
		return TestClockResponse{ServerNow: e.serverNow(), TrustedNow: fmtMs(e.now)}, nil
	})
}

// testClockMaxSteps bounds the steps of one advance.
const testClockMaxSteps = 5000
