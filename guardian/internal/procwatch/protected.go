package procwatch

import (
	"os"
	"path"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
)

// protectedNames are never matched or killed, even when a user adds them to a
// block. The list mirrors packages/shared/src/catalog/data/protected.ts (tests
// on both sides check that the two lists match). Names are compared with
// denyKey: case-insensitive, without accents and with ".exe" optional.
//
// Most system daemons are also skipped because they do not belong to an
// interactive user (Process.System); the names here matter for the processes
// that run in the user's own session: the shell and compositor, task
// managers, elevation prompts, installers and accessibility tools.
var protectedNames = []string{
	// Windows.
	"[System Process]", "System", "Registry", "Idle", "Secure System", "Memory Compression",
	"smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe", "lsass.exe",
	"lsaiso.exe", "lsm.exe", "svchost.exe", "userinit.exe", "explorer.exe", "dwm.exe",
	"fontdrvhost.exe", "LogonUI.exe", "LockApp.exe", "sihost.exe", "ctfmon.exe", "conhost.exe",
	"dllhost.exe", "RuntimeBroker.exe", "ApplicationFrameHost.exe",
	"StartMenuExperienceHost.exe", "ShellExperienceHost.exe", "SearchHost.exe",
	"SearchApp.exe", "SearchIndexer.exe", "TextInputHost.exe", "spoolsv.exe", "audiodg.exe",
	"WmiPrvSE.exe", "WUDFHost.exe", "MsMpEng.exe", "MpDefenderCoreService.exe", "NisSrv.exe",
	"SecurityHealthService.exe", "SecurityHealthSystray.exe", "smartscreen.exe",
	"SgrmBroker.exe", "CredentialUIBroker.exe", "WerFault.exe", "Taskmgr.exe",
	"SystemSettings.exe", "control.exe", "msiexec.exe", "consent.exe", "taskhostw.exe",
	"TrustedInstaller.exe", "TiWorker.exe", "MoUsoCoreWorker.exe",
	// Windows: the temporary copy the NSIS uninstaller runs from.
	"Au_.exe", "Un_A.exe",
	// Windows accessibility.
	"osk.exe", "TabTip.exe", "Narrator.exe", "Magnify.exe", "AtBroker.exe", "Utilman.exe",
	"nvda.exe", "jfw.exe",
	// macOS.
	"kernel_task", "launchd", "WindowServer", "loginwindow", "Finder", "Dock",
	"SystemUIServer", "ControlCenter", "WindowManager", "NotificationCenter",
	"coreaudiod", "configd", "securityd", "opendirectoryd", "syspolicyd", "tccd",
	"mds", "mds_stores", "UserEventAgent", "logd", "notifyd", "cfprefsd", "distnoted",
	"powerd", "diskarbitrationd", "fseventsd", "authd", "SecurityAgent", "mDNSResponder",
	"coreservicesd", "launchservicesd", "hidd", "trustd", "universalaccessd",
	"Activity Monitor", "System Settings", "System Preferences",
	// macOS: elevation and installation, used to update or uninstall Céntrate.
	"installd", "Installer", "osascript", "security_authtrampoline", "authorizationhost",
	"launchctl",
	// macOS accessibility.
	"VoiceOver", "AssistiveControl",
	// Linux.
	"systemd", "init", "kthreadd", "systemd-logind", "systemd-resolved",
	"systemd-journald", "systemd-udevd", "dbus-daemon", "dbus-broker", "polkitd",
	"NetworkManager", "Xorg", "Xwayland", "gnome-shell", "gnome-session",
	"gnome-session-binary", "mutter", "plasmashell", "ksmserver", "kwin", "kwin_x11",
	"kwin_wayland", "xfwm4", "xfce4-session", "cinnamon", "gdm", "gdm3", "sddm",
	"lightdm", "pipewire", "wireplumber", "pulseaudio", "sshd", "sshd-session",
	"login", "agetty", "getty", "gnome-system-monitor", "plasma-systemmonitor",
	"ksysguard", "xfce4-taskmanager",
	// Linux: Wayland compositors and window managers.
	"sway", "Hyprland", "labwc", "wayfire", "weston", "niri", "cosmic-comp", "i3",
	// Linux: session services (GNOME settings daemons, portals, AT-SPI).
	"gsd-xsettings", "gsd-media-keys", "gsd-power", "gsd-keyboard", "gsd-a11y-settings",
	"gsd-color", "gsd-wacom", "gsd-sound", "gsd-smartcard", "gsd-rfkill",
	"gsd-housekeeping", "gsd-print-notifications", "gsd-sharing", "gsd-datetime",
	"gsd-screensaver-proxy", "gsd-usb-protection", "xdg-desktop-portal",
	"xdg-desktop-portal-gnome", "xdg-desktop-portal-gtk", "xdg-desktop-portal-kde",
	"xdg-desktop-portal-wlr", "xdg-desktop-portal-hyprland", "xdg-document-portal",
	"xdg-permission-store", "at-spi-bus-launcher", "at-spi2-registryd",
	// Linux: elevation and package management, used to update or uninstall
	// Céntrate.
	"pkexec", "polkit-agent-helper-1", "polkit-gnome-authentication-agent-1",
	"polkit-kde-authentication-agent-1", "sudo", "su", "doas", "dpkg", "apt", "apt-get",
	"rpm", "dnf", "packagekitd", "systemctl",
	// Linux accessibility.
	"orca", "onboard",
	// Céntrate itself (also covered by protectedPrefixes).
	"Céntrate", "Centrate", "Céntrate Helper", "centrate-guardian",
	"Uninstall Céntrate", "Uninstall Centrate",
}

