package catalog

import (
	"runtime"
	"strings"
	"unicode/utf8"
)

// Port of packages/shared/src/catalog/processes.ts.

// Platform is a catalog platform key (TS CatalogPlatform), the key of the process-name
// lists of apps and browsers.
type Platform string

// Catalog platforms.
const (
	PlatformWin   Platform = "win"
	PlatformMac   Platform = "mac"
	PlatformLinux Platform = "linux"
)

// allPlatforms lists every catalog platform, in the order findAllowDistraction checks
// them.
var allPlatforms = []Platform{PlatformWin, PlatformMac, PlatformLinux}

// PlatformForGOOS maps a runtime.GOOS value to its catalog platform, or "" when the
// catalog has no process names for that OS.
func PlatformForGOOS(goos string) Platform {
	switch goos {
	case "windows":
		return PlatformWin
	case "darwin":
		return PlatformMac
	case "linux":
		return PlatformLinux
	}
	return ""
}

// CurrentPlatform is the catalog platform of the running OS ("" when unsupported).
func CurrentPlatform() Platform { return PlatformForGOOS(runtime.GOOS) }

// maxProcessNameLength is MAX_PROCESS_NAME_LENGTH of processes.ts, in UTF-16 code units.
const maxProcessNameLength = 128

// IsValidProcessName reports whether name is a plain executable name the guardian can
// match: 1–128 UTF-16 code units, no path separators, no control or invisible characters
// (Unicode category C), no characters Windows forbids in file names, and no leading or
// trailing spaces. Invalid UTF-8 is rejected.
func IsValidProcessName(name string) bool {
	if name == "" || name == "." || name == ".." || !utf8.ValidString(name) {
		return false
	}
	if UTF16Len(name) > maxProcessNameLength || jsTrim(name) != name {
		return false
	}
	if strings.ContainsAny(name, `\/<>:"|?*`) {
		return false
	}
	for _, r := range name {
		if isOtherCategory(r) {
			return false
		}
	}
	return true
}

// ProcessNameKey is the comparison key of a process name on platform: Unicode NFC (macOS
// file names come decomposed) and, on Windows and macOS, lowercase, because those file
// systems ignore case. Linux keeps the exact name.
func ProcessNameKey(name string, platform Platform) string {
	composed := nfc(name)
	if platform == PlatformLinux {
		return composed
	}
	return jsToLower(composed)
}

// protectedPrefixes protect every name whose protected key starts with them: the
// Céntrate app, its helpers, the guardian, the installers («Céntrate Setup 1.0.0.exe»)
// and the uninstaller (PROTECTED_PREFIXES of processes.ts, protectedPrefixes of
// procwatch).
var protectedPrefixes = []string{"centrate", "uninstall centrate"}

// protectedKey is the deny-list key of processes.ts (and procwatch's denyKey): trimmed,
// without accents, lowercase and without a trailing .exe or .app.
func protectedKey(name string) string {
	k := jsToLower(stripMarks(jsTrim(name)))
	k = strings.TrimSuffix(k, ".exe")
	k = strings.TrimSuffix(k, ".app")
	return jsTrim(k)
}

// IsProtectedProcessName reports whether name must never be killed nor blocked (the
// catalog's protectedProcesses: system processes, Task Manager and Settings,
// accessibility tools, Céntrate itself; and any name starting with «centrate» or
// «uninstall centrate»). The comparison ignores case and accents and treats .exe and
// .app as optional, on every platform.
func (c *Catalog) IsProtectedProcessName(name string) bool {
	key := protectedKey(name)
	if key == "" {
		return false
	}
	if _, ok := c.protectedKeys[key]; ok {
		return true
	}
	for _, prefix := range protectedPrefixes {
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}
