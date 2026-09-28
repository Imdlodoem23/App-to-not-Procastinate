package engine

import (
	"context"
	"slices"
	"sync"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/procwatch"
)

// Fakes of the engine's dependencies for tests (this package's and the API layer's).
// They never touch the system.

// FakeHosts is an in-memory HostsManager. Tamper simulates someone editing the section
// and notifies a running Watch.
type FakeHosts struct {
	mu       sync.Mutex
	section  []string // sorted; nil when there is no section
	applies  int
	removes  int
	onChange func()
	// ApplyErr, when set, makes Apply and Remove fail without changing anything.
	ApplyErr error
	// OnApply, when set, is called at the start of every Apply and Remove (tests use it
	// to record the commit order).
	OnApply func()
}

// SetApplyErr sets ApplyErr while writes may be running on the engine's worker.
func (f *FakeHosts) SetApplyErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ApplyErr = err
}

// NewFakeHosts returns an empty FakeHosts.
func NewFakeHosts() *FakeHosts { return &FakeHosts{} }

// Apply implements HostsManager.
func (f *FakeHosts) Apply(domains []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.OnApply != nil {
		f.OnApply()
	}
	if f.ApplyErr != nil {
		return f.ApplyErr
	}
	f.applies++
	if len(domains) == 0 {
		f.section = nil
		return nil
	}
	s := slices.Clone(domains)
	slices.Sort(s)
	f.section = slices.Compact(s)
	return nil
}

// Remove implements HostsManager.
func (f *FakeHosts) Remove() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.OnApply != nil {
		f.OnApply()
	}
	if f.ApplyErr != nil {
		return f.ApplyErr
	}
	f.removes++
	f.section = nil
	return nil
}

// Verify implements HostsManager.
func (f *FakeHosts) Verify(expected []string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := slices.Clone(expected)
	slices.Sort(s)
	s = slices.Compact(s)
	if len(s) == 0 {
		return f.section == nil, nil
	}
	return slices.Equal(s, f.section), nil
}

// Current implements HostsManager.
func (f *FakeHosts) Current() ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.section), nil
}

// Recover implements HostsManager (nothing is ever damaged).
func (f *FakeHosts) Recover() (bool, error) { return false, nil }

// Watch implements HostsManager: it records onChange and blocks until ctx is done.
func (f *FakeHosts) Watch(ctx context.Context, onChange func()) error {
	f.mu.Lock()
	f.onChange = onChange
	f.mu.Unlock()
	<-ctx.Done()
	f.mu.Lock()
	f.onChange = nil
	f.mu.Unlock()
	return ctx.Err()
}

// Tamper replaces the section with domains (nil removes it), as a user editing the file
// would, and calls a running Watch's onChange. It returns whether a watcher was told.
func (f *FakeHosts) Tamper(domains []string) bool {
	f.mu.Lock()
	if domains == nil {
		f.section = nil
	} else {
		s := slices.Clone(domains)
		slices.Sort(s)
		f.section = slices.Compact(s)
	}
	cb := f.onChange
	f.mu.Unlock()
	if cb != nil {
		cb()
		return true
	}
	return false
}

// Domains returns the section's domains (sorted; empty when absent).
func (f *FakeHosts) Domains() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.section)
}

// Applies counts successful Apply calls; Removes successful Remove calls.
func (f *FakeHosts) Applies() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.applies
}

// Removes counts successful Remove calls.
func (f *FakeHosts) Removes() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.removes
}

// FakeHeaderHosts is a FakeHosts that also writes and parses the section header
// (HostsSectionHeader).
type FakeHeaderHosts struct {
	*FakeHosts
	mu    sync.Mutex
	until time.Time
}

// NewFakeHeaderHosts returns an empty FakeHeaderHosts.
func NewFakeHeaderHosts() *FakeHeaderHosts { return &FakeHeaderHosts{FakeHosts: NewFakeHosts()} }

// ApplyUntil implements HostsSectionHeader.
func (f *FakeHeaderHosts) ApplyUntil(domains []string, until time.Time) error {
	if err := f.FakeHosts.Apply(domains); err != nil {
		return err
	}
	f.mu.Lock()
	f.until = until.UTC()
	f.mu.Unlock()
	return nil
}

