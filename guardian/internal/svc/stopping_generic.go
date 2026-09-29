//go:build unix && !darwin

package svc

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// stoppingTimeout bounds the check: it runs inside the stop window of the
// service manager.
const stoppingTimeout = 2 * time.Second

// osSystemStopping asks systemd whether the whole system is going down
// (`systemctl is-system-running` answers "stopping" during a shutdown, a
// reboot and a soft-reboot, which keeps the boot id). Without systemd, or
// when the answer does not come in time, it reports false: the stop is then
// handled as a plain stop. Fixed binary, fixed arguments.
func osSystemStopping() bool {
	systemctl := systemBinary("systemctl")
	if systemctl == "" {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), stoppingTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, systemctl, "is-system-running")
	cmd.Env = []string{}
	out, _ := cmd.Output() // non-zero exit for every state but "running"
	return isStoppingState(string(out))
}

// isStoppingState reports whether the output of `systemctl
// is-system-running` is "stopping".
func isStoppingState(out string) bool {
	return strings.TrimSpace(out) == "stopping"
}
