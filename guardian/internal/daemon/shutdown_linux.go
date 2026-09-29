//go:build linux

package daemon

import (
	"context"
	"os"
	"os/exec"
	"time"
)

// shutdownCheckTimeout bounds the systemctl query during a stop.
const shutdownCheckTimeout = 2 * time.Second

// systemctlPaths are where systemd installs systemctl (merged and split /usr).
var systemctlPaths = []string{"/usr/bin/systemctl", "/bin/systemctl"}

// SystemShuttingDown reports whether systemd is stopping the whole system (a shutdown
// or reboot) rather than only this service: `systemctl is-system-running` prints
// "stopping" then (§13). It runs a fixed binary with fixed arguments (§9.7). Without
// systemd it reports false.
func SystemShuttingDown() bool {
	if fi, err := os.Stat("/run/systemd/system"); err != nil || !fi.IsDir() {
		return false
	}
	for _, bin := range systemctlPaths {
		if _, err := os.Stat(bin); err != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), shutdownCheckTimeout)
		// The exit status is not 0 whenever the state is not "running"; only the
		// printed state matters.
		out, _ := exec.CommandContext(ctx, bin, "is-system-running").Output()
		cancel()
		return systemdStopping(out)
	}
	return false
}
