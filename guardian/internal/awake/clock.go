package awake

import "time"

// timeSource is the inhibitors' clock (a fake in tests).
type timeSource interface {
	Now() time.Time
	NewTimer(d time.Duration) timer
}

// timer is a one-shot timer.
type timer interface {
	C() <-chan time.Time
	Stop() bool
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

func (realClock) NewTimer(d time.Duration) timer { return realTimer{time.NewTimer(d)} }

type realTimer struct{ t *time.Timer }

func (r realTimer) C() <-chan time.Time { return r.t.C }
func (r realTimer) Stop() bool          { return r.t.Stop() }

// slot is an optional running timer: its channel is nil (never ready in a select)
// while nothing runs.
type slot struct{ t timer }

func (s *slot) start(c timeSource, d time.Duration) {
	s.stop()
	s.t = c.NewTimer(d)
}

func (s *slot) stop() {
	if s.t != nil {
		s.t.Stop()
		s.t = nil
	}
}

func (s *slot) running() bool { return s.t != nil }

func (s *slot) c() <-chan time.Time {
	if s.t == nil {
		return nil
	}
	return s.t.C()
}

// fired clears the slot after its channel delivered.
func (s *slot) fired() { s.t = nil }
