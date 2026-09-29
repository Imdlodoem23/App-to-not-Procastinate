package awake

import (
	"errors"
	"slices"
	"sync"
	"testing"
	"time"
)

// fakeClock is a manual clock: timers fire only when Advance reaches them.
type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

type fakeTimer struct {
	clk     *fakeClock
	c       chan time.Time
	d       time.Duration
	at      time.Time
	stopped bool
	fired   bool
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 9, 29, 16, 30, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) NewTimer(d time.Duration) timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{clk: c, c: make(chan time.Time, 1), d: d, at: c.now.Add(d)}
	c.timers = append(c.timers, t)
	return t
}

func (t *fakeTimer) C() <-chan time.Time { return t.c }

func (t *fakeTimer) Stop() bool {
	t.clk.mu.Lock()
	defer t.clk.mu.Unlock()
	live := !t.stopped && !t.fired
	t.stopped = true
	return live
}

// Advance moves the clock and fires the timers it reaches.
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	for _, t := range c.timers {
		if !t.stopped && !t.fired && !t.at.After(c.now) {
			t.fired = true
			t.c <- c.now
		}
	}
}

// pending are the durations of the timers still running.
func (c *fakeClock) pending() []time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []time.Duration
	for _, t := range c.timers {
		if !t.stopped && !t.fired {
			out = append(out, t.d)
		}
	}
	slices.Sort(out)
	return out
}

// errSignal is how a fake child reports it was signalled.
var errSignal = errors.New("signal: terminated")

// fakeProc is a child that exits when told or when signalled.
type fakeProc struct {
	mu         sync.Mutex
	exit       chan error
	signals    []bool
	ignoreTerm bool
	reaped     bool
}

func (p *fakeProc) Wait() error {
	err := <-p.exit
	p.mu.Lock()
	p.reaped = true
	p.mu.Unlock()
	return err
}

func (p *fakeProc) Signal(kill bool) error {
	p.mu.Lock()
	p.signals = append(p.signals, kill)
	ignore := p.ignoreTerm && !kill
	p.mu.Unlock()
	if !ignore {
		p.exitWith(errSignal)
	}
	return nil
}

func (p *fakeProc) exitWith(err error) {
	select {
	case p.exit <- err:
	default:
	}
}

func (p *fakeProc) state() (signals []bool, reaped bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.signals), p.reaped
}

// fakeRunner starts fake children, or fails with startErr.
type fakeRunner struct {
	mu         sync.Mutex
	procs      []*fakeProc
	startErr   error
	ignoreTerm bool
	attempts   int
}

func (r *fakeRunner) start() (process, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.attempts++
	if r.startErr != nil {
		return nil, r.startErr
	}
	p := &fakeProc{exit: make(chan error, 1), ignoreTerm: r.ignoreTerm}
	r.procs = append(r.procs, p)
	return p, nil
}

func (r *fakeRunner) count() (attempts, started int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.attempts, len(r.procs)
}

func (r *fakeRunner) last() *fakeProc {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.procs[len(r.procs)-1]
}

func (r *fakeRunner) setStartErr(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.startErr = err
}

// changes counts onChange calls.
type changes struct {
	mu sync.Mutex
	n  int
}

func (c *changes) inc() {
	c.mu.Lock()
	c.n++
	c.mu.Unlock()
}

func (c *changes) get() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

// waitFor polls cond (the inhibitors run on their own goroutine) for up to 10 s.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

// waitPending waits until exactly these timers run.
func waitPending(t *testing.T, c *fakeClock, want ...time.Duration) {
	t.Helper()
	slices.Sort(want)
	waitFor(t, "timers "+durations(want), func() bool { return slices.Equal(c.pending(), want) })
}

func durations(ds []time.Duration) string {
	s := "["
	for i, d := range ds {
		if i > 0 {
			s += " "
		}
		s += d.String()
	}
	return s + "]"
}
