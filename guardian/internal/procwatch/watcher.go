package procwatch

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime"
	"sync"
	"time"
)

// Killed reports one launch of a blocked app that a scan closed: every
// process of the scan that matched Target, together with the matching
// processes they started (a child that matched another target, such as a game
// started by a blocked launcher, is folded into its ancestor's report).
// Chromium and Electron apps, Steam or a game run several processes, so one
// launch gives one Killed per scan, not one per process.
//
// A Watcher reports again when an app comes back in a later scan (it was
// relaunched by the user, a launcher, an updater or a KeepAlive agent): the
// engine must debounce reports per target before counting an attempt
// (docs/ARCHITECTURE.md §10.8 merges detections of a target within 30 s).
type Killed struct {
	// Target is the Matcher target, as given to NewMatcher (for example the
	// catalog name "Discord" when the process is "Discord.exe").
	Target string
	// Name is the executable name (Process.Name) of the first closed process
	// that matched Target, in listing order.
	Name string
	// Path is that process's executable path when the Lister had it (on
	// Windows only through OSLister).
	Path string
	// PIDs are the closed processes, in listing order.
	PIDs []int
	// At is when the processes were confirmed gone (Watcher.Now).
	At time.Time
}

// Ticker is the part of *time.Ticker the Watcher uses; tests inject a fake.
type Ticker interface {
	C() <-chan time.Time
	Stop()
}

type realTicker struct{ t *time.Ticker }

func (r realTicker) C() <-chan time.Time { return r.t.C }
func (r realTicker) Stop()               { r.t.Stop() }

// maxParallelKills bounds the Kill calls of one scan that wait at the same
// time (each can take up to the grace period plus forceWait).
const maxParallelKills = 8

// Watcher closes blocked processes periodically. Set the fields before calling
// Run and do not change them afterwards; zero values select the defaults.
// A Watcher must not be copied after first use.
type Watcher struct {
	// Interval between scans; zero means DefaultInterval (1.5 s).
	Interval time.Duration
	// Lister lists processes; nil means OSLister.
	Lister Lister
	// Killer closes processes; nil means OSKiller with DefaultGrace.
	Killer Killer
	// Logger receives errors; nil means slog.Default(). Records never contain
	// process names.
	Logger *slog.Logger
	// Now stamps Killed.At; nil means time.Now. The engine can pass its
	// trusted clock (clock.Detector.EffectiveNow).
	Now func() time.Time
	// NewTicker creates the scan ticker; nil means time.NewTicker.
	NewTicker func(time.Duration) Ticker

	pokeOnce sync.Once
	poke     chan struct{}
	scanned  func() // test hook: called after every scan
}

func (w *Watcher) pokeChan() chan struct{} {
	w.pokeOnce.Do(func() { w.poke = make(chan struct{}, 1) })
	return w.poke
}

// Poke asks a running Run to scan now instead of waiting for the next tick,
// for example right after a block starts. It never blocks; pokes made while a
// scan is pending are merged.
func (w *Watcher) Poke() {
	select {
	case w.pokeChan() <- struct{}{}:
	default:
	}
}

// Run scans immediately and then on every tick or Poke until ctx is done.
//
// Each scan calls targets; when the Matcher it returns is empty, the scan does
// nothing else (processes are not even listed). Otherwise it lists the
// processes, kills every match (in parallel, bounded) and calls onKilled, from
// Run's goroutine, once per launch it closed (see Killed). Processes that
// exited on their own, whose PID was reused or that turned out to be
// protected when re-checked right before the kill are not reported. targets
// should return a cached Matcher: building one on every call is wasteful.
//
// Errors are logged (a repeated error once, until it changes) and never stop
// the loop; panics in the Lister, the Killer, targets or onKilled are
// recovered and logged. Run must not be called concurrently on one Watcher.
func (w *Watcher) Run(ctx context.Context, targets func() Matcher, onKilled func(Killed)) {
	interval := w.Interval
	if interval <= 0 {
		interval = DefaultInterval
	}
	newTicker := w.NewTicker
	if newTicker == nil {
		newTicker = func(d time.Duration) Ticker { return realTicker{time.NewTicker(d)} }
	}
	s := &scanner{
		lister:   w.Lister,
		killer:   w.Killer,
		log:      w.Logger,
		now:      w.Now,
		targets:  targets,
		onKilled: onKilled,
		failed:   make(map[int]string),
	}
	if s.lister == nil {
		s.lister = OSLister{}
	}
	if s.killer == nil {
		s.killer = OSKiller{}
	}
	if s.log == nil {
		s.log = slog.Default()
	}
	if s.now == nil {
		s.now = time.Now
	}

	poke := w.pokeChan()
	t := newTicker(interval)
	defer t.Stop()
	for ctx.Err() == nil {
		s.scan()
		if w.scanned != nil {
			w.scanned()
		}
		select {
		case <-ctx.Done():
		case <-t.C():
		case <-poke:
		}
	}
}