// Section implements HostsSectionHeader.
func (f *FakeHeaderHosts) Section() ([]string, time.Time, bool, error) {
	d := f.FakeHosts.Domains()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(d) == 0 || f.until.IsZero() {
		return nil, time.Time{}, false, nil
	}
	return d, f.until, true, nil
}

// SetSection writes a section with a header directly (a leftover from a lost state).
func (f *FakeHeaderHosts) SetSection(domains []string, until time.Time) {
	f.FakeHosts.Tamper(domains)
	f.mu.Lock()
	f.until = until.UTC()
	f.mu.Unlock()
}

// FakeDNS counts DNS flushes.
type FakeDNS struct {
	mu      sync.Mutex
	flushes int
	// Err is returned by every flush.
	Err error
}

// FlushDNS implements DNSFlusher.
func (f *FakeDNS) FlushDNS(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.flushes++
	return f.Err
}

// Flushes returns how many flushes ran.
func (f *FakeDNS) Flushes() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.flushes
}

// FakeNetworkTime answers with the fake clock's real time (wall minus the jumps the
// test made), or offline.
type FakeNetworkTime struct {
	mu      sync.Mutex
	offline bool
	ref     func() time.Time
	calls   int
}

// NewFakeNetworkTime answers with ref() (the true current time of the test).
func NewFakeNetworkTime(ref func() time.Time) *FakeNetworkTime { return &FakeNetworkTime{ref: ref} }

// SetOffline makes every answer fail (true) or succeed (false).
func (f *FakeNetworkTime) SetOffline(offline bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.offline = offline
}

// NetworkNow implements NetworkTime.
func (f *FakeNetworkTime) NetworkNow(context.Context, func() time.Time) (time.Time, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.offline || f.ref == nil {
		return time.Time{}, false
	}
	return f.ref(), true
}

// Calls counts NetworkNow calls.
func (f *FakeNetworkTime) Calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// FakeRelauncher is a NuclearRelauncher that counts relaunches.
type FakeRelauncher struct {
	mu        sync.Mutex
	running   bool
	relaunchs int
}

// SetRunning sets what AppRunning answers.
func (f *FakeRelauncher) SetRunning(running bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.running = running
}

// AppRunning implements NuclearRelauncher.
func (f *FakeRelauncher) AppRunning() (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.running, nil
}

// Relaunch implements NuclearRelauncher.
func (f *FakeRelauncher) Relaunch(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.relaunchs++
	f.running = true
	return nil
}

// Relaunches counts Relaunch calls.
func (f *FakeRelauncher) Relaunches() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.relaunchs
}

// FakeProcesses is a process table: a ProcessLister and ProcessKiller.
type FakeProcesses struct {
	mu    sync.Mutex
	procs []procwatch.Process
	next  int
	// ListErr, when set, makes List fail.
	ListErr error
}

// Start adds a user process named name and returns its PID.
func (f *FakeProcesses) Start(name string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.next == 0 {
		f.next = 1000
	}
	f.next++
	f.procs = append(f.procs, procwatch.Process{PID: f.next, Name: name})
	return f.next
}

// Running reports whether a process named name is running.
func (f *FakeProcesses) Running(name string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.ContainsFunc(f.procs, func(p procwatch.Process) bool { return p.Name == name })
}

// List implements ProcessLister.
func (f *FakeProcesses) List() ([]procwatch.Process, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.ListErr != nil {
		return nil, f.ListErr
	}
	return slices.Clone(f.procs), nil
}

// Kill implements ProcessKiller.
func (f *FakeProcesses) Kill(pid int, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	i := slices.IndexFunc(f.procs, func(p procwatch.Process) bool { return p.PID == pid })
	if i < 0 {
		return procwatch.ErrNotFound
	}
	if f.procs[i].Name != name {
		return procwatch.ErrNameMismatch
	}
	f.procs = slices.Delete(f.procs, i, i+1)
	return nil
}
