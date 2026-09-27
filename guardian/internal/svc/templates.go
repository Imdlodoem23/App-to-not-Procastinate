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

// launchdPlist is the LaunchDaemon kardianos renders on macOS (its mini
// template syntax; the same keys as its default template). Differences:
// AssociatedBundleIdentifiers makes macOS 13+ list the daemon under the app
// in Login Items; ThrottleInterval spaces KeepAlive respawns; stdout goes to
// /dev/null and stderr (Go panics only) to StandardErrorPath, derived from the
// LogDirectory option, which must be a folder that always exists (/var/log):
// launchd does not create it and fails to spawn the job without it.
const launchdPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AssociatedBundleIdentifiers</key>
	<array>
		<string>` + AppBundleID + `</string>
	</array>
	<key>Disabled</key>
	<false/>
	<key>KeepAlive</key>
	<{{KeepAlive}}/>
	<key>Label</key>
	<string>{{Name | html}}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{{Path | html}}</string>
{{range Arguments}}		<string>{{. | html}}</string>
{{end}}	</array>
	<key>RunAtLoad</key>
	<{{RunAtLoad}}/>
	<key>StandardErrorPath</key>
	<string>{{StandardErrorPath | html}}</string>
	<key>StandardOutPath</key>
	<string>/dev/null</string>
	<key>ThrottleInterval</key>
	<integer>5</integer>
</dict>
</plist>
`

// newsyslogConf rotates DarwinStderrLog (1 MB, 3 copies, no signal).
const newsyslogConf = `# Rotates the stderr log of the Centrate guardian (written by launchd).
# logfilename                                            [owner:group]  mode  count  size(KB)  when  flags
` + DarwinStderrLog + `  root:wheel  644  3  1024  *  N
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

// launchdDisabled parses the output of "launchctl print-disabled system" and
// reports whether label is disabled: `"label" => disabled` (macOS 11+) or
// `"label" => true` (older).
func launchdDisabled(out, label string) bool {
	prefix := `"` + label + `"`
	for _, line := range strings.Split(out, "\n") {
		rest, ok := strings.CutPrefix(strings.TrimSpace(line), prefix)
		if !ok {
			continue
		}
		rest, ok = strings.CutPrefix(strings.TrimSpace(rest), "=>")
		if !ok {
			continue
		}
		switch strings.TrimSpace(rest) {
		case "disabled", "true":
			return true
		}
	}
	return false
}
