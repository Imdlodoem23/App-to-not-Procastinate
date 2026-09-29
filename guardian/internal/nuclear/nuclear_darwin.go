//go:build darwin

package nuclear

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"github.com/imdlodoem23/centrate/guardian/internal/procwatch"
)

// launchctlPath is launchd's control tool.
const launchctlPath = "/bin/launchctl"

// consoleUID is the owner of /dev/console (the user at the login window's session),
// or ErrNoConsoleUser when root owns it (nobody is logged in).
func (r *Relauncher) consoleUID() (uint32, error) {
	if r.console != nil {
		return r.console()
	}
	fi, err := os.Stat("/dev/console")
	if err != nil {
		return 0, err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, errors.New("nuclear: no owner for /dev/console")
	}
	if st.Uid == 0 {
		return 0, ErrNoConsoleUser
	}
	return st.Uid, nil
}

// AppRunning implements engine.NuclearRelauncher: a user process whose executable path
// (the kernel's, see procwatch) is exactly appPath.
func (r *Relauncher) AppRunning() (bool, error) {
	if _, err := r.consoleUID(); errors.Is(err, ErrNoConsoleUser) {
		return false, nil
	}
	procs, err := procwatch.List()
	if err != nil {
		return false, err
	}
	for _, p := range procs {
		if !p.System && p.Path == r.appPath {
			return true, nil
		}
	}
	return false, nil
}

// Relaunch implements engine.NuclearRelauncher: launchctl kickstart of the Nuclear
// LaunchAgent in the console user's GUI session (its ProgramArguments are the absolute
// app path and Arg; never `open -b`, which could pick a look-alike bundle).
func (r *Relauncher) Relaunch(ctx context.Context) error {
	uid, err := r.consoleUID()
	if err != nil {
		return err
	}
	run := r.run
	if run == nil {
		run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
			return exec.CommandContext(ctx, name, args...).CombinedOutput()
		}
	}
	if out, err := run(ctx, launchctlPath, darwinRelaunchArgs(uid)...); err != nil {
		return fmt.Errorf("nuclear: kickstart %s: %w", DarwinAgentLabel, cmdError(err, out))
	}
	return nil
}
