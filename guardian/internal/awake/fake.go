package awake

import (
	"slices"
	"sync"
)

// Fake is an Inhibitor for tests (engine, API, integration): it records every Hold and
// holds at once unless told the mechanism is unsupported or failing. Safe for
// concurrent use.
type Fake struct {
	mu          sync.Mutex
	onChange    func()
	held        bool
	holds       []bool
	unsupported bool
	failing     bool
	closed      bool
}

// NewFake returns a Fake that calls onChange (may be nil) when its Status changes.
func NewFake(onChange func()) *Fake { return &Fake{onChange: onChange} }

// SetOnChange replaces the change callback (a Fake reused by the next engine).
func (f *Fake) SetOnChange(onChange func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.onChange = onChange
}

func (f *Fake) statusLocked() Status {
	switch {
	case f.unsupported:
		return Status{Err: ErrUnsupported}
	case f.held && f.failing:
		return Status{Err: ErrFailed}
	case f.held:
		return Status{Active: true}
	}
	return Status{}
}

// change runs mut under the lock and calls onChange when the Status changed.
func (f *Fake) change(mut func()) {
	f.mu.Lock()
	before := f.statusLocked()
	mut()
	changed := f.statusLocked() != before
	cb := f.onChange
	f.mu.Unlock()
	if changed && cb != nil {
		cb()
	}
}

// Hold implements Inhibitor.
func (f *Fake) Hold(on bool) {
	f.change(func() {
		if f.closed {
			return
		}
		f.holds = append(f.holds, on)
		f.held = on
	})
}

// Status implements Inhibitor.
func (f *Fake) Status() Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.statusLocked()
}

// Close implements Inhibitor: released, and Hold does nothing afterwards.
func (f *Fake) Close() {
	f.change(func() {
		f.held = false
		f.closed = true
	})
}

// Reopen undoes Close (a restarted engine reusing the Fake).
func (f *Fake) Reopen() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = false
}

// Held reports whether the last Hold asked to hold (and Close was not called).
func (f *Fake) Held() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.held
}

// Holds returns every Hold argument so far, in order.
func (f *Fake) Holds() []bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.holds)
}

// Closed reports whether Close was called.
func (f *Fake) Closed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

// SetUnsupported makes Status report ErrUnsupported (the machine has no mechanism).
func (f *Fake) SetUnsupported(v bool) { f.change(func() { f.unsupported = v }) }

// SetFailing makes a held inhibition report ErrFailed (the mechanism keeps failing).
func (f *Fake) SetFailing(v bool) { f.change(func() { f.failing = v }) }

var _ Inhibitor = (*Fake)(nil)
