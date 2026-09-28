package platform

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"
)

type fakeSessions struct {
	mu   sync.Mutex
	list []LogonSession
	err  error
	boot time.Duration
}

func (f *fakeSessions) set(err error, s ...LogonSession) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.list, f.err = s, err
}

func (f *fakeSessions) watcher() *SessionWatcher {
	return &SessionWatcher{
		List: func() ([]LogonSession, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			return slices.Clone(f.list), f.err
		},
		Boot: func() time.Duration {
			f.mu.Lock()
			defer f.mu.Unlock()
			return f.boot
		},
	}
}

func ids(ss []LogonSession) []string {
	var out []string
	for _, s := range ss {
		out = append(out, s.ID)
	}
	return out
}

// Regression: nothing told the engine about logoffs (and Fast Startup's
// logoff before hibernation), so an open study session ended abandoned and
// punished instead of interrupted.
func TestSessionWatcherReportsLogoff(t *testing.T) {
	f := &fakeSessions{boot: time.Hour}
	w := f.watcher()
	a := LogonSession{ID: "1@100", Console: true, LogonBoot: 50 * time.Minute, HasLogon: true}
	f.set(nil, a)
	if gone := w.Poll(); len(gone) != 0 {
		t.Fatalf("first poll reported %v", ids(gone))
	}
	if gone := w.Poll(); len(gone) != 0 {
		t.Fatalf("unchanged poll reported %v", ids(gone))
	}
	// A listing error reports nothing and forgets nothing.
	f.set(errors.New("boom"))
	if gone := w.Poll(); len(gone) != 0 {
		t.Fatalf("failed poll reported %v", ids(gone))
	}
	// Same session number, new logon (Fast Startup resume, re-login).
	b := LogonSession{ID: "1@200", Console: true}
	f.set(nil, b)
	if gone := w.Poll(); !slices.Equal(ids(gone), []string{"1@100"}) {
		t.Fatalf("gone = %v, want the old logon", ids(gone))
	}
	f.set(nil)
	if gone := w.Poll(); !slices.Equal(ids(gone), []string{"1@200"}) {
		t.Fatalf("gone = %v", ids(gone))
	}
}

func TestSessionWatcherLogonBoot(t *testing.T) {
	f := &fakeSessions{boot: time.Hour}
	w := f.watcher()
	// Present at start with a known logon time: that time.
	f.set(nil, LogonSession{ID: "a", LogonBoot: 59 * time.Minute, HasLogon: true})
	if at, ok := w.LogonBoot(); !ok || at != 59*time.Minute {
		t.Fatalf("LogonBoot = %v, %v", at, ok)
	}
	// A logon seen while watching without a time: the moment it was seen.
	f.mu.Lock()
	f.boot = 2 * time.Hour
	f.mu.Unlock()
	f.set(nil, LogonSession{ID: "a", LogonBoot: 59 * time.Minute, HasLogon: true}, LogonSession{ID: "b"})
	w.Poll()
	if at, ok := w.LogonBoot(); !ok || at != 2*time.Hour {
		t.Fatalf("LogonBoot = %v, %v; want the moment b appeared", at, ok)
	}
	// A reported time in the future is clamped to now.
	f.set(nil, LogonSession{ID: "c", LogonBoot: 5 * time.Hour, HasLogon: true})
	w.Poll()
	if at, _ := w.LogonBoot(); at != 2*time.Hour {
		t.Fatalf("LogonBoot = %v", at)
	}
	// Unknown times at start: no logon known.
	g := &fakeSessions{boot: time.Hour}
	g.set(nil, LogonSession{ID: "x"})
	if _, ok := g.watcher().LogonBoot(); ok {
		t.Fatal("unknown logon time reported")
	}
}

func TestSessionWatcherRun(t *testing.T) {
	f := &fakeSessions{boot: time.Hour}
	w := f.watcher()
	w.Interval = time.Millisecond
	f.set(nil, LogonSession{ID: "1@1"})
	ctx, cancel := context.WithCancel(context.Background())
	got := make(chan LogonSession, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		w.Run(ctx, func(s LogonSession) { got <- s })
	}()
	for !w.primedNow() {
		time.Sleep(time.Millisecond)
	}
	f.set(nil)
	select {
	case s := <-got:
		if s.ID != "1@1" {
			t.Fatalf("logoff of %q", s.ID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no logoff reported")
	}
	cancel()
	<-done
}

func (w *SessionWatcher) primedNow() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.primed
}

func TestReadLogindSessions(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("2", "# comment\nUID=1000\nUSER=ana\nACTIVE=1\nSTATE=active\nREMOTE=0\nTYPE=wayland\nCLASS=user\nSEAT=seat0\nREALTIME=1700000000000000\nMONOTONIC=30000000\n")
	write("3", "UID=1000\nSTATE=online\nREMOTE=1\nTYPE=tty\nCLASS=user\nREALTIME=1\nMONOTONIC=1\n") // ssh
	write("c1", "UID=60\nSTATE=online\nCLASS=greeter\nSEAT=seat0\n")
	write("4", "UID=1001\nSTATE=closing\nCLASS=user\nSEAT=seat0\nREALTIME=2\n")
	write("5", "UID=1002\nSTATE=online\nCLASS=user\nSEAT=seat0\nACTIVE=0\nREALTIME=3\n")
	write("2.ref", "")
	got, err := readLogindSessions(dir, 100*time.Second, 90*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	want := []LogonSession{
		{ID: "2@1700000000000000", Console: true, LogonBoot: 40 * time.Second, HasLogon: true},
		{ID: "5@3"},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
	if got, err := readLogindSessions(filepath.Join(dir, "missing"), 0, 0); err != nil || got != nil {
		t.Fatalf("missing dir: %v, %v", got, err)
	}
}

func TestLogonFromElapsed(t *testing.T) {
	for _, c := range []struct{ now, elapsed, want time.Duration }{
		{100, 30, 70}, {100, -5, 100}, {100, 200, 0}, {100, 100, 0},
	} {
		if got := logonFromElapsed(c.now, c.elapsed); got != c.want {
			t.Errorf("logonFromElapsed(%v, %v) = %v, want %v", c.now, c.elapsed, got, c.want)
		}
	}
}
