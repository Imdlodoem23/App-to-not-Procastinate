package svc

import (
	"errors"
	"fmt"
	"os"
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
		"KeepAlive":    true,
		"RunAtLoad":    true,
		"LogDirectory": platform.LogDir(),
	}
}

func loaded() bool {
	_, err := runCmd(launchctl, "print", launchdTarget)
	return err == nil
}

func bootstrap() error {
	var err error
	// Right after a bootout launchd may still be tearing the job down
	// ("Bootstrap failed: 5: Input/output error"): retry for a few seconds.
	for range 10 {
		if _, err = runCmd(launchctl, "bootstrap", "system", DarwinPlistPath); err == nil || loaded() {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return err
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
	if err := platform.EnsureDir(platform.LogDir()); err != nil {
		return err
	}
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
	return bootstrap()
}

func (m *Manager) uninstall() error {
	var errs []error
	if err := bootout(); err != nil {
		errs = append(errs, err)
	}
	if err := removeFile(DarwinPlistPath); err != nil {
		errs = append(errs, err)
	}
	if err := removeFile(DarwinHelperPath); err != nil {
		errs = append(errs, err)
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
	_, err := runCmd(launchctl, "kickstart", launchdTarget)
	return err
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
	_, err := runCmd(launchctl, "kickstart", "-k", launchdTarget)
	return err
}
