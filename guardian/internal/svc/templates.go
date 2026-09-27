package svc

import (
	"regexp"
	"strings"
)

// systemdScript is the unit kardianos renders on Linux (its mini template
// syntax). StartLimitIntervalSec=0 disables systemd's start rate limit so
// Restart=always never gives up.
const systemdScript = `[Unit]
Description={{Description}}
ConditionFileIsExecutable={{Path | cmdEscape}}
After=local-fs.target network.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart={{Path | cmdEscape}}{{range Arguments}} {{. | cmd}}{{end}}
Restart=always
RestartSec=2
TimeoutStopSec=15
KillMode=mixed

[Install]
WantedBy=multi-user.target
`

var launchdPIDRe = regexp.MustCompile(`(?m)^\s*pid = [0-9]+\s*$`)

// launchdRunning parses the output of "launchctl print system/<label>" and
// reports whether the job has a running process.
func launchdRunning(out string) bool {
	if launchdPIDRe.MatchString(out) {
		return true
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "state = running" {
			return true
		}
	}
	return false
}
