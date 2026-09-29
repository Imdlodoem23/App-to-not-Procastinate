package awake

import (
	"errors"
	"slices"
	"testing"
	"time"
)

func newTestSupervisor(t *testing.T, r *fakeRunner) (*supervisor, *fakeClock, *changes) {
	t.Helper()
	clk := newFakeClock()
	ch := &changes{}
	s := newSupervisor("fake", r.start, clk, newOptions(nil), ch.inc)
	t.Cleanup(func() {
		done := make(chan struct{})
		go func() { s.Close(); close(done) }()
		// A child that ignores SIGTERM needs the clock to reach SIGKILL.
		for {
			select {
			case <-done:
				return
			case <-time.After(5 * time.Millisecond):
				clk.Advance(termGrace)
			}
		}
	})
	return s, clk, ch
}

func statusIs(s Inhibitor, want Status) func() bool {
	return func() bool { return s.Status() == want }
}

// Holding starts one child, which counts as held once it stayed up settleAfter;
// releasing sends SIGTERM to it and reaps it.
func TestSupervisorHoldsAndReleases(t *testing.T) {
	r := &fakeRunner{}
	s, clk, ch := newTestSupervisor(t, r)
	if s.Status() != (Status{}) {
		t.Fatalf("initial status %+v", s.Status())
	}
	s.Hold(true)
	s.Hold(true) // idempotent
	waitPending(t, clk, settleAfter, stableAfter)
	if a, n := r.count(); a != 1 || n != 1 {
		t.Fatalf("attempts %d, started %d", a, n)
	}
	if s.Status().Active {
		t.Fatal("active before the child settled")
	}
	clk.Advance(settleAfter)
	waitFor(t, "active", statusIs(s, Status{Active: true}))
	if ch.get() == 0 {
		t.Fatal("onChange not called")
	}
	p := r.last()
	s.Hold(false)
	waitFor(t, "released", statusIs(s, Status{}))
	waitFor(t, "reaped", func() bool { sig, reaped := p.state(); return reaped && slices.Equal(sig, []bool{false}) })
	waitPending(t, clk)
	if a, _ := r.count(); a != 1 {
		t.Fatalf("attempts %d after release", a)
	}
}

// A child that exits is restarted after 1 s, 2 s…; three quick exits in a row set
// failed and retries continue every 60 s; a child up for 60 s clears it.
func TestSupervisorRestartBackoffAndFailed(t *testing.T) {
	r := &fakeRunner{}
	s, clk, _ := newTestSupervisor(t, r)
	s.Hold(true)
	waitPending(t, clk, settleAfter, stableAfter)

	r.last().exitWith(errors.New("exit status 1"))
	waitPending(t, clk, time.Second)
	if st := s.Status(); st != (Status{}) {
		t.Fatalf("after one exit %+v", st)
	}
	clk.Advance(time.Second)
	waitPending(t, clk, settleAfter, stableAfter)
	r.last().exitWith(errors.New("exit status 1"))
	waitPending(t, clk, 2*time.Second)
	if st := s.Status(); st != (Status{}) {
		t.Fatalf("after two exits %+v", st)
	}
	clk.Advance(2 * time.Second)
	waitPending(t, clk, settleAfter, stableAfter)
	r.last().exitWith(errors.New("exit status 1"))
	waitPending(t, clk, backoffMax)
	waitFor(t, "failed", statusIs(s, Status{Err: ErrFailed}))

	// The next child: still failed until it stayed up 60 s.
	clk.Advance(backoffMax)
	waitPending(t, clk, settleAfter, stableAfter)
	clk.Advance(settleAfter)
	waitPending(t, clk, stableAfter)
	if st := s.Status(); st != (Status{Err: ErrFailed}) {
		t.Fatalf("settled while failed %+v", st)
	}
	clk.Advance(stableAfter - settleAfter)
	waitFor(t, "recovered", statusIs(s, Status{Active: true}))
	if _, n := r.count(); n != 4 {
		t.Fatalf("children %d", n)
	}

	// After 60 s up, an exit starts the backoff from 1 s again.
	r.last().exitWith(nil)
	waitPending(t, clk, time.Second)
	waitFor(t, "not active", statusIs(s, Status{}))
}

