package procwatch

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"testing"
)

func TestIsProtected(t *testing.T) {
	protected := []string{
		"explorer.exe", "EXPLORER", "Explorer.EXE", " svchost.exe ", "csrss.exe", "winlogon.exe",
		"services.exe", "lsass.exe", "dwm.exe", "System", "system", "[System Process]",
		"Finder", "Finder.app", "Dock", "WindowServer", "loginwindow", "launchd", "kernel_task",
		"systemd", "init", "Xorg", "gnome-shell", "plasmashell", "sshd",
		"Céntrate", "CENTRATE.exe", "centrate", "Ce\u0301ntrate Helper (Renderer)",
		"Céntrate Helper (GPU)", "Céntrate Helper (Plugin)", "centrate-guardian",
		"centrate-guardian.exe", "Céntrate Setup 0.1.0.exe", "Uninstall Céntrate.exe",
	}
	for _, n := range protected {
		if !IsProtected(n) {
			t.Errorf("IsProtected(%q) = false", n)
		}
	}
	allowed := []string{
		"", "Discord.exe", "Discord", "steam", "RobloxPlayerBeta.exe", "chrome.exe", "Finder2",
		"explorer2.exe", "Central", "Centralita.exe", "systemd-games", "xorg-game",
	}
	for _, n := range allowed {
		if IsProtected(n) {
			t.Errorf("IsProtected(%q) = true", n)
		}
	}
}

func TestIsProtectedSelf(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Skip("os.Executable:", err)
	}
	if !IsProtected(filepath.Base(exe)) {
		t.Errorf("the running executable %q is not protected", filepath.Base(exe))
	}
}

func TestProtectedPID(t *testing.T) {
	tests := []struct {
		goos string
		pid  int
		want bool
	}{
		{"windows", -1, true},
		{"windows", 0, true},
		{"windows", 4, true},
		{"windows", 1, false},
		{"windows", 8, false},
		{"linux", 0, true},
		{"linux", 1, true},
		{"linux", 2, true},
		{"linux", 3, false},
		{"darwin", 0, true},
		{"darwin", 1, true},
		{"darwin", 2, false},
		{"darwin", selfPID, true},
		{"windows", selfPID, true},
	}
	for _, tc := range tests {
		if got := protectedPID(tc.goos, tc.pid); got != tc.want {
			t.Errorf("protectedPID(%s, %d) = %v, want %v", tc.goos, tc.pid, got, tc.want)
		}
	}
}

func TestProcessProtected(t *testing.T) {
	tests := []struct {
		goos string
		p    Process
		want bool
	}{
		{"linux", Process{PID: 10, Name: "Discord"}, false},
		{"darwin", Process{PID: 10, Name: "Finder"}, true},
		{"linux", Process{PID: 10, Name: "X", Path: "/usr/lib/xorg/Xorg"}, true},
		{"windows", Process{PID: 10, Name: "Helper", Path: `C:\Windows\explorer.exe`}, true},
		{"linux", Process{PID: 1, Name: "Discord"}, true},
		// System processes: root, service accounts, session 0, kernel threads.
		{"linux", Process{PID: 10, Name: "python3", System: true}, true},
		{"windows", Process{PID: 10, Name: "SteamService.exe", System: true}, true},
		{"darwin", Process{PID: 10, Name: "Discord", System: true}, true},
		// Comm and CmdName never protect: the process chose them.
		{"linux", Process{PID: 10, Name: "game", Comm: "sshd"}, false},
		{"linux", Process{PID: 10, Name: "game", CmdName: "gnome-shell"}, false},
		// Bundles never protect: renaming Discord.app keeps its executable
		// name, so a renamed bundle must not turn Discord into Céntrate,
		// Finder or Activity Monitor.
		{"darwin", Process{PID: 10, Name: "Discord", Bundle: "Céntrate"}, false},
		{"darwin", Process{PID: 10, Name: "Discord", Path: "/Users/u/Applications/CentrateX.app/Contents/MacOS/Discord", Bundle: "CentrateX"}, false},
		{"darwin", Process{PID: 10, Name: "Discord", Path: "/Users/u/Applications/Activity Monitor.app/Contents/MacOS/Discord", Bundle: "Activity Monitor"}, false},
		{"darwin", Process{PID: 10, Name: "Helper", Path: "/Applications/Céntrate.app/Contents/MacOS/Helper"}, false},
		{"darwin", Process{PID: 10, Name: "Helper", Path: "/System/Library/CoreServices/Finder.app/Contents/MacOS/Helper"}, false},
	}
	for _, tc := range tests {
		if got := processProtected(tc.goos, tc.p); got != tc.want {
			t.Errorf("processProtected(%s, %+v) = %v, want %v", tc.goos, tc.p, got, tc.want)
		}
	}
}

// withProtectedDirs runs the test with only dirs protected by ProtectDir.
func withProtectedDirs(t *testing.T, dirs ...string) {
	t.Helper()
	old := protectedDirs.Load()
	protectedDirs.Store(nil)
	t.Cleanup(func() { protectedDirs.Store(old) })
	for _, d := range dirs {
		if err := ProtectDir(d); err != nil {
			t.Fatalf("ProtectDir(%q) = %v", d, err)
		}
	}
}

