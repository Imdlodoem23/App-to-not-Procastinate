// Package awake holds the «Mantener despierto» OS mechanism (docs/ARCHITECTURE.md
// §5.11, §10.14): while the engine asks it to hold, the machine does not go to sleep on
// idle. It never keeps the display on (the desktop app does that while it runs) and never
// overrides the lid or a manual sleep.
//
//   - Windows: SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) from one
//     goroutine locked to its OS thread; ES_CONTINUOUS alone releases it.
//   - macOS: a supervised child `/usr/bin/caffeinate -i -w <guardian pid>`.
//   - Linux: a supervised child `systemd-inhibit --what=idle:sleep --who=Céntrate
//     "--why=Mantener despierto" --mode=block <sleep> infinity`.
//
// Every argument vector is fixed (argv.go): the inhibitor only ever receives a boolean
// from the engine, never request data, and nothing runs through a shell or PATH.
package awake

import (
	"io"
	"log/slog"
	"sync"
)

// Status errors (KEEP_AWAKE_ERRORS in domain.ts).
const (
	// ErrUnsupported: this machine has no mechanism (reported whether holding or not).
	ErrUnsupported = "unsupported"
	// ErrFailed: the mechanism failed while holding; the inhibitor keeps retrying.
	ErrFailed = "failed"
)

// Status is what is true right now.
type Status struct {
	// Active: the OS idle-sleep inhibition is held.
	Active bool
	// Err is "", ErrUnsupported or ErrFailed. Active implies "".
	Err string
}

// Inhibitor owns the OS idle-sleep inhibition.
type Inhibitor interface {
	// Hold holds (true) or releases (false) the inhibition. Idempotent; it never blocks.
	Hold(on bool)
	// Status is what is true right now (while released: "" or ErrUnsupported).
	Status() Status
	// Close releases the inhibition and waits for it (about 2 s at most, 4 s when a
	// child ignores SIGTERM). Hold does nothing afterwards.
	Close()
}

// Option configures New.
type Option func(*options)

type options struct {
	log *slog.Logger
}

// WithLogger sets where transitions and failures are logged (mechanism, exit status;
// never request data). Default: discarded.
func WithLogger(l *slog.Logger) Option {
	return func(o *options) {
		if l != nil {
			o.log = l
		}
	}
}

func newOptions(opts []Option) options {
	o := options{log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	for _, f := range opts {
		f(&o)
	}
	return o
}

// unsupported is the inhibitor of a machine without a mechanism.
type unsupported struct{}

func (unsupported) Hold(bool)      {}
func (unsupported) Status() Status { return Status{Err: ErrUnsupported} }
func (unsupported) Close()         {}

// Unsupported returns an inhibitor that never holds and always reports ErrUnsupported.
func Unsupported() Inhibitor { return unsupported{} }

// statusBox is a Status shared between the worker goroutine and callers; set reports a
// change to onChange (outside the lock).
type statusBox struct {
	mu       sync.Mutex
	st       Status
	onChange func()
}

func (b *statusBox) get() Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.st
}

func (b *statusBox) set(st Status) {
	b.mu.Lock()
	changed := b.st != st
	b.st = st
	b.mu.Unlock()
	if changed && b.onChange != nil {
		b.onChange()
	}
}

// request is the wanted state shared between Hold/Close and the worker goroutine.
type request struct {
	mu     sync.Mutex
	want   bool
	closed bool
	wake   chan struct{}
	quit   chan struct{}
	done   chan struct{}
}

func newRequest() *request {
	return &request{wake: make(chan struct{}, 1), quit: make(chan struct{}), done: make(chan struct{})}
}

func (r *request) hold(on bool) {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.want = on
	r.mu.Unlock()
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// wanted is the wanted state and whether Close was called.
func (r *request) wanted() (want, closed bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.want && !r.closed, r.closed
}

func (r *request) close() {
	r.mu.Lock()
	if !r.closed {
		r.closed = true
		close(r.quit)
	}
	r.mu.Unlock()
	<-r.done
}
