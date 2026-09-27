//go:build !windows && !darwin

package svc

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/kardianos/service"
)

func serviceID() string { return Name }

// registeredExecutable keeps the binary where it is unless it lives on an
// AppImage mount or in a temp dir, which vanish; then install copies it to
// LinuxStablePath.
func registeredExecutable(src string) string {
	if isEphemeralPath(src) {
		return LinuxStablePath
	}
	return src
}

func platformOptions() service.KeyValue {
	return service.KeyValue{
		"SystemdScript": systemdScript,
		"Restart":       "always",
	}
}

func (m *Manager) isSystemd() bool {
	return m.svc.Platform() == "linux-systemd"
}

func (m *Manager) install() error {
	target := m.cfg.Executable
	if target != m.sourceExe {
		if err := installExecutable(m.sourceExe, target); err != nil {
			return fmt.Errorf("copy binary to %s: %w", target, err)
		}
	} else if target != LinuxStablePath {
		// A previous install from an AppImage may have left a copy behind.
		if err := removeFile(LinuxStablePath); err != nil {
			m.logger.Warn("could not remove stale binary copy", "err", err)
		}
	}
	if st, err := m.status(); err == nil && st.Installed {
		// kardianos refuses to overwrite a registration: remove it first. The
		// running process keeps going until the restart below.
		if err := m.svc.Uninstall(); err != nil {
			m.logger.Warn("removing the previous registration failed", "err", err)
		}
	}
	if m.isSystemd() {
		if err := removeFile(SystemdUnitPath); err != nil {
			return err
		}
	}
	if err := m.svc.Install(); err != nil {
		return err
	}
	if m.isSystemd() {
		return m.svc.Restart()
	}
	_ = m.svc.Stop()
	return m.svc.Start()
}

func (m *Manager) uninstall() error {
	var errs []error
	if st, _ := m.status(); st.Installed {
		if err := m.svc.Stop(); err != nil {
			m.logger.Warn("stop before uninstall failed", "err", err)
		}
		if err := m.svc.Uninstall(); err != nil && !errors.Is(err, service.ErrNotInstalled) {
			if m.isSystemd() && fileExists(SystemdUnitPath) {
				if rmErr := removeFile(SystemdUnitPath); rmErr != nil {
					errs = append(errs, err, rmErr)
				} else {
					_, _ = runCmd("systemctl", "daemon-reload")
				}
			} else if !m.isSystemd() {
				errs = append(errs, err)
			}
		}
	}
	if err := removeFile(LinuxStablePath); err != nil {
		errs = append(errs, err)
	}
	// Only succeeds when empty, which is the point.
	_ = os.Remove(filepath.Dir(LinuxStablePath))
	return errors.Join(errs...)
}

// registrationFiles are where kardianos writes the service definition for
// each init system (systemd, SysV/OpenRC/rc.d, Upstart).
var registrationFiles = []string{
	SystemdUnitPath,
	"/etc/init.d/" + Name,
	"/etc/init/" + Name + ".conf",
}

func registered() bool {
	for _, p := range registrationFiles {
		if fileExists(p) {
			return true
		}
	}
	return false
}

func (m *Manager) status() (Status, error) {
	s, err := m.svc.Status()
	if err == nil {
		return Status{Installed: true, Running: s == service.StatusRunning}, nil
	}
	// systemd reports a crashed unit as an error ("failed" state) and SysV's
	// "service X status" fails for an unknown service: decide by the files.
	return Status{Installed: registered()}, nil
}

func (m *Manager) start() error {
	st, err := m.status()
	switch {
	case err != nil:
		return err
	case !st.Installed:
		return ErrNotInstalled
	case st.Running:
		return nil
	}
	return m.svc.Start()
}

func (m *Manager) stop() error {
	st, err := m.status()
	switch {
	case err != nil:
		return err
	case !st.Installed:
		return ErrNotInstalled
	case !st.Running:
		return nil
	}
	return m.svc.Stop()
}

func (m *Manager) restart() error {
	st, err := m.status()
	switch {
	case err != nil:
		return err
	case !st.Installed:
		return ErrNotInstalled
	}
	if m.isSystemd() {
		return m.svc.Restart()
	}
	if st.Running {
		if err := m.svc.Stop(); err != nil {
			return err
		}
	}
	return m.svc.Start()
}
