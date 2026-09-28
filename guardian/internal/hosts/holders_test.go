package hosts

import (
	"errors"
	"os"
	"slices"
	"testing"
	"time"
)

// Regression: a process holding the hosts file open without write sharing
// used to keep every new section out of the file forever, retried as if it
// were an antivirus. With BreakLocks the interactive holder is closed and
// the write goes through; OnLockBroken reports it.
func TestBreakLocksClosesInteractiveHolder(t *testing.T) {
	m, path := newManager(t, []byte(windowsDefaultHosts))
	m.sleep = func(time.Duration) {}
	held := true
	m.rename = func(src, dst string) error {
		if held {
			return errLocked
		}
		return os.Rename(src, dst)
	}
	m.inPlace = func(p string, data []byte) error {
		if held {
			return errLocked
		}
		return writeInPlace(p, data)
	}
	holders := []LockHolder{
		{PID: 900, Name: "MsMpEng.exe", Session: 0, Service: true},
		{PID: 901, Name: "powershell.exe", Session: 1},
	}
	m.lockHolders = func(string) ([]LockHolder, error) { return holders, nil }
	var killed []int
	m.killHolder = func(h LockHolder) error {
		killed = append(killed, h.PID)
		held = false
		return nil
	}
	var reported []LockHolder
	m.OnLockBroken = func(c []LockHolder) { reported = append(reported, c...) }

	// Without BreakLocks nothing is closed.
	if err := m.Apply([]string{"a.com"}); !errors.Is(err, errLocked) {
		t.Fatalf("Apply = %v, want errLocked", err)
	}
	if len(killed) != 0 {
		t.Fatalf("closed %v without BreakLocks", killed)
	}

	m.BreakLocks = true
	mustApply(t, m, "a.com")
	if !slices.Equal(killed, []int{901}) {
		t.Fatalf("closed %v, want only the interactive holder 901", killed)
	}
	if len(reported) != 1 || reported[0].PID != 901 {
		t.Fatalf("OnLockBroken got %v", reported)
	}
	if got := readString(t, path); got != windowsDefaultHosts+"\r\n"+section("\r\n", "a.com") {
		t.Fatalf("got %q", got)
	}
}

// Removing the section never closes anything, and a file held only by
// system processes is waited for.
func TestBreakLocksLeavesSystemHoldersAndRemoveAlone(t *testing.T) {
	m, _ := newManager(t, []byte(windowsDefaultHosts))
	m.sleep = func(time.Duration) {}
	mustApply(t, m, "a.com")
	m.rename = func(string, string) error { return errLocked }
	m.inPlace = func(string, []byte) error { return errLocked }
	m.BreakLocks = true
	m.lockHolders = func(string) ([]LockHolder, error) {
		return []LockHolder{{PID: 900, Name: "backup.exe", Session: 0}, {PID: 902, Name: "explorer.exe", Session: 1, Critical: true}}, nil
	}
	m.killHolder = func(h LockHolder) error { t.Fatalf("closed %d", h.PID); return nil }
	m.OnLockBroken = func(c []LockHolder) { t.Fatalf("OnLockBroken(%v)", c) }
	if err := m.Apply([]string{"b.com"}); !errors.Is(err, errLocked) {
		t.Fatalf("Apply = %v, want errLocked", err)
	}
	m.lockHolders = func(string) ([]LockHolder, error) {
		t.Fatal("Remove looked for holders")
		return nil, nil
	}
	if err := m.Remove(); !errors.Is(err, errLocked) {
		t.Fatalf("Remove = %v, want errLocked", err)
	}
}

func TestBreakable(t *testing.T) {
	const self = 5000
	cases := []struct {
		h    LockHolder
		want bool
	}{
		{LockHolder{PID: 901, Name: "powershell.exe", Session: 1}, true},
		{LockHolder{PID: 901, Name: "notepad.exe", Session: 2}, true},
		{LockHolder{PID: 901, Name: "MsMpEng.exe", Session: 0}, false},
		{LockHolder{PID: 901, Name: "svchost.exe", Session: 1, Service: true}, false},
		{LockHolder{PID: 901, Name: "csrss.exe", Session: 1, Critical: true}, false},
		{LockHolder{PID: 901, Name: "", Session: 1}, false},
		{LockHolder{PID: 901, Name: "explorer.exe", Session: 1}, false},
		{LockHolder{PID: 4, Name: "System", Session: 1}, false},
		{LockHolder{PID: self, Name: "centrate-guardian.exe", Session: 1}, false},
	}
	for _, c := range cases {
		if got := breakable(c.h, self); got != c.want {
			t.Errorf("breakable(%+v) = %v, want %v", c.h, got, c.want)
		}
	}
}