// protectedPrefixes protect every name whose denyKey starts with them: the
// Céntrate app, its helpers ("Céntrate Helper (GPU)"…), the guardian, the
// installers and the uninstaller.
var protectedPrefixes = []string{"centrate", "uninstall centrate"}

var protectedKeys = func() map[string]struct{} {
	m := make(map[string]struct{}, len(protectedNames))
	for _, n := range protectedNames {
		m[denyKey(n)] = struct{}{}
	}
	return m
}()

// selfPID and selfKey identify the guardian's own process. They are variables
// so tests can override them.
var (
	selfPID = os.Getpid()
	selfKey = func() string {
		exe, err := os.Executable()
		if err != nil {
			return ""
		}
		return denyKey(baseName(exe))
	}()
)

// IsProtected reports whether name is on the hard deny-list: a system process,
// Céntrate or the guardian's own executable. The check is case-insensitive,
// ignores accents and treats ".exe" and ".app" as optional on every OS.
func IsProtected(name string) bool {
	k := denyKey(name)
	if k == "" {
		return false
	}
	if _, ok := protectedKeys[k]; ok {
		return true
	}
	for _, p := range protectedPrefixes {
		if strings.HasPrefix(k, p) {
			return true
		}
	}
	return selfKey != "" && k == selfKey
}

// protectedPID reports whether pid must never be killed on goos: invalid PIDs,
// the guardian itself, the Windows System process (4), init or launchd (1)
// and, on Linux, kthreadd (2).
func protectedPID(goos string, pid int) bool {
	switch {
	case pid <= 0 || pid == selfPID:
		return true
	case goos == "windows":
		return pid == 4
	case goos == "linux":
		return pid == 1 || pid == 2
	default:
		return pid == 1
	}
}

// processProtected reports whether p must never be matched or killed: it is a
// system process (Process.System), or its PID, its executable name or the base
// name of its executable path is protected, or its path is inside a directory
// given to ProtectDir.
//
// Comm, CmdName and Bundle are never checked: a process chooses the first two,
// and anyone can rename an .app bundle while its executable keeps its name,
// so they only ever widen matching.
func processProtected(goos string, p Process) bool {
	if p.System || protectedPID(goos, p.PID) || IsProtected(p.Name) {
		return true
	}
	if p.Path == "" {
		return false
	}
	return IsProtected(baseName(p.Path)) || inProtectedDir(goos, p.Path)
}

// protectedDirs holds the directories given to ProtectDir, cleaned.
var (
	protectedDirsMu sync.Mutex
	protectedDirs   atomic.Pointer[[]string]
)

