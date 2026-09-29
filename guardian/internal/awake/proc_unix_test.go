//go:build linux || darwin

package awake

import (
	"testing"
	"time"
)

// A real child in its own process group ends with SIGTERM and is reaped.
func TestRealProcessSignal(t *testing.T) {
	sleep, ok := findExecutable(sleepCandidates)
	if !ok {
		t.Skip("no sleep binary")
	}
	p, err := startProcess([]string{sleep, "30"})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- p.Wait() }()
	if err := p.Signal(false); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil || exitStatus(err) != "signal: terminated" {
			t.Fatalf("exit %v", err)
		}
	case <-time.After(10 * time.Second):
		_ = p.Signal(true)
		t.Fatal("the child ignored SIGTERM")
	}
	if _, err := startProcess(nil); err == nil {
		t.Fatal("an empty argument vector must fail")
	}
}

// The supervisor with a real child: held after it settles, released on Close.
func TestSupervisorRealChild(t *testing.T) {
	if testing.Short() {
		t.Skip("real time")
	}
	sleep, ok := findExecutable(sleepCandidates)
	if !ok {
		t.Skip("no sleep binary")
	}
	// BSD sleep (macOS) rejects "infinity"; a large count works everywhere.
	argv := []string{sleep, "100000"}
	s := newSupervisor("sleep", func() (process, error) { return startProcess(argv) }, realClock{}, newOptions(nil), nil)
	s.Hold(true)
	waitFor(t, "active", statusIs(s, Status{Active: true}))
	start := time.Now()
	s.Close()
	if d := time.Since(start); d > termGrace {
		t.Fatalf("Close took %s", d)
	}
	if s.Status() != (Status{}) {
		t.Fatalf("status after Close %+v", s.Status())
	}
}
