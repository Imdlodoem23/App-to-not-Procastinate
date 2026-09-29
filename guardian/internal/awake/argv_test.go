package awake

import (
	"slices"
	"strings"
	"testing"
)

// The argument vectors are constants: only the resolved fixed paths and the guardian's
// PID go into them, never through a shell (§10.14).
func TestArgumentVectorsAreConstant(t *testing.T) {
	got := systemdInhibitArgv("/usr/bin/systemd-inhibit", "/usr/bin/sleep")
	want := []string{"/usr/bin/systemd-inhibit", "--what=idle:sleep", "--who=Céntrate", "--why=Mantener despierto", "--mode=block", "/usr/bin/sleep", "infinity"}
	if !slices.Equal(got, want) {
		t.Fatalf("systemd-inhibit argv %q", got)
	}
	if got := caffeinateArgv(4242); !slices.Equal(got, []string{"/usr/bin/caffeinate", "-i", "-w", "4242"}) {
		t.Fatalf("caffeinate argv %q", got)
	}
	// -s (system sleep on AC) and -d (display) are never asked for: the lid and a manual
	// sleep still act, and the display is the app's.
	for _, a := range caffeinateArgv(1) {
		if a == "-s" || a == "-d" || a == "-u" {
			t.Fatalf("caffeinate argv has %s", a)
		}
	}
	for _, c := range append(slices.Clone(systemdInhibitCandidates), sleepCandidates...) {
		if !strings.HasPrefix(c, "/") {
			t.Fatalf("candidate %q is not absolute", c)
		}
	}
	if !slices.Equal(childEnv, []string{"PATH=/usr/bin:/bin", "LC_ALL=C"}) {
		t.Fatalf("child environment %q", childEnv)
	}
}

func TestFindExecutable(t *testing.T) {
	dir := t.TempDir()
	if _, ok := findExecutable([]string{dir + "/missing", dir}); ok {
		t.Fatal("a missing file or a directory is not an executable")
	}
}

func TestUnsupportedAndFake(t *testing.T) {
	u := Unsupported()
	u.Hold(true)
	if u.Status() != (Status{Err: ErrUnsupported}) {
		t.Fatalf("unsupported %+v", u.Status())
	}
	u.Close()

	ch := &changes{}
	f := NewFake(ch.inc)
	f.Hold(true)
	if f.Status() != (Status{Active: true}) || ch.get() != 1 {
		t.Fatalf("fake held %+v, changes %d", f.Status(), ch.get())
	}
	f.SetFailing(true)
	if f.Status() != (Status{Err: ErrFailed}) || ch.get() != 2 {
		t.Fatalf("fake failing %+v", f.Status())
	}
	f.Hold(false)
	if f.Status() != (Status{}) {
		t.Fatalf("fake released %+v", f.Status())
	}
	f.SetUnsupported(true)
	if f.Status() != (Status{Err: ErrUnsupported}) {
		t.Fatalf("fake unsupported %+v", f.Status())
	}
	f.Close()
	f.Hold(true)
	if !slices.Equal(f.Holds(), []bool{true, false}) || f.Held() || !f.Closed() {
		t.Fatalf("holds %v held %v closed %v", f.Holds(), f.Held(), f.Closed())
	}
}