// ProtectDir adds dir, an absolute directory, to the directories whose
// executables are never matched or killed whatever their name. The engine
// passes the Céntrate install directory recorded at install time (for example
// /Applications/Céntrate.app), so that helpers without a «Céntrate» name
// (chrome_crashpad_handler, ShipIt) stay protected. Only pass directories a
// standard user cannot write to or rename: the protection is as strong as
// that. Paths are written and compared the way the current OS writes and
// compares file names (see cleanDir), and a process path with a ".." element
// is never considered inside dir.
//
// It returns ErrInvalid for relative paths and file system roots.
func ProtectDir(dir string) error { return protectDir(runtime.GOOS, dir) }

// protectDir is ProtectDir for a directory written the way goos writes paths,
// whatever OS the code runs on, so that tests can simulate every OS.
func protectDir(goos, dir string) error {
	d, ok := cleanDir(goos, dir)
	if !ok {
		return ErrInvalid
	}
	protectedDirsMu.Lock()
	defer protectedDirsMu.Unlock()
	var dirs []string
	if cur := protectedDirs.Load(); cur != nil {
		dirs = append(dirs, *cur...)
	}
	dirs = append(dirs, d)
	protectedDirs.Store(&dirs)
	return nil
}

// cleanDir cleans dir the way goos cleans paths, lexically (like
// filepath.Clean on goos, but on any OS), and reports whether it is an
// absolute directory other than a file system root.
//
// On Windows that is a drive path (C:\Program Files\Céntrate) or a UNC path
// (\\server\share\Céntrate), with backslashes or slashes; the result uses
// backslashes. A path without a drive (\Program Files, /opt/Céntrate) is
// relative to the current drive there, and device paths (\\?\C:\…, \\.\…)
// are refused: process paths never use them, so they would protect nothing.
// Everywhere else an absolute path starts with a slash.
func cleanDir(goos, dir string) (string, bool) {
	if goos != "windows" {
		if !strings.HasPrefix(dir, "/") {
			return "", false
		}
		d := path.Clean(dir)
		return d, d != "/"
	}
	s := strings.ReplaceAll(dir, `\`, "/")
	vol := windowsVolume(s)
	rest := s[len(vol):]
	if vol == "" || !strings.HasPrefix(rest, "/") {
		return "", false
	}
	if rest = path.Clean(rest); rest == "/" {
		return "", false
	}
	return strings.ReplaceAll(vol+rest, "/", `\`), true
}

// windowsVolume returns the volume that starts p, a Windows path written with
// slashes: a drive letter and its colon ("C:"), a UNC share
// ("//server/share"), or "" when p starts with neither.
func windowsVolume(p string) string {
	if len(p) >= 2 && p[1] == ':' && ('a' <= p[0] && p[0] <= 'z' || 'A' <= p[0] && p[0] <= 'Z') {
		return p[:2]
	}
	if !strings.HasPrefix(p, "//") {
		return ""
	}
	parts := strings.SplitN(p[2:], "/", 3)
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" || parts[0] == "?" || parts[0] == "." {
		return ""
	}
	return "//" + parts[0] + "/" + parts[1]
}

// inProtectedDir reports whether path is inside a directory given to
// ProtectDir, compared the way goos compares file names.
func inProtectedDir(goos, path string) bool {
	dirs := protectedDirs.Load()
	if dirs == nil || path == "" {
		return false
	}
	for _, elem := range strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' }) {
		if elem == ".." {
			return false
		}
	}
	p := pathKey(goos, path)
	for _, d := range *dirs {
		k := pathKey(goos, d)
		sep := "/"
		if goos == "windows" {
			sep = `\`
		}
		if strings.HasPrefix(p, strings.TrimSuffix(k, sep)+sep) {
			return true
		}
	}
	return false
}

// pathKey folds a path for comparison on goos: backslashes and
// case-insensitive on Windows, case-insensitive on macOS, exact on Linux;
// Latin-1 accents compare equal composed or decomposed everywhere.
func pathKey(goos, path string) string {
	k := decomposeLatin1(path)
	switch goos {
	case "windows":
		return strings.ToLower(strings.ReplaceAll(k, "/", `\`))
	case "darwin":
		return strings.ToLower(k)
	default:
		return k
	}
}
