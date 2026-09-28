package procwatch

import (
	"log/slog"
	"testing"
	"time"
)

// Regression: matching used only file names, so a renamed copy of a blocked
// executable (Discord.exe copied to Dscord.exe) was never closed. The
// identity read from the file now matches the target names too.
func TestMatcherMatchesRenamedExecutableByIdentity(t *testing.T) {
	m := NewMatcherFor("windows", []string{"Discord.exe"})
	renamed := Process{PID: 500, Name: "Dscord.exe", Identity: "Discord.exe"}
	if target, ok := m.Match(renamed); !ok || target != "Discord.exe" {
		t.Fatalf("Match(renamed) = %q, %v", target, ok)
	}
	if _, ok := m.Match(Process{PID: 501, Name: "Dscord.exe"}); ok {
		t.Fatal("matched without an identity")
	}
	// An identity never protects, and never unprotects either.
	if _, ok := m.Match(Process{PID: 502, Name: "explorer.exe", Identity: "Discord.exe"}); ok {
		t.Fatal("a protected executable matched by identity")
	}
	if _, ok := m.Match(Process{PID: 503, Name: "Dscord.exe", Identity: "Discord.exe", System: true}); ok {
		t.Fatal("a system process matched by identity")
	}
}

func TestMatcherWithIdentities(t *testing.T) {
	base := NewMatcherFor("darwin", []string{"Discord"})
	m := base.WithIdentities(map[string]string{"com.hnc.Discord": "Discord", "": "x", "bad\x00id": "y"})
	p := Process{PID: 600, Name: "Notes2", Path: "/Users/u/tmp/Notes2", Identity: "COM.HNC.discord"}
	if target, ok := m.Match(p); !ok || target != "Discord" {
		t.Fatalf("Match by bundle id = %q, %v", target, ok)
	}
	if _, ok := base.Match(p); ok {
		t.Fatal("WithIdentities changed the original Matcher")
	}
	if len(m.ids) != 1 {
		t.Fatalf("invalid identities kept: %v", m.ids)
	}
	// A matcher with identities only is not empty.
	if (Matcher{goos: "darwin"}).WithIdentities(map[string]string{"com.hnc.Discord": "Discord"}).Empty() {
		t.Fatal("identity-only Matcher reports Empty")
	}
}

// The watcher closes an identity match by its own (renamed) name, which is
// what Kill re-checks before terminating.
func TestWatcherKillsRenamedCopy(t *testing.T) {
	var killed []string
	s := &scanner{
		lister: ListerFunc(func() ([]Process, error) {
			return []Process{{PID: 700, Name: "Dscord.exe", Identity: "Discord.exe"}}, nil
		}),
		killer:  KillerFunc(func(pid int, name string) error { killed = append(killed, name); return nil }),
		log:     slog.New(slog.DiscardHandler),
		now:     time.Now,
		targets: func() Matcher { return NewMatcherFor("windows", []string{"Discord.exe"}) },
		failed:  map[int]string{},
	}
	var reports []Killed
	s.onKilled = func(k Killed) { reports = append(reports, k) }
	s.scan()
	if len(killed) != 1 || killed[0] != "Dscord.exe" {
		t.Fatalf("killed %v", killed)
	}
	if len(reports) != 1 || reports[0].Target != "Discord.exe" || reports[0].Name != "Dscord.exe" {
		t.Fatalf("reports %+v", reports)
	}
}
