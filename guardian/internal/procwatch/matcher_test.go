package procwatch

import (
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestMatcherTable(t *testing.T) {
	type check struct {
		p      Process
		target string // "" means no match
	}
	tests := []struct {
		name    string
		goos    string
		targets []string
		checks  []check
	}{
		{
			name:    "windows is case-insensitive and .exe is optional",
			goos:    "windows",
			targets: []string{"Discord.exe", "RobloxPlayerBeta", "  steam.exe  "},
			checks: []check{
				{Process{PID: 100, Name: "Discord.exe"}, "Discord.exe"},
				{Process{PID: 101, Name: "discord.EXE"}, "Discord.exe"},
				{Process{PID: 102, Name: "DISCORD"}, "Discord.exe"},
				{Process{PID: 103, Name: "RobloxPlayerBeta.exe"}, "RobloxPlayerBeta"},
				{Process{PID: 104, Name: "robloxplayerbeta.exe"}, "RobloxPlayerBeta"},
				{Process{PID: 105, Name: "Steam.exe"}, "steam.exe"},
				{Process{PID: 106, Name: "DiscordPTB.exe"}, ""},
				{Process{PID: 107, Name: "Discord.exe.bak"}, ""},
				{Process{PID: 108, Name: "RobloxStudioBeta.exe"}, ""},
				{Process{PID: 109, Name: ""}, ""},
			},
		},
		{
			name:    "macOS is case-insensitive, tries the bundle and .app is optional",
			goos:    "darwin",
			targets: []string{"discord", "Roblox.app", "Café"},
			checks: []check{
				{Process{PID: 100, Name: "Discord"}, "discord"},
				{Process{PID: 101, Name: "RobloxPlayer", Bundle: "Roblox"}, "Roblox.app"},
				{Process{PID: 102, Name: "Cafe\u0301"}, "Café"}, // decomposed, as APFS/HFS+ may store it
				{Process{PID: 103, Name: "CAFÉ"}, "Café"},
				{Process{PID: 104, Name: "Discord Helper (Renderer)", Bundle: "Discord Helper (Renderer)"}, ""},
				{Process{PID: 105, Name: "Cafe"}, ""},
			},
		},
		{
			name:    "linux is exact, .exe is not special and comm is tried",
			goos:    "linux",
			targets: []string{"Discord", "steam", "lutris", "Discord.exe"},
			checks: []check{
				{Process{PID: 100, Name: "Discord"}, "Discord"},
				{Process{PID: 101, Name: "discord"}, ""},
				{Process{PID: 102, Name: "steam"}, "steam"},
				{Process{PID: 103, Name: "Steam"}, ""},
				{Process{PID: 104, Name: "python3.12", Comm: "lutris"}, "lutris"},
				{Process{PID: 105, Name: "Discord.exe"}, "Discord.exe"},
				{Process{PID: 106, Name: "steam.exe"}, ""},
			},
		},
		{
			name:    "protected PIDs never match",
			goos:    "linux",
			targets: []string{"Discord"},
			checks: []check{
				{Process{PID: 0, Name: "Discord"}, ""},
				{Process{PID: 1, Name: "Discord"}, ""},
				{Process{PID: 2, Name: "Discord"}, ""},
				{Process{PID: selfPID, Name: "Discord"}, ""},
				{Process{PID: 3, Name: "Discord"}, "Discord"},
			},
		},
		{
			name:    "windows System PID never matches",
			goos:    "windows",
			targets: []string{"Discord"},
			checks: []check{
				{Process{PID: 4, Name: "Discord.exe"}, ""},
				{Process{PID: 8, Name: "Discord.exe"}, "Discord"},
			},
		},
		{
			name:    "bundle names never protect: a renamed bundle keeps matching",
			goos:    "darwin",
			targets: []string{"Electron Helper", "Discord"},
			checks: []check{
				{Process{PID: 100, Name: "Discord", Path: "/Users/u/Applications/CentrateX.app/Contents/MacOS/Discord", Bundle: "CentrateX"}, "Discord"},
				{Process{PID: 101, Name: "Discord", Path: "/Users/u/Applications/Activity Monitor.app/Contents/MacOS/Discord", Bundle: "Activity Monitor"}, "Discord"},
				{Process{PID: 102, Name: "Discord", Bundle: "Céntrate"}, "Discord"},
				{Process{PID: 103, Name: "Electron Helper", Path: "/Applications/Other.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper"}, "Electron Helper"},
				{Process{PID: 104, Name: "Céntrate Helper (GPU)", Bundle: "Electron Helper"}, ""},
			},
		},
		{
			name:    "system processes never match",
			goos:    "linux",
			targets: []string{"python3", "java", "node"},
			checks: []check{
				{Process{PID: 100, Name: "python3", System: true}, ""},
				{Process{PID: 101, Name: "java", System: true}, ""},
				{Process{PID: 102, Name: "kworker/0:1", Comm: "node", System: true}, ""},
				{Process{PID: 103, Name: "python3"}, "python3"},
			},
		},
		{
			name:    "windows services never match",
			goos:    "windows",
			targets: []string{"SteamService", "EasyAntiCheat.exe", "nvcontainer"},
			checks: []check{
				{Process{PID: 100, Name: "SteamService.exe", System: true}, ""},
				{Process{PID: 101, Name: "EasyAntiCheat.exe", System: true}, ""},
				{Process{PID: 102, Name: "nvcontainer.exe", System: true}, ""},
				{Process{PID: 103, Name: "nvcontainer.exe"}, "nvcontainer"},
			},
		},
		{
			name:    "linux tries the command-line name of a cut comm",
			goos:    "linux",
			targets: []string{"minecraft-launcher", "RobloxPlayerBeta.exe"},
			checks: []check{
				{Process{PID: 100, Name: "python3.12", Comm: "minecraft-launc", CmdName: "minecraft-launcher"}, "minecraft-launcher"},
				{Process{PID: 101, Name: "wine64-preloader", Comm: "RobloxPlayerBet", CmdName: "RobloxPlayerBeta.exe"}, "RobloxPlayerBeta.exe"},
				{Process{PID: 102, Name: "python3.12", Comm: "minecraft-launc"}, ""},
			},
		},
		{
			name:    "a protected executable path never matches",
			goos:    "linux",
			targets: []string{"X"},
			checks: []check{
				{Process{PID: 100, Name: "X", Path: "/usr/bin/Xorg"}, ""},
				{Process{PID: 101, Name: "X", Path: "/usr/bin/X"}, "X"},
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m := NewMatcherFor(tc.goos, tc.targets)
			for _, c := range tc.checks {
				got, ok := m.Match(c.p)
				if ok != (c.target != "") || got != c.target {
					t.Errorf("Match(%+v) = %q, %v; want %q", c.p, got, ok, c.target)
				}
			}
		})
	}
}

func TestMatcherRejectsProtectedTargets(t *testing.T) {
	denied := []string{
		// Windows system processes, any case, with or without .exe.
		"explorer.exe", "Explorer", "EXPLORER.EXE", "csrss.exe", "winlogon", "services.exe",
		"lsass.exe", "svchost.exe", "svchost", "dwm.exe", "System", "system", "Taskmgr.exe",
		// macOS.
		"Finder", "finder", "Finder.app", "Dock", "WindowServer", "loginwindow", "launchd",
		"kernel_task",
		// Linux.
		"systemd", "SYSTEMD", "init", "Xorg", "xorg", "gnome-shell", "plasmashell", "sshd",
		// Céntrate and the guardian.
		"Céntrate", "centrate", "Centrate", "Céntrate.exe", "CÉNTRATE.EXE", "Ce\u0301ntrate",
		"Céntrate Helper", "Céntrate Helper (GPU)", "Céntrate Helper (Renderer)",
		"centrate-guardian", "centrate-guardian.exe", "Uninstall Céntrate.exe",
	}
	for _, goos := range []string{"windows", "darwin", "linux"} {
		m := NewMatcherFor(goos, denied)
		if !m.Empty() {
			t.Errorf("%s: protected names accepted: %q", goos, m.Names())
		}
		if !reflect.DeepEqual(m.Rejected(), denied) {
			t.Errorf("%s: Rejected() = %q, want all input names", goos, m.Rejected())
		}
		for _, n := range denied {
			p := Process{PID: 1000, Name: n, Bundle: n, Comm: n}
			if target, ok := m.Match(p); ok {
				t.Errorf("%s: protected process %q matched %q", goos, n, target)
			}
		}
	}
}

func TestMatcherProtectedProcessWithUserTarget(t *testing.T) {
	// Even if a target equals a protected name under the OS rules (it was
	// rejected), a protected process never matches another target through its
	// bundle or comm either.
	m := NewMatcherFor("darwin", []string{"Helper"})
	if _, ok := m.Match(Process{PID: 50, Name: "Finder", Bundle: "Helper"}); ok {
		t.Error("Finder matched through its bundle")
	}
	l := NewMatcherFor("linux", []string{"worker"})
	if _, ok := l.Match(Process{PID: 50, Name: "sshd", Comm: "worker"}); ok {
		t.Error("sshd matched through its comm")
	}
	if _, ok := l.Match(Process{PID: 50, Name: "sshd", CmdName: "worker"}); ok {
		t.Error("sshd matched through its command line")
	}
}

func TestMatcherProtectDir(t *testing.T) {
	withProtectedDirs(t, "/opt/Céntrate")
	m := NewMatcherFor("linux", []string{"chrome_crashpad_handler"})
	if _, ok := m.Match(Process{PID: 50, Name: "chrome_crashpad_handler", Path: "/opt/Céntrate/chrome_crashpad_handler"}); ok && runtime.GOOS != "windows" {
		t.Error("Céntrate's own crash handler matched")
	}
	if _, ok := m.Match(Process{PID: 51, Name: "chrome_crashpad_handler", Path: "/opt/discord/chrome_crashpad_handler"}); !ok {
		t.Error("another app's crash handler did not match")
	}
}

func TestMatcherInvalidTargets(t *testing.T) {
	invalid := []string{
		"", "   ", ".", "..", `C:\Games\Discord.exe`, "/usr/bin/steam", "a/b", "bad\x00name",
		"tab\tname", "con|x", "what?", "star*", `quo"te`, "a<b", "a>b", "a:b",
		"zero\u200bwidth", "bidi\u202eoverride", "private\ue000use", string([]byte{0xff, 0xfe}),
		strings.Repeat("a", 256),
	}
	m := NewMatcherFor("linux", invalid)
	if !m.Empty() {
		t.Fatalf("invalid names accepted: %q", m.Names())
	}
	if len(m.Rejected()) != len(invalid) {
		t.Fatalf("Rejected() has %d names, want %d", len(m.Rejected()), len(invalid))
	}
	// ".exe" alone is a name on Linux but empty once ".exe" is dropped on Windows.
	if w := NewMatcherFor("windows", []string{".exe"}); !w.Empty() {
		t.Errorf("windows accepted %q", w.Names())
	}
	if l := NewMatcherFor("linux", []string{".exe"}); l.Len() != 1 {
		t.Errorf("linux rejected .exe: %q", l.Rejected())
	}
}

func TestMatcherDeduplicates(t *testing.T) {
	m := NewMatcherFor("windows", []string{"Discord.exe", "discord", "DISCORD.EXE", " Discord "})
	if got, want := m.Names(), []string{"Discord.exe"}; !reflect.DeepEqual(got, want) {
		t.Errorf("Names() = %q, want %q", got, want)
	}
	if m.Len() != 1 || len(m.Rejected()) != 0 {
		t.Errorf("Len() = %d, Rejected() = %q", m.Len(), m.Rejected())
	}
	l := NewMatcherFor("linux", []string{"Discord", "discord", "Discord"})
	if got, want := l.Names(), []string{"Discord", "discord"}; !reflect.DeepEqual(got, want) {
		t.Errorf("linux Names() = %q, want %q", got, want)
	}
}

func TestMatcherZeroValue(t *testing.T) {
	var m Matcher
	if !m.Empty() || m.Len() != 0 || m.Names() != nil || m.Rejected() != nil {
		t.Fatal("zero Matcher is not empty")
	}
	if _, ok := m.Match(Process{PID: 10, Name: "Discord"}); ok {
		t.Error("zero Matcher matched")
	}
	if _, ok := m.MatchName("Discord"); ok {
		t.Error("zero Matcher matched a name")
	}
	if !NewMatcherFor("linux", nil).Empty() {
		t.Error("NewMatcher(nil) is not empty")
	}
}

func TestMatchName(t *testing.T) {
	m := NewMatcherFor("windows", []string{"Discord"})
	if got, ok := m.MatchName("discord.exe"); !ok || got != "Discord" {
		t.Errorf("MatchName(discord.exe) = %q, %v", got, ok)
	}
	for _, n := range []string{"", "explorer.exe", "steam.exe"} {
		if got, ok := m.MatchName(n); ok {
			t.Errorf("MatchName(%q) = %q", n, got)
		}
	}
}

func TestMatcherNamesIsACopy(t *testing.T) {
	m := NewMatcherFor("linux", []string{"steam", "/bad"})
	m.Names()[0] = "changed"
	m.Rejected()[0] = "changed"
	if m.Names()[0] != "steam" || m.Rejected()[0] != "/bad" {
		t.Error("Names or Rejected expose internal state")
	}
}
