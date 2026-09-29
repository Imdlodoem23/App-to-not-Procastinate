package awake

import (
	"os"
	"strconv"
)

// Fixed argument vectors (§10.14). They are built only from constants, the binaries
// resolved from fixed absolute candidates and the guardian's own PID: nothing a request
// carries ever reaches them, no shell runs them and PATH is never searched.

// Candidates for the Linux binaries, in order: never resolved through PATH.
var (
	systemdInhibitCandidates = []string{"/usr/bin/systemd-inhibit", "/bin/systemd-inhibit"}
	sleepCandidates          = []string{"/usr/bin/sleep", "/bin/sleep"}
)

// caffeinatePath is macOS's caffeinate.
const caffeinatePath = "/usr/bin/caffeinate"

// childEnv is the whole environment of a child: nothing inherited from the service.
var childEnv = []string{"PATH=/usr/bin:/bin", "LC_ALL=C"}

// systemdInhibitArgv is the Linux child: an idle and sleep block inhibitor held by logind
// for as long as `sleep infinity` runs. Lid switches still act (logind's default
// LidSwitchIgnoreInhibited=yes).
func systemdInhibitArgv(systemdInhibit, sleep string) []string {
	return []string{
		systemdInhibit,
		"--what=idle:sleep",
		"--who=Céntrate",
		"--why=Mantener despierto",
		"--mode=block",
		sleep,
		"infinity",
	}
}

// caffeinateArgv is the macOS child: -i prevents idle system sleep only (never -s, which
// can keep a Mac on AC power awake beyond idle, nor -d: the display is the app's); -w
// ends it with the guardian.
func caffeinateArgv(guardianPID int) []string {
	return []string{caffeinatePath, "-i", "-w", strconv.Itoa(guardianPID)}
}

// findExecutable returns the first candidate that is a regular executable file.
func findExecutable(candidates []string) (string, bool) {
	for _, p := range candidates {
		fi, err := os.Stat(p)
		if err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0 {
			return p, true
		}
	}
	return "", false
}
