package awake

import (
	"log/slog"
	"runtime"
	"time"
)

// Supervision of a child process that holds the inhibition while it lives (macOS
// caffeinate, Linux systemd-inhibit; §10.14):
//
//   - while holding, a child that exits is restarted after 1 s, 2 s, 4 s … up to 60 s;
//     Active is false meanwhile;
//   - three exits in a row, each within 60 s of its start (a start error counts as
//     one), set ErrFailed and the retries continue every 60 s; a child that stays up
//     for 60 s resets the count and clears ErrFailed;
//   - a child counts as holding (Active) once it has stayed up for settleAfter: a
//     mechanism that refuses (logind policy, a missing assertion) exits at once;
//   - releasing sends SIGTERM to its process group, waits 2 s, then SIGKILL, and reaps.
const (
	settleAfter = time.Second
	stableAfter = 60 * time.Second
	backoffMin  = time.Second
	backoffMax  = 60 * time.Second
	failedAfter = 3
	termGrace   = 2 * time.Second
)

// process is a started child.
type process interface {
	// Wait blocks until the child exits and reaps it.
	Wait() error
	// Signal sends SIGTERM (kill false) or SIGKILL (kill true) to the child's process
	// group.
	Signal(kill bool) error
}

// startFunc starts the child with its fixed argument vector.
type startFunc func() (process, error)

// supervisor is the Inhibitor of the child-process mechanisms.
type supervisor struct {
	mechanism string
	start     startFunc
	clock     timeSource
	log       *slog.Logger
	req       *request
	status    statusBox
}

func newSupervisor(mechanism string, start startFunc, clock timeSource, o options, onChange func()) *supervisor {
	s := &supervisor{
		mechanism: mechanism,
		start:     start,
		clock:     clock,
		log:       o.log,
		req:       newRequest(),
		status:    statusBox{onChange: onChange},
	}
	go s.run()
	return s
}

// Hold implements Inhibitor.
func (s *supervisor) Hold(on bool) { s.req.hold(on) }

// Status implements Inhibitor.
func (s *supervisor) Status() Status { return s.status.get() }

// Close implements Inhibitor.
func (s *supervisor) Close() { s.req.close() }

// backoff is the restart delay after the n-th exit in a row (n ≥ 1).
func backoff(n int) time.Duration {
	d := backoffMin
	for i := 1; i < n && d < backoffMax; i++ {
		d *= 2
	}
	return min(d, backoffMax)
}

func (s *supervisor) run() {
	defer close(s.req.done)
	// Linux sends Pdeathsig when the thread that started the child ends, not the
	// process: every child is started from this one thread, which lives as long as the
	// supervisor.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	var (
		child   process
		exited  chan error
		started time.Time
		// exits counts the exits since the last child that stayed up stableAfter.
		exits  int
		failed bool
		retry  slot
		settle slot
		stable slot
	)
	for {
		want, closed := s.req.wanted()
		switch {
		case want && child == nil && !retry.running():
			p, err := s.start()
			if err != nil {
				exits++
				failed = failed || exits >= failedAfter
				s.log.Warn("keep-awake: the inhibitor could not start", "mechanism", s.mechanism, "err", err, "exitsInARow", exits)
				retry.start(s.clock, s.retryDelay(exits, failed))
				s.status.set(s.waiting(failed))
				break
			}
			child, started = p, s.clock.Now()
			exited = make(chan error, 1)
			go func() { exited <- p.Wait() }()
			settle.start(s.clock, settleAfter)
			stable.start(s.clock, stableAfter)
			s.log.Info("keep-awake: inhibitor started", "mechanism", s.mechanism)
		case !want && (child != nil || retry.running() || exits > 0):
			retry.stop()
			settle.stop()
			stable.stop()
			if child != nil {
				s.release(child, exited)
				s.log.Info("keep-awake: inhibitor released", "mechanism", s.mechanism)
			}
			child, exited, exits, failed = nil, nil, 0, false
		}
		if !want {
			s.status.set(Status{})
		}
		if closed {
			return
		}
		select {
		case <-s.req.wake:
		case <-s.req.quit:
		case err := <-exited:
			settle.stop()
			stable.stop()
			up := s.clock.Now().Sub(started)
			child, exited = nil, nil
			exits++
			failed = failed || exits >= failedAfter
			s.log.Warn("keep-awake: the inhibitor exited", "mechanism", s.mechanism, "status", exitStatus(err),
				"uptime", up.Round(time.Millisecond).String(), "exitsInARow", exits, "failed", failed)
			retry.start(s.clock, s.retryDelay(exits, failed))
			s.status.set(s.waiting(failed))
		case <-retry.c():
			retry.fired()
		case <-settle.c():
			settle.fired()
			if !failed {
				s.status.set(Status{Active: true})
			}
		case <-stable.c():
			stable.fired()
			if failed {
				s.log.Info("keep-awake: the inhibitor holds again", "mechanism", s.mechanism)
			}
			exits, failed = 0, false
			s.status.set(Status{Active: true})
		}
	}
}

func (s *supervisor) retryDelay(exits int, failed bool) time.Duration {
	if failed {
		return backoffMax
	}
	return backoff(exits)
}

// waiting is the status while no child holds.
func (s *supervisor) waiting(failed bool) Status {
	if failed {
		return Status{Err: ErrFailed}
	}
	return Status{}
}

// release ends the child: SIGTERM to its group, SIGKILL after termGrace, then reaped.
func (s *supervisor) release(p process, exited <-chan error) {
	if err := p.Signal(false); err != nil {
		s.log.Debug("keep-awake: SIGTERM not delivered", "mechanism", s.mechanism, "err", err)
	}
	t := s.clock.NewTimer(termGrace)
	select {
	case <-exited:
		t.Stop()
		return
	case <-t.C():
	}
	s.log.Warn("keep-awake: the inhibitor ignored SIGTERM; killing it", "mechanism", s.mechanism)
	if err := p.Signal(true); err != nil {
		s.log.Debug("keep-awake: SIGKILL not delivered", "mechanism", s.mechanism, "err", err)
	}
	t = s.clock.NewTimer(termGrace)
	defer t.Stop()
	select {
	case <-exited:
	case <-t.C():
		s.log.Error("keep-awake: the inhibitor was not reaped", "mechanism", s.mechanism)
	}
}

// exitStatus describes how a child ended ("exit status 1", "signal: killed").
func exitStatus(err error) string {
	if err == nil {
		return "exit status 0"
	}
	return err.Error()
}
