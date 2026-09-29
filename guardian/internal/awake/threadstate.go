package awake

import (
	"log/slog"
	"runtime"
)

// The Windows mechanism (§10.14): the execution state belongs to the calling thread, so
// one goroutine locked to its OS thread for the inhibitor's whole life sets
// ES_CONTINUOUS|ES_SYSTEM_REQUIRED while holding and ES_CONTINUOUS alone to release. A
// zero return is ErrFailed, retried every backoffMax while holding. The logic is
// OS-independent (tested everywhere); awake_windows.go supplies the real call.

// Execution-state flags (winbase.h).
const (
	esContinuous     uint32 = 0x80000000
	esSystemRequired uint32 = 0x00000001
)

// setStateFunc is SetThreadExecutionState: the previous state, or 0 on failure.
type setStateFunc func(flags uint32) uint32

// threadState is the Inhibitor of the thread execution-state mechanism.
type threadState struct {
	set    setStateFunc
	clock  timeSource
	log    *slog.Logger
	req    *request
	status statusBox
}

func newThreadState(set setStateFunc, clock timeSource, o options, onChange func()) *threadState {
	s := &threadState{set: set, clock: clock, log: o.log, req: newRequest(), status: statusBox{onChange: onChange}}
	go s.run()
	return s
}

// Hold implements Inhibitor.
func (s *threadState) Hold(on bool) { s.req.hold(on) }

// Status implements Inhibitor.
func (s *threadState) Status() Status { return s.status.get() }

// Close implements Inhibitor.
func (s *threadState) Close() { s.req.close() }

func (s *threadState) run() {
	defer close(s.req.done)
	// Every call must come from this one thread: the state is per thread and ends with
	// it.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	var (
		held   bool
		failed bool
		retry  slot
	)
	for {
		want, closed := s.req.wanted()
		switch {
		case want && !held && !retry.running():
			if s.set(esContinuous|esSystemRequired) == 0 {
				if !failed {
					s.log.Warn("keep-awake: SetThreadExecutionState failed", "mechanism", "SetThreadExecutionState")
				}
				failed = true
				retry.start(s.clock, backoffMax)
				s.status.set(Status{Err: ErrFailed})
				break
			}
			held, failed = true, false
			s.log.Info("keep-awake: inhibitor held", "mechanism", "SetThreadExecutionState")
			s.status.set(Status{Active: true})
		case !want && (held || failed || retry.running()):
			retry.stop()
			if held {
				if s.set(esContinuous) == 0 {
					s.log.Warn("keep-awake: releasing the execution state failed", "mechanism", "SetThreadExecutionState")
				}
				s.log.Info("keep-awake: inhibitor released", "mechanism", "SetThreadExecutionState")
			}
			held, failed = false, false
			s.status.set(Status{})
		}
		if closed {
			return
		}
		select {
		case <-s.req.wake:
		case <-s.req.quit:
		case <-retry.c():
			retry.fired()
		}
	}
}

// Compile-time checks.
var (
	_ Inhibitor = (*threadState)(nil)
	_ Inhibitor = (*supervisor)(nil)
	_ Inhibitor = unsupported{}
)
