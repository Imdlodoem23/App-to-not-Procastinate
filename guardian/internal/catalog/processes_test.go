package catalog

import (
	"runtime"
	"strings"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

func TestIsValidProcessName(t *testing.T) {
	for _, name := range []string{
		"Discord.exe", "Steam Helper", "Battle.net Launcher.exe", "Céntrate.exe", "steam_osx",
		strings.Repeat("x", 128), strings.Repeat(u(0x1F600), 64), "a" + u(0xA0) + "b",
	} {
		if !IsValidProcessName(name) {
			t.Errorf("IsValidProcessName(%q) = false", name)
		}
	}
	for _, name := range []string{
		"", " Discord.exe", "Discord.exe ", `C:\Games\steam.exe`, "/usr/bin/steam", "..", ".",
		"steam" + u(0) + ".exe", "steam\n.exe", "exe." + u(0x202E) + "evil", "zero" + u(0x200B) + "width",
		"*.exe", "a:b", `a"b`, "a|b", "a<b", "a?b", strings.Repeat("x", 129),
		strings.Repeat(u(0x1F600), 64) + "x", u(0xE000), u(0xFDD0), u(0xFFFF), u(0xFEFF) + "x",
		"x" + u(0xA0), "bad\xffutf8",
	} {
		if IsValidProcessName(name) {
			t.Errorf("IsValidProcessName(%q) = true", name)
		}
	}
}

func TestProcessNameKey(t *testing.T) {
	for _, tc := range []struct {
		name string
		p    Platform
		want string
	}{
		{"Steam.EXE", PlatformWin, "steam.exe"},
		{"Steam", PlatformLinux, "Steam"},
		{"Café", PlatformMac, "café"},
		{"Cafe" + u(0x301), PlatformMac, "café"}, // macOS file names come decomposed
		{"Cafe" + u(0x301), PlatformLinux, "Café"},
		{"CAFÉ", PlatformWin, "café"},
		{"Game", "", "game"}, // unknown platforms fold case like TypeScript does
	} {
		if got := ProcessNameKey(tc.name, tc.p); got != tc.want {
			t.Errorf("ProcessNameKey(%q, %q) = %q, want %q", tc.name, tc.p, got, tc.want)
		}
	}
}

func TestPlatformForGOOS(t *testing.T) {
	for goos, want := range map[string]Platform{
		"windows": PlatformWin, "darwin": PlatformMac, "linux": PlatformLinux, "freebsd": "",
	} {
		if got := PlatformForGOOS(goos); got != want {
			t.Errorf("PlatformForGOOS(%q) = %q, want %q", goos, got, want)
		}
		if got := string(PlatformForGOOS(goos)); got != embedded.PlatformForGOOS(goos) {
			t.Errorf("PlatformForGOOS(%q) = %q, embedded says %q", goos, got, embedded.PlatformForGOOS(goos))
		}
	}
	if CurrentPlatform() != PlatformForGOOS(runtime.GOOS) {
		t.Error("CurrentPlatform does not follow runtime.GOOS")
	}
}

func TestIsProtectedProcessName(t *testing.T) {
	c := Default()
	for _, name := range []string{
		"csrss.exe", "CSRSS.EXE", "csrss", "explorer.exe", "Taskmgr.exe", "WindowServer",
		"windowserver", "systemd", "Céntrate.exe", "Ce" + u(0x301) + "ntrate.exe", "centrate-guardian",
		"Céntrate Setup 0.1.0.exe", "CENTRATE.exe", "centrate", "Centrate Helper (Something New)",
		"Uninstall Céntrate.exe", "uninstall centrate 2.exe", "Finder.app", "Céntrate.app",
		"[System Process]", "consent.exe", "taskhostw.exe", "SecurityAgent", "kwin", "sshd-session",
		"osk.exe", "Narrator.exe", "Magnify.exe", "AtBroker.exe", "nvda.exe", "VoiceOver", "orca",
		"  explorer.exe  ", "EXPLORER.APP.EXE",
	} {
		if !c.IsProtectedProcessName(name) {
			t.Errorf("IsProtectedProcessName(%q) = false", name)
		}
	}
	for _, name := range []string{"", "   ", "Central", "Centralita.exe", "explorer2.exe", "systemd-games", "Discord.exe", "chrome.exe", "steam.exe"} {
		if c.IsProtectedProcessName(name) {
			t.Errorf("IsProtectedProcessName(%q) = true", name)
		}
	}
	for _, name := range c.ProtectedProcesses() {
		if !c.IsProtectedProcessName(name) || !IsValidProcessName(name) {
			t.Errorf("catalog protected process %q is invalid or unprotected", name)
		}
	}
}
