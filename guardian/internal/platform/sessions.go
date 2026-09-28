package platform

import (
	"context"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/clock"
)

// LogonSession is one interactive logon session of a local user: on Windows
// a WTS session with a user (not session 0), on Linux a logind session of
// class user on a seat, on macOS the user who owns the console.
type LogonSession struct {
	// ID identifies the session for its whole life; a new logon gets a new
	// ID even when the OS reuses its session number. Windows:
	// "<session id>@<logon FILETIME>"; Linux: "<logind id>@<REALTIME>";
	// macOS: "console:<uid>". It carries no user name.
	ID string
	// Console reports the session attached to the physical console.
	Console bool
	// LogonBoot is the boot-clock reading (clock.BootTime) of the logon, when
	// HasLogon. The OS layers derive it from the logon time they report
	// (Windows WTSINFO.LogonTime against WTSINFO.CurrentTime, Linux logind
	// MONOTONIC); SessionWatcher replaces it with the moment it first saw
	// the session when that is earlier or it is unknown.
	LogonBoot time.Duration
	HasLogon  bool
}

// Sessions lists the interactive logon sessions (see LogonSession). It
// never runs other programs.
func Sessions() ([]LogonSession, error) { return osSessions() }

// DefaultSessionPoll is how often a SessionWatcher lists the sessions.
const DefaultSessionPoll = 2 * time.Second

// SessionWatcher notices logons and logoffs by polling Sessions, for the
// study-session rule «a logoff ends the open session interrupted» and the
// process logon grace (docs/ARCHITECTURE.md §10.4, §10.8). Polling rather than
// OS notifications works the same everywhere, needs no window or session-change
// control (kardianos/service does not forward SERVICE_CONTROL_SESSIONCHANGE),
// and also catches the logoff that Windows Fast Startup performs before it
// hibernates session 0: after the resume the old session is gone.
//
// Set the fields before Run and do not change them afterwards. LogonBoot is
// safe for concurrent use with Run.
type SessionWatcher struct {
	// Interval between polls; zero means DefaultSessionPoll.
	Interval time.Duration
	// List lists the sessions; nil means Sessions.
	List func() ([]LogonSession, error)
	// Boot reads the boot clock; nil means clock.BootTime. It must be the
	// engine's boot clock, since LogonBoot is compared with it.
	Boot func() time.Duration
	// Logger receives listing errors (once until they change); nil discards.
	Logger *slog.Logger

	mu        sync.Mutex
	primed    bool
	seen      map[string]LogonSession
	lastLogon time.Duration
	hasLogon  bool
	lastErr   string
}

// Run polls until ctx is done, calling onLogoff (from Run's goroutine) for
// every session that was listed and no longer is. Sessions present at the
// first poll are never reported as new logons, and a failed listing reports
// nothing.
func (w *SessionWatcher) Run(ctx context.Context, onLogoff func(LogonSession)) {
	interval := w.Interval
	if interval <= 0 {
		interval = DefaultSessionPoll
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		for _, s := range w.Poll() {
			if onLogoff != nil {
				onLogoff(s)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Poll lists the sessions once and returns the ones that logged off since
// the previous poll, sorted by ID. Run calls it; tests call it directly.
func (w *SessionWatcher) Poll() []LogonSession {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.pollLocked()
}

func (w *SessionWatcher) pollLocked() []LogonSession {
	list := w.List
	if list == nil {
		list = Sessions
	}
	boot := w.Boot
	if boot == nil {
		boot = clock.BootTime
	}
	sessions, err := list()
	if err != nil {
		if msg := err.Error(); msg != w.lastErr {
			w.logger().Warn("platform: listing logon sessions failed", "err", err)
			w.lastErr = msg
		}
		return nil
	}
	w.lastErr = ""
	now := boot()
	cur := make(map[string]LogonSession, len(sessions))
	for _, s := range sessions {
		if s.ID == "" {
			continue
		}
		if prev, ok := w.seen[s.ID]; ok {
			s.LogonBoot, s.HasLogon = prev.LogonBoot, prev.HasLogon
		} else {
			switch {
			case w.primed && (!s.HasLogon || s.LogonBoot > now):
				// Appeared while watching: it logged on at most one
				// interval ago.
				s.LogonBoot, s.HasLogon = now, true
			case s.HasLogon && s.LogonBoot > now:
				s.LogonBoot = now
			}
			if s.HasLogon && s.LogonBoot < 0 {
				s.LogonBoot = 0
			}
			if s.HasLogon && (!w.hasLogon || s.LogonBoot > w.lastLogon) {
				w.lastLogon, w.hasLogon = s.LogonBoot, true
			}
		}
		cur[s.ID] = s
	}
	var gone []LogonSession
	if w.primed {
		for id, s := range w.seen {
			if _, ok := cur[id]; !ok {
				gone = append(gone, s)
			}
		}
		slices.SortFunc(gone, func(a, b LogonSession) int {
			switch {
			case a.ID < b.ID:
				return -1
			case a.ID > b.ID:
				return 1
			}
			return 0
		})
	}
	w.seen, w.primed = cur, true
	return gone
}

// LogonBoot returns the boot-clock reading of the most recent interactive
// logon seen, for the engine's process logon grace (daemon.Options.LogonBoot).
// ok is false while no logon time is known. Before the first poll of Run it
// polls once itself.
func (w *SessionWatcher) LogonBoot() (time.Duration, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.primed {
		_ = w.pollLocked()
	}
	return w.lastLogon, w.hasLogon
}

func (w *SessionWatcher) logger() *slog.Logger {
	if w.Logger != nil {
		return w.Logger
	}
	return slog.New(slog.DiscardHandler)
}

// logonFromElapsed converts "the logon was elapsed ago" into a boot-clock
// reading, clamped to [0, now].
func logonFromElapsed(now, elapsed time.Duration) time.Duration {
	if elapsed < 0 {
		elapsed = 0
	}
	if elapsed > now {
		return 0
	}
	return now - elapsed
}
