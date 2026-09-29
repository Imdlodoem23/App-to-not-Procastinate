package nuclear

import (
	"path/filepath"
	"slices"
	"testing"
)

func TestNew(t *testing.T) {
	if New("") != nil || New("centrate") != nil {
		t.Fatal("an empty or relative app path must disable relaunching")
	}
	abs, err := filepath.Abs(filepath.FromSlash("/opt/Centrate/../Centrate/centrate"))
	if err != nil {
		t.Fatal(err)
	}
	if r := New(abs); r == nil || r.AppPath() != filepath.Clean(abs) {
		t.Fatalf("New(%q) = %+v", abs, r)
	}
}

func TestParseSeatActiveUID(t *testing.T) {
	const seat = "# This is private data. Do not parse.\nIS_SEAT0=1\nCAN_GRAPHICAL=1\nACTIVE=2\nACTIVE_UID=1000\nSESSIONS=2 c1\nUIDS=1000 120\n"
	if uid, ok := parseSeatActiveUID([]byte(seat)); !ok || uid != 1000 {
		t.Fatalf("ACTIVE_UID = %d, %v", uid, ok)
	}
	for _, bad := range []string{"", "IS_SEAT0=1\n", "ACTIVE_UID=\n", "ACTIVE_UID=-1\n", "ACTIVE_UID=1000; rm -rf /\n", "ACTIVE_UID=99999999999\n"} {
		if uid, ok := parseSeatActiveUID([]byte(bad)); ok {
			t.Errorf("parseSeatActiveUID(%q) = %d", bad, uid)
		}
	}
}

// The argument lists are fixed; the uid is the only variable part, always numeric.
func TestRelaunchArgs(t *testing.T) {
	if got, want := linuxRelaunchArgs(1000), []string{"--user", "--machine=1000@.host", "start", "centrate-nuclear.service"}; !slices.Equal(got, want) {
		t.Fatalf("linux argv = %q", got)
	}
	if got, want := darwinRelaunchArgs(501), []string{"kickstart", "gui/501/io.github.imdlodoem23.centrate.nuclear"}; !slices.Equal(got, want) {
		t.Fatalf("darwin argv = %q", got)
	}
	if DarwinAgentPath != "/Library/LaunchAgents/io.github.imdlodoem23.centrate.nuclear.plist" {
		t.Fatal(DarwinAgentPath)
	}
}