// Exits spaced by more than 60 s of uptime never add up to failed.
func TestSupervisorLongRunsResetTheCount(t *testing.T) {
	r := &fakeRunner{}
	s, clk, _ := newTestSupervisor(t, r)
	s.Hold(true)
	for i := range 5 {
		waitPending(t, clk, settleAfter, stableAfter)
		clk.Advance(stableAfter)
		waitFor(t, "active", statusIs(s, Status{Active: true}))
		r.last().exitWith(errors.New("exit status 1"))
		waitPending(t, clk, time.Second)
		if st := s.Status(); st.Err != "" {
			t.Fatalf("exit %d: %+v", i, st)
		}
		clk.Advance(time.Second)
	}
}

// A start error counts as a quick exit.
func TestSupervisorStartErrors(t *testing.T) {
	r := &fakeRunner{startErr: errors.New("fork/exec: permission denied")}
	s, clk, _ := newTestSupervisor(t, r)
	s.Hold(true)
	waitPending(t, clk, time.Second)
	clk.Advance(time.Second)
	waitPending(t, clk, 2*time.Second)
	clk.Advance(2 * time.Second)
	waitPending(t, clk, backoffMax)
	waitFor(t, "failed", statusIs(s, Status{Err: ErrFailed}))
	r.setStartErr(nil)
	clk.Advance(backoffMax)
	waitPending(t, clk, settleAfter, stableAfter)
	// Releasing clears failed at once.
	s.Hold(false)
	waitFor(t, "released", statusIs(s, Status{}))
	waitPending(t, clk)
}

// Releasing a child that ignores SIGTERM kills it after 2 s and reaps it.
func TestSupervisorReleaseKills(t *testing.T) {
	r := &fakeRunner{ignoreTerm: true}
	s, clk, _ := newTestSupervisor(t, r)
	s.Hold(true)
	waitPending(t, clk, settleAfter, stableAfter)
	p := r.last()
	s.Hold(false)
	waitPending(t, clk, termGrace)
	if sig, reaped := p.state(); reaped || !slices.Equal(sig, []bool{false}) {
		t.Fatalf("before the grace: signals %v, reaped %v", sig, reaped)
	}
	clk.Advance(termGrace)
	waitFor(t, "killed and reaped", func() bool {
		sig, reaped := p.state()
		return reaped && slices.Equal(sig, []bool{false, true})
	})
	waitFor(t, "released", statusIs(s, Status{}))
}

// Close releases and waits; Hold does nothing afterwards.
func TestSupervisorClose(t *testing.T) {
	r := &fakeRunner{}
	clk := newFakeClock()
	s := newSupervisor("fake", r.start, clk, newOptions(nil), nil)
	s.Hold(true)
	waitPending(t, clk, settleAfter, stableAfter)
	p := r.last()
	s.Close()
	if sig, reaped := p.state(); !reaped || !slices.Equal(sig, []bool{false}) {
		t.Fatalf("after Close: signals %v, reaped %v", sig, reaped)
	}
	s.Hold(true)
	s.Close() // twice is fine
	if a, _ := r.count(); a != 1 {
		t.Fatalf("started after Close: %d attempts", a)
	}
	if s.Status() != (Status{}) {
		t.Fatalf("status after Close %+v", s.Status())
	}
}

func TestBackoff(t *testing.T) {
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 32 * time.Second, 60 * time.Second, 60 * time.Second}
	for i, w := range want {
		if got := backoff(i + 1); got != w {
			t.Fatalf("backoff(%d) = %s, want %s", i+1, got, w)
		}
	}
}
