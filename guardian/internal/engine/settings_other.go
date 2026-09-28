//go:build !windows

package engine

// OWNER: settings teammate (docs/ARCHITECTURE.md §4).

// windowsOSZone is only meaningful on Windows (settings_windows.go).
func windowsOSZone() string { return "" }
