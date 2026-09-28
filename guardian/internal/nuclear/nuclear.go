// Package nuclear is the OS side of the Nuclear supervisor (docs/ARCHITECTURE.md §10.5):
// whether the desktop app runs in the active console session from its admin-owned
// config.json appPath, and relaunching it there, as the console user and never as
// root/SYSTEM, with the constant argument --centrate-nuclear. *Relauncher implements
// engine.NuclearRelauncher.
//
//	Windows  WTSGetActiveConsoleSessionId → WTSQueryUserToken → CreateProcessAsUserW(appPath)
//	macOS    launchctl kickstart gui/<console uid>/io.github.imdlodoem23.centrate.nuclear
//	         (the LaunchAgent the privileged installer writes with the absolute app path)
//	Linux    systemctl --user --machine=<seat0 uid>@.host start centrate-nuclear.service
//	         (the user unit the package installs)
//
// Liveness is only ever decided by the exact executable path (never a name or a bundle
// id): a renamed copy or a look-alike does not count (§16.2 #39). Every command is a
// fixed binary with a fixed argument list; the only variable part is a numeric uid read
// from the OS, never anything from a request or from state (§9.7).
package nuclear

import (
	"context"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
)

// Arg is the constant argument the app is relaunched with.
const Arg = "--centrate-nuclear"

// DarwinAgentLabel is the Nuclear LaunchAgent (macOS), installed by the privileged
// installer in /Library/LaunchAgents.
const DarwinAgentLabel = "io.github.imdlodoem23.centrate.nuclear"

// DarwinAgentPath is the LaunchAgent's property list; uninstall removes it.
const DarwinAgentPath = "/Library/LaunchAgents/" + DarwinAgentLabel + ".plist"

// LinuxUnit is the systemd user unit the package installs (ExecStart=<app> --centrate-nuclear).
const LinuxUnit = "centrate-nuclear.service"

// ErrNoConsoleUser means nobody is logged in at the console: there is no session to
// relaunch the app in (the supervisor retries at its next tick).
var ErrNoConsoleUser = errors.New("nuclear: no user is logged in at the console")

// ErrUnsupported is returned on operating systems without a relaunch mechanism.
var ErrUnsupported = errors.New("nuclear: not supported on this operating system")

// Relauncher is the real engine.NuclearRelauncher for the app at one absolute path.
type Relauncher struct {
	appPath string

	// Seams for tests; zero values select the system.
	procDir   string // Linux: /proc
	seatFile  string // Linux: logind's seat0 state
	systemctl string // Linux: the systemctl binary
	run       func(ctx context.Context, name string, args ...string) ([]byte, error)
	console   func() (uint32, error) // macOS: the console user's uid
}

// New returns a Relauncher for appPath (config.json appPath, absolute), or nil when
// appPath is empty or relative: without it the supervisor cannot relaunch anything.
func New(appPath string) *Relauncher {
	if appPath == "" || !filepath.IsAbs(appPath) {
		return nil
	}
	return &Relauncher{appPath: filepath.Clean(appPath)}
}

// AppPath is the executable the Relauncher watches and starts.
func (r *Relauncher) AppPath() string { return r.appPath }

// parseSeatActiveUID reads ACTIVE_UID from logind's seat state file
// (/run/systemd/seats/seat0): the user of the seat's active session.
func parseSeatActiveUID(data []byte) (uint32, bool) {
	for line := range strings.Lines(string(data)) {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok || k != "ACTIVE_UID" {
			continue
		}
		uid, err := strconv.ParseUint(v, 10, 32)
		if err != nil {
			return 0, false
		}
		return uint32(uid), true
	}
	return 0, false
}

// linuxRelaunchArgs is the systemctl argument list that starts the Nuclear user unit
// of uid (numeric, from logind).
func linuxRelaunchArgs(uid uint32) []string {
	return []string{"--user", "--machine=" + strconv.FormatUint(uint64(uid), 10) + "@.host", "start", LinuxUnit}
}

// darwinRelaunchArgs is the launchctl argument list that starts the Nuclear
// LaunchAgent in uid's GUI session.
func darwinRelaunchArgs(uid uint32) []string {
	return []string{"kickstart", "gui/" + strconv.FormatUint(uint64(uid), 10) + "/" + DarwinAgentLabel}
}

// cmdError keeps a failing command's output short in errors (and so in logs).
func cmdError(err error, out []byte) error {
	msg := strings.TrimSpace(string(out))
	if len(msg) > 200 {
		msg = msg[:200]
	}
	if msg == "" {
		return err
	}
	return errors.New(err.Error() + ": " + msg)
}
