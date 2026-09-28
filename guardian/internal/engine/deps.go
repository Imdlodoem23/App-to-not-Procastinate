package engine

import (
	"context"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/clock"
	"github.com/imdlodoem23/centrate/guardian/internal/hosts"
	"github.com/imdlodoem23/centrate/guardian/internal/procwatch"
)

// The engine depends only on these interfaces (docs/ARCHITECTURE.md §15); fakes.go and
// fakeclock.go hold the fakes. The zero Options select the real implementations.

// Clock is the engine's view of the machine's clocks (§4). The trusted clock is a
// clock.Detector fed from these readings; nothing in the engine reads time.Now.
type Clock interface {
	// Wall reads the system wall clock.
	Wall() time.Time
	// Boot reads a monotonic clock that keeps counting during suspend.
	Boot() time.Duration
	// Awake reads a monotonic clock that stops during suspend.
	Awake() time.Duration
	// BootID identifies the current boot (read once per Engine).
	BootID() (string, error)
}

// clockNames is implemented by clocks that name their sources for diagnostics.
type clockNames interface {
	BootClockName() string
	AwakeClockName() string
}

// SystemClock is the real Clock: time.Now and the clock package's sources.
type SystemClock struct{}

// Wall implements Clock.
func (SystemClock) Wall() time.Time { return time.Now() }

// Boot implements Clock.
func (SystemClock) Boot() time.Duration { return clock.BootTime() }

// Awake implements Clock.
func (SystemClock) Awake() time.Duration { return clock.AwakeTime() }

// BootID implements Clock.
func (SystemClock) BootID() (string, error) { return clock.BootID() }

// BootClockName implements clockNames.
func (SystemClock) BootClockName() string { return clock.BootClockName() }

// AwakeClockName implements clockNames.
func (SystemClock) AwakeClockName() string { return clock.AwakeClockName() }

// HostsManager is the hosts layer. *hosts.Manager satisfies it.
type HostsManager interface {
	// Apply makes the Céntrate section list exactly domains (empty: remove it).
	Apply(domains []string) error
	// Remove deletes the section.
	Remove() error
	// Verify reports whether the file already is what Apply(expected) would write.
	Verify(expected []string) (bool, error)
	// Current returns the domains the section lists now.
	Current() ([]string, error)
	// Recover restores a file damaged by an interrupted write (startup).
	Recover() (bool, error)
	// Watch calls onChange when someone else changes the file, until ctx is done.
	Watch(ctx context.Context, onChange func()) error
}

// HostsSectionHeader is implemented by a hosts layer that writes and parses the
// "# centrate-hosts v1 until=… count=…" header line (§10.10), so enforcement survives
// the loss of every state file (§10.12). The engine uses it when available; the current
// hosts.Manager does not implement it yet (docs/ARCHITECTURE.md §17 item 4).
type HostsSectionHeader interface {
	// ApplyUntil is Apply that also writes until (the latest trusted endsAt).
	ApplyUntil(domains []string, until time.Time) error
	// Section parses the current section: its domains and until; ok is false when there
	// is no section or no header.
	Section() (domains []string, until time.Time, ok bool, err error)
}

// DNSFlusher clears the OS resolver cache after a hosts change.
type DNSFlusher interface {
	FlushDNS(ctx context.Context) error
}

// DNSFlusherFunc adapts a function to DNSFlusher.
type DNSFlusherFunc func(ctx context.Context) error

// FlushDNS calls f.
func (f DNSFlusherFunc) FlushDNS(ctx context.Context) error { return f(ctx) }

// systemFlusher is the real flusher (fixed commands, §9.7).
var systemFlusher DNSFlusher = DNSFlusherFunc(func(ctx context.Context) error { return hosts.FlushDNS(ctx, nil) })

// NetworkTime asks trusted network sources for the current time (§10.2). ok is false
// when offline or when the sources disagree.
type NetworkTime interface {
	NetworkNow(ctx context.Context, trustedNow func() time.Time) (t time.Time, ok bool)
}

// NetworkTimeFunc adapts a function (such as clock.NetworkTime) to NetworkTime.
type NetworkTimeFunc func(ctx context.Context, trustedNow func() time.Time) (time.Time, bool)

// NetworkNow calls f.
func (f NetworkTimeFunc) NetworkNow(ctx context.Context, trustedNow func() time.Time) (time.Time, bool) {
	return f(ctx, trustedNow)
}

// NuclearRelauncher is the Nuclear supervisor's OS side (§10.5): whether the app runs
// in the console session from its admin-owned appPath, and relaunching it there as the
// console user with the constant argument --centrate-nuclear.
type NuclearRelauncher interface {
	AppRunning() (bool, error)
	Relaunch(ctx context.Context) error
}

// ProcessLister lists processes (procwatch.Lister; the real one is procwatch.OSLister).
type ProcessLister = procwatch.Lister

// ProcessKiller closes processes by PID (procwatch.Killer; the real one is
// procwatch.OSKiller).
type ProcessKiller = procwatch.Killer

// Ticker is what the engine loop waits on between steps (a *time.Ticker by default).
type Ticker interface {
	C() <-chan time.Time
	Stop()
}

type realTicker struct{ t *time.Ticker }

func (r realTicker) C() <-chan time.Time { return r.t.C }
func (r realTicker) Stop()               { r.t.Stop() }

func newRealTicker(d time.Duration) Ticker { return realTicker{time.NewTicker(d)} }