// scanner holds the state of one Run.
type scanner struct {
	lister   Lister
	killer   Killer
	log      *slog.Logger
	now      func() time.Time
	targets  func() Matcher
	onKilled func(Killed)

	listErr string         // last listing error logged, "" when listing works
	failed  map[int]string // PID → last kill error logged
}

type hit struct {
	p      Process
	target string
	err    error
}

func (s *scanner) scan() {
	defer s.recover("scan")

	var m Matcher
	if s.targets != nil {
		m = s.targets()
	}
	if m.Empty() {
		clear(s.failed)
		return
	}

	procs, err := s.lister.List()
	if err != nil {
		if msg := err.Error(); msg != s.listErr {
			s.log.Warn("procwatch: listing processes failed", "err", err)
			s.listErr = msg
		}
		return
	}
	if s.listErr != "" {
		s.log.Info("procwatch: listing processes works again")
		s.listErr = ""
	}

	hits := make([]hit, 0, 4)
	seen := make(map[int]bool)
	for _, p := range procs {
		if seen[p.PID] {
			continue
		}
		if target, ok := m.Match(p); ok {
			seen[p.PID] = true
			hits = append(hits, hit{p: p, target: target})
		}
	}
	s.killAll(hits)

	for i := range hits {
		h := &hits[i]
		switch {
		case h.err == nil:
			delete(s.failed, h.p.PID)
		case errors.Is(h.err, ErrNotFound), errors.Is(h.err, ErrNameMismatch), errors.Is(h.err, ErrProtected):
			// Exited on its own, its PID now belongs to someone else, or the
			// check right before the kill found it protected (a system
			// process, or a path List did not have).
			delete(s.failed, h.p.PID)
		default:
			if msg := h.err.Error(); s.failed[h.p.PID] != msg {
				s.log.Warn("procwatch: could not close a blocked process", "pid", h.p.PID, "err", h.err)
				s.failed[h.p.PID] = msg
			}
		}
	}
	for pid := range s.failed {
		if !seen[pid] {
			delete(s.failed, pid)
		}
	}
	for _, k := range group(hits, s.now()) {
		s.report(k)
	}
}

// group turns the closed hits of one scan into reports: one per target, where
// a hit whose parent (transitively) is also a hit counts for its topmost
// ancestor's target. Reports come in the listing order of their first hit.
func group(hits []hit, at time.Time) []Killed {
	byPID := make(map[int]*hit, len(hits))
	for i := range hits {
		byPID[hits[i].p.PID] = &hits[i]
	}
	// root follows parents through hits; the step bound stops cycles, which
	// PID reuse can create in a listing.
	root := func(h *hit) *hit {
		for steps := 0; steps < len(hits); steps++ {
			parent, ok := byPID[h.p.PPID]
			if !ok || h.p.PPID == 0 || parent == h {
				break
			}
			h = parent
		}
		return h
	}
	var out []Killed
	var first []*hit // first closed hit of each report
	index := make(map[string]int)
	for i := range hits {
		h := &hits[i]
		if h.err != nil {
			continue
		}
		target := root(h).target
		j, ok := index[target]
		if !ok {
			j = len(out)
			index[target] = j
			out = append(out, Killed{Target: target, At: at})
			first = append(first, h)
		}
		k := &out[j]
		k.PIDs = append(k.PIDs, h.p.PID)
		if k.Name == "" && h.target == target {
			k.Name, k.Path = h.p.Name, h.p.Path
		}
	}
	for i := range out {
		if out[i].Name == "" {
			// Only folded children were closed: name the first of them.
			out[i].Name, out[i].Path = first[i].p.Name, first[i].p.Path
		}
	}
	return out
}

// killAll kills every hit, at most maxParallelKills at a time, and stores the
// results in hits.
func (s *scanner) killAll(hits []hit) {
	if len(hits) == 1 {
		hits[0].err = s.kill(hits[0].p)
		return
	}
	sem := make(chan struct{}, maxParallelKills)
	var wg sync.WaitGroup
	for i := range hits {
		wg.Add(1)
		sem <- struct{}{}
		go func(h *hit) {
			defer wg.Done()
			defer func() { <-sem }()
			h.err = s.kill(h.p)
		}(&hits[i])
	}
	wg.Wait()
}

// kill calls the Killer, turning a panic into an error.
func (s *scanner) kill(p Process) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("procwatch: killer panicked: %s", panicSummary(r))
		}
	}()
	return s.killer.Kill(p.PID, p.Name)
}

func (s *scanner) report(k Killed) {
	if s.onKilled == nil {
		return
	}
	defer s.recover("onKilled")
	s.onKilled(k)
}

func (s *scanner) recover(where string) {
	if r := recover(); r != nil {
		s.log.Error("procwatch: recovered from panic", "in", where, "panic", panicSummary(r))
	}
}

// panicSummary describes a panic value without echoing arbitrary strings,
// which could contain names the user chose.
func panicSummary(r any) string {
	if err, ok := r.(runtime.Error); ok {
		return err.Error()
	}
	return fmt.Sprintf("%T", r)
}
