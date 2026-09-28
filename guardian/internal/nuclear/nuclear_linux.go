//go:build linux

package nuclear

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
)

const (
	defaultProcDir  = "/proc"
	defaultSeatFile = "/run/systemd/seats/seat0"
)

// systemctlPaths are where systemd installs systemctl (merged and split /usr).
var systemctlPaths = []string{"/usr/bin/systemctl", "/bin/systemctl"}

// consoleUID is the uid of seat0's active session (logind), or ErrNoConsoleUser.
// Root never counts: the app is never relaunched as root.
func (r *Relauncher) consoleUID() (uint32, error) {
	path := r.seatFile
	if path == "" {
		path = defaultSeatFile
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, ErrNoConsoleUser
	}
	if err != nil {
		return 0, err
	}
	uid, ok := parseSeatActiveUID(data)
	if !ok || uid == 0 {
		return 0, ErrNoConsoleUser
	}
	return uid, nil
}

// AppRunning implements engine.NuclearRelauncher: a process whose /proc/<pid>/exe is
// exactly appPath runs as the console user.
func (r *Relauncher) AppRunning() (bool, error) {
	uid, err := r.consoleUID()
	if errors.Is(err, ErrNoConsoleUser) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	dir := r.procDir
	if dir == "" {
		dir = defaultProcDir
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false, err
	}
	for _, e := range entries {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		p := filepath.Join(dir, e.Name())
		exe, err := os.Readlink(filepath.Join(p, "exe"))
		if err != nil || exe != r.appPath {
			continue
		}
		fi, err := os.Stat(p)
		if err != nil {
			continue
		}
		if st, ok := fi.Sys().(*syscall.Stat_t); ok && st.Uid == uid {
			return true, nil
		}
	}
	return false, nil
}

// Relaunch implements engine.NuclearRelauncher: systemctl starts the Nuclear user unit
// in the seat0 user's manager.
func (r *Relauncher) Relaunch(ctx context.Context) error {
	uid, err := r.consoleUID()
	if err != nil {
		return err
	}
	bin := r.systemctl
	if bin == "" {
		for _, p := range systemctlPaths {
			if _, err := os.Stat(p); err == nil {
				bin = p
				break
			}
		}
	}
	if bin == "" {
		return errors.New("nuclear: systemctl not found")
	}
	run := r.run
	if run == nil {
		run = runCommand
	}
	if out, err := run(ctx, bin, linuxRelaunchArgs(uid)...); err != nil {
		return fmt.Errorf("nuclear: start %s: %w", LinuxUnit, cmdError(err, out))
	}
	return nil
}

// runCommand runs a fixed binary with a fixed argument list.
func runCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}
