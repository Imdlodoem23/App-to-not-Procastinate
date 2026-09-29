//go:build darwin || !unix

package svc

// osSystemStopping reports false: Windows delivers a shutdown as its own
// control (program.Shutdown), and a macOS shutdown always reboots the kernel,
// so the next start has a new boot id and is never penalized.
func osSystemStopping() bool { return false }
