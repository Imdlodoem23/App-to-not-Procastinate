//go:build unix && !darwin

package svc

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/kardianos/service"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// protectedTargets are the root-only places install copies the binary to, in
// order of preference. A variable so tests can use temporary folders.
var protectedTargets = []string{LinuxStablePath, LinuxFallbackPath}

// systemBinDirs are the only places systemctl is looked for: PATH is not
// consulted.
var systemBinDirs = []string{"/usr/bin", "/bin", "/usr/sbin", "/sbin"}

func serviceID() string { return Name }

// registeredExecutable keeps the binary where it is only when that is safe to
// run as root at every boot (see trustedInPlace). Otherwise install copies it
// to LinuxStablePath (or LinuxFallbackPath, decided at install time).
func registeredExecutable(src string) string {
	if trustedInPlace(src) {
		return src
	}
	return LinuxStablePath
}

// trustedInPlace reports whether src can be registered where it is: a
// regular file on a path that survives reboots, that the unit can quote, and
// that only root can replace (root owns it and every folder above it, none
// writable by group or others). A .deb install under /opt passes; an
// extracted AppImage in $HOME, a tarball in Downloads or an AppImage mount
// does not.
func trustedInPlace(src string) bool {
	if isEphemeralPath(src) || !unitSafe(src) {
		return false
	}
	fi, err := lstat(src)
	if err != nil || !fi.Mode().IsRegular() {
		return false
	}
	return checkRootOnly(src) == nil
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
	if m.cfg.Executable != m.sourceExe {
		dst, err := m.copyToProtected()
		if err != nil {
			return err
		}
		m.cfg.Executable = dst
	} else {
		// A previous install from an untrusted location may have left a copy
		// (keep the source: it may be one of those copies).
		m.removeCopies(m.sourceExe)
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

// copyToProtected copies the binary to the first protectedTargets entry that
// ends up root-only and returns the path to register.
func (m *Manager) copyToProtected() (string, error) {
	var errs []error
	for _, dst := range protectedTargets {
		path, err := copyProtected(m.sourceExe, dst)
		if err == nil {
			m.removeCopies(path)
			return path, nil
		}
		errs = append(errs, fmt.Errorf("%s: %w", dst, err))
	}
	return "", fmt.Errorf("%w: %w", ErrUntrustedExecutable, errors.Join(errs...))
}

// copyProtected creates dst's folder root-owned 0755 (through a descriptor
// that never follows links), copies src there under the folder's real path
// and checks that the result and every folder above it are root-only. It
// fails on a read-only /usr/local (EROFS) or a /usr/local someone chowned to
// a user, so the caller can try the next location.
func copyProtected(src, dst string) (string, error) {
	dir := filepath.Dir(dst)
	if err := platform.EnsureDir(dir); err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", err
	}
	target := filepath.Join(real, filepath.Base(dst))
	if !unitSafe(target) {
		return "", fmt.Errorf("%q cannot be written into a systemd unit", target)
	}
	if err := installExecutable(src, target); err != nil {
		return "", err
	}
	if err := checkRootOnly(target); err != nil {
		_ = removeFile(target)
		return "", err
	}
	return target, nil
}

// removeCopies deletes the binary copies install may have made, except keep,
// and their folders when empty.
func (m *Manager) removeCopies(keep string) {
	for _, p := range protectedTargets {
		if keep != "" && sameFile(p, keep) {
			continue
		}
		if err := removeFile(p); err != nil {
			m.logger.Warn("could not remove a stale binary copy", "err", err)
		}
		// Only succeeds when empty, which is the point.
		_ = os.Remove(filepath.Dir(p))
	}
}

func sameFile(a, b string) bool {
	fa, err := os.Stat(a)
	if err != nil {
		return false
	}
	fb, err := os.Stat(b)
	return err == nil && os.SameFile(fa, fb)
}

// systemBinary returns the absolute path of a system tool from systemBinDirs,
// or "".
func systemBinary(name string) string {
	for _, dir := range systemBinDirs {
		p := filepath.Join(dir, name)
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0 {
			return p
		}
	}
	return ""
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
				} else if systemctl := systemBinary("systemctl"); systemctl != "" {
					_, _ = runCmd(systemctl, "daemon-reload")
				}
			} else if !m.isSystemd() {
				errs = append(errs, err)
			}
		}
	}
	for _, p := range protectedTargets {
		if err := removeFile(p); err != nil {
			errs = append(errs, err)
		}
		// Only succeeds when empty, which is the point.
		_ = os.Remove(filepath.Dir(p))
	}
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
