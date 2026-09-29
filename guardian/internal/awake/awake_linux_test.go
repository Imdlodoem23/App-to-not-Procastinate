//go:build linux

package awake

import "testing"

// Without systemd-inhibit at a fixed path the machine is unsupported (never PATH).
func TestLinuxUnsupportedWithoutBinaries(t *testing.T) {
	saved := systemdInhibitCandidates
	t.Cleanup(func() { systemdInhibitCandidates = saved })
	systemdInhibitCandidates = []string{t.TempDir() + "/systemd-inhibit"}
	t.Setenv("PATH", t.TempDir())
	in := New(nil)
	defer in.Close()
	in.Hold(true)
	if in.Status() != (Status{Err: ErrUnsupported}) {
		t.Fatalf("status %+v", in.Status())
	}
}
