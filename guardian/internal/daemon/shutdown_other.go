//go:build !linux

package daemon

// SystemShuttingDown reports whether the OS is shutting down when the service is
// stopped. Windows tells services apart (SERVICE_CONTROL_SHUTDOWN reaches
// Runner.Shutdown), so a plain stop never is one. On macOS launchd sends the same
// SIGTERM for both and there is no reliable signal yet (docs/ARCHITECTURE.md §17 item 12
// spike): a stop is treated as a plain stop, and the reboot that follows a shutdown is
// never priced anyway (a new boot id, §10.12 step 9).
func SystemShuttingDown() bool { return false }