func TestProtectDir(t *testing.T) {
	var app, other string
	switch runtime.GOOS {
	case "windows":
		app, other = `C:\Program Files\Focus Tools`, `C:\Program Files\Discord`
	default:
		app, other = "/Applications/Focus Tools.app", "/Applications/Discord.app"
	}
	withProtectedDirs(t, app+string(filepath.Separator))

	helper := filepath.Join(app, "Contents", "Frameworks", "chrome_crashpad_handler")
	if !processProtected(runtime.GOOS, Process{PID: 10, Name: "chrome_crashpad_handler", Path: helper}) {
		t.Errorf("%s is not protected", helper)
	}
	for _, p := range []string{
		filepath.Join(other, "chrome_crashpad_handler"),
		app + "X" + string(filepath.Separator) + "chrome_crashpad_handler", // sibling with a longer name
		app, // the directory itself is not a process inside it
	} {
		if processProtected(runtime.GOOS, Process{PID: 10, Name: "chrome_crashpad_handler", Path: p}) {
			t.Errorf("%s is protected", p)
		}
	}

	tests := []struct {
		goos, dir, path string
		want            bool
	}{
		{"darwin", "/Applications/Céntrate.app", "/Applications/Ce\u0301ntrate.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt", true},
		{"darwin", "/Applications/Céntrate.app", "/APPLICATIONS/CÉNTRATE.APP/Contents/MacOS/x", true},
		{"darwin", "/Applications/Céntrate.app", "/Applications/Céntrate.app/Contents/../../../Users/u/Discord", false},
		{"linux", "/opt/Céntrate", "/opt/Céntrate/chrome_crashpad_handler", true},
		{"linux", "/opt/Céntrate", "/opt/céntrate/chrome_crashpad_handler", false},
		{"linux", "/opt/Céntrate", "/opt/Céntrate/../game/game", false},
		{"windows", `C:\Program Files\Céntrate`, `c:\program files\CÉNTRATE\resources\elevate.exe`, true},
		{"windows", `C:\Program Files\Céntrate`, `C:/Program Files/Céntrate/x.exe`, true},
		{"windows", `C:\Program Files\Céntrate`, `C:\Program Files\Céntrate\..\Discord\Discord.exe`, false},
		{"windows", `C:\Program Files\Céntrate`, `C:\Program Files\Céntrate2\x.exe`, false},
	}
	for _, tc := range tests {
		protectedDirs.Store(&[]string{tc.dir})
		if got := inProtectedDir(tc.goos, tc.path); got != tc.want {
			t.Errorf("inProtectedDir(%s, %q) with %q = %v, want %v", tc.goos, tc.path, tc.dir, got, tc.want)
		}
	}
}

func TestProtectDirRejects(t *testing.T) {
	withProtectedDirs(t)
	for _, d := range []string{"", "relative/dir", ".", string(filepath.Separator), filepath.VolumeName(os.TempDir()) + string(filepath.Separator)} {
		if err := ProtectDir(d); !errors.Is(err, ErrInvalid) {
			t.Errorf("ProtectDir(%q) = %v, want ErrInvalid", d, err)
		}
	}
	if protectedDirs.Load() != nil {
		t.Error("rejected directories were stored")
	}
}

func TestProtectedIncludesElevationAndSessionTools(t *testing.T) {
	for _, n := range []string{
		"pkexec", "polkit-agent-helper-1", "sudo", "su", "doas", "dpkg", "apt", "apt-get", "rpm",
		"dnf", "packagekitd", "systemctl", "sway", "Hyprland", "labwc", "wayfire", "weston", "niri",
		"cosmic-comp", "i3", "plasma-systemmonitor", "ksysguard", "xfce4-taskmanager",
		"xdg-desktop-portal", "at-spi-bus-launcher", "gsd-media-keys", "orca",
		"osascript", "security_authtrampoline", "authorizationhost", "Installer", "installer",
		"installd", "launchctl", "mDNSResponder", "coreservicesd", "launchservicesd", "hidd",
		"trustd", "universalaccessd", "VoiceOver",
		"LockApp.exe", "smartscreen.exe", "SgrmBroker.exe", "MpDefenderCoreService.exe",
		"NisSrv.exe", "TrustedInstaller.exe", "TiWorker.exe", "MoUsoCoreWorker.exe",
		"SearchIndexer.exe", "CredentialUIBroker.exe", "WerFault.exe", "Narrator.exe",
		"Magnify.exe", "osk.exe", "AtBroker.exe", "Au_.exe", "Un_A.exe",
	} {
		if !IsProtected(n) {
			t.Errorf("IsProtected(%q) = false", n)
		}
	}
}

// TestProtectedMirrorsSharedCatalog checks that every name in the shared
// catalog's protected list is protected here too.
func TestProtectedMirrorsSharedCatalog(t *testing.T) {
	path := filepath.Join("..", "..", "..", "packages", "shared", "src", "catalog", "data", "protected.ts")
	src, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("shared catalog not available: %v", err)
	}
	re := regexp.MustCompile(`(?m)^\s*'([^'\\]+)',`)
	matches := re.FindAllStringSubmatch(string(src), -1)
	if len(matches) < 50 {
		t.Fatalf("parsed only %d names from %s; did its format change?", len(matches), path)
	}
	for _, m := range matches {
		if !IsProtected(m[1]) {
			t.Errorf("%q is protected in protected.ts but not in procwatch", m[1])
		}
	}
}
