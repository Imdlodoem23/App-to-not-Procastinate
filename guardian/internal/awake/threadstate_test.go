package awake

import (
	"slices"
	"sync"
	"testing"
)

// fakeExecState records SetThreadExecutionState calls and fails on demand.
type fakeExecState struct {
	mu    sync.Mutex
	calls []uint32
	fail  bool
	tids  []int
}

func (f *fakeExecState) set(flags uint32) uint32 {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, flags)
	f.tids = append(f.tids, threadID())
	if f.fail {
		return 0
	}
	return esContinuous
}

func (f *fakeExecState) get() []uint32 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

func (f *fakeExecState) setFail(v bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fail = v
}

const holdFlags = esContinuous | esSystemRequired

// Holding sets ES_CONTINUOUS|ES_SYSTEM_REQUIRED once; releasing sets ES_CONTINUOUS
// alone; Close releases.
func TestThreadStateHoldsAndReleases(t *testing.T) {
	f := &fakeExecState{}
	clk := newFakeClock()
	ch := &changes{}
	s := newThreadState(f.set, clk, newOptions(nil), ch.inc)
	s.Hold(true)
	s.Hold(true)
	waitFor(t, "held", statusIs(s, Status{Active: true}))
	s.Hold(false)
	waitFor(t, "released", statusIs(s, Status{}))
	s.Hold(true)
	waitFor(t, "held again", statusIs(s, Status{Active: true}))
	s.Close()
	if got, want := f.get(), []uint32{holdFlags, esContinuous, holdFlags, esContinuous}; !slices.Equal(got, want) {
		t.Fatalf("calls %#x, want %#x", got, want)
	}
	if ch.get() < 4 {
		t.Fatalf("onChange called %d times", ch.get())
	}
	s.Hold(true)
	if len(f.get()) != 4 || s.Status() != (Status{}) {
		t.Fatal("Hold after Close changed something")
	}
	assertOneThread(t, f)
}

// A zero return is failed, retried every 60 s while holding.
func TestThreadStateFailure(t *testing.T) {
	f := &fakeExecState{fail: true}
	clk := newFakeClock()
	s := newThreadState(f.set, clk, newOptions(nil), nil)
	defer s.Close()
	s.Hold(true)
	waitFor(t, "failed", statusIs(s, Status{Err: ErrFailed}))
	waitPending(t, clk, backoffMax)
	clk.Advance(backoffMax)
	waitFor(t, "retried", func() bool { return len(f.get()) == 2 })
	f.setFail(false)
	waitPending(t, clk, backoffMax)
	clk.Advance(backoffMax)
	waitFor(t, "held", statusIs(s, Status{Active: true}))
	// Releasing while failed needs no call; while held it does.
	s.Hold(false)
	waitFor(t, "released", statusIs(s, Status{}))
	if got, want := f.get(), []uint32{holdFlags, holdFlags, holdFlags, esContinuous}; !slices.Equal(got, want) {
		t.Fatalf("calls %#x, want %#x", got, want)
	}
}
