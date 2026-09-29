package svc

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/kardianos/service"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

const launchctl = "/bin/launchctl"

// launchdTarget is the job's service target in the system domain.
const launchdTarget = "system/" + LaunchdLabel

func serviceID() string { return LaunchdLabel }

// registeredExecutable is always the helper copy, so the app bundle can move.
func registeredExecutable(string) string { return DarwinHelperPath }

func platformOptions() service.KeyValue {
	return service.KeyValue{
		"KeepAlive": true,
		"RunAtLoad": true,
		// Always exists and is root-only; kardianos derives
		// StandardErrorPath (DarwinStderrLog) from it.
		"LogDirectory":  filepath.Dir(DarwinStderrLog),
		"LaunchdConfig": launchdPlist,
	}
}

func loaded() bool {
	_, err := runCmd(launchctl, "print", launchdTarget)
	return err == nil
}

// enable clears launchd's "disabled" override for the job, left by
// "launchctl disable" or by switching the item off in System Settings >
// General > Login Items. It persists across reboots and reinstalls, and while
// it is set bootstrap fails with a generic I/O error. It is idempotent.
func enable() {
	_, _ = runCmd(launchctl, "enable", launchdTarget)
}

// disabledByUser reports whether launchd still lists the job as disabled.
func disabledByUser() bool {
	out, err := runCmd(launchctl, "print-disabled", "system")
	return err == nil && launchdDisabled(out, LaunchdLabel)
}

func bootstrap() error {
	enable()
	var err error
	// Right after a bootout launchd may still be tearing the job down
	// ("Bootstrap failed: 5: Input/output error"): retry for a few seconds.
	for range 10 {
		if _, err = runCmd(launchctl, "bootstrap", "system", DarwinPlistPath); err == nil || loaded() {
			return nil
		}
		if disabledByUser() {
			return ErrDisabledByUser
		}
		time.Sleep(300 * time.Millisecond)
	}
	return err
}

// kickstart starts (or with -k restarts) the loaded job.
func kickstart(args ...string) error {
	enable()
	if _, err := runCmd(launchctl, append(append([]string{"kickstart"}, args...), launchdTarget)...); err != nil {
		if disabledByUser() {
			return ErrDisabledByUser
		}
		return err
	}
	return nil
}

func bootout() error {
	if !loaded() {
		return nil
	}
	_, err := runCmd(launchctl, "bootout", launchdTarget)
	for i := 0; i < 50 && loaded(); i++ {
		time.Sleep(100 * time.Millisecond)
	}
	if loaded() {
		if err != nil {
			return err
		}
		return errors.New("the launchd job is still loaded after bootout")
	}
	return nil
}

func (m *Manager) install() error {
	if err := bootout(); err != nil {
		return err
	}
	if err := installExecutable(m.sourceExe, DarwinHelperPath); err != nil {
		return fmt.Errorf("copy binary to %s: %w", DarwinHelperPath, err)
	}
	if os.Geteuid() == 0 {
		if err := os.Chown(DarwinHelperPath, 0, 0); err != nil {
			return err
		}
	}
	// kardianos refuses to overwrite a plist: remove it first.
	if err := removeFile(DarwinPlistPath); err != nil {
		return err
	}
	if err := m.svc.Install(); err != nil {
		return err
	}
	// launchd ignores plists that are group- or world-writable.
	if err := os.Chmod(DarwinPlistPath, 0o644); err != nil {
		return err
	}
	if err := writeNewsyslogConf(); err != nil {
		m.logger.Warn("could not install the stderr log rotation", "err", err)
	}
	return bootstrap()
}

// writeNewsyslogConf installs the rotation rule for DarwinStderrLog.
func writeNewsyslogConf() error {
	if err := os.MkdirAll(filepath.Dir(DarwinNewsyslogPath), 0o755); err != nil {
		return err
	}
	f, err := platform.OpenRegularFile(DarwinNewsyslogPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(newsyslogConf); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

func (m *Manager) uninstall() error {
	var errs []error
	if err := bootout(); err != nil {
		errs = append(errs, err)
	}
	// newsyslog names rotated copies <log>.0, <log>.1, <log>.2.
	for _, p := range []string{
		DarwinPlistPath,
		DarwinHelperPath,
		DarwinNewsyslogPath,
		DarwinStderrLog,
		DarwinStderrLog + ".0",
		DarwinStderrLog + ".1",
		DarwinStderrLog + ".2",
	} {
		if err := removeFile(p); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (m *Manager) status() (Status, error) {
	installed := fileExists(DarwinPlistPath)
	out, err := runCmd(launchctl, "print", launchdTarget)
	if err != nil {
		// Not loaded (or not visible to this user).
		return Status{Installed: installed}, nil
	}
	return Status{Installed: true, Running: launchdRunning(out)}, nil
}

func (m *Manager) start() error {
	if !fileExists(DarwinPlistPath) {
		return ErrNotInstalled
	}
	if !loaded() {
		return bootstrap()
	}
	if st, err := m.status(); err == nil && st.Running {
		return nil
	}
	return kickstart()
}

func (m *Manager) stop() error {
	if !fileExists(DarwinPlistPath) && !loaded() {
		return ErrNotInstalled
	}
	// KeepAlive would respawn a killed process: unloading is the only stop.
	return bootout()
}

func (m *Manager) restart() error {
	if !fileExists(DarwinPlistPath) {
		return ErrNotInstalled
	}
	if !loaded() {
		return bootstrap()
	}
	return kickstart("-k")
}
