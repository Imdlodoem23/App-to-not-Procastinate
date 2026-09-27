package svc

import (
	"errors"
	"fmt"
	"time"

	"github.com/kardianos/service"
	"golang.org/x/sys/windows"
	winsvc "golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	// Recovery: restart 5 s after each of the first three failures; the
	// failure count resets after a day without failures.
	recoveryDelay       = 5 * time.Second
	recoveryAttempts    = 3
	recoveryResetPeriod = 24 * 60 * 60 // seconds

	stopTimeout = 30 * time.Second
)

func serviceID() string { return Name }

func registeredExecutable(src string) string { return src }

func platformOptions() service.KeyValue {
	return service.KeyValue{
		"StartType":              "automatic",
		"DelayedAutoStart":       false,
		"OnFailure":              "restart",
		"OnFailureDelayDuration": recoveryDelay.String(),
		"OnFailureResetPeriod":   recoveryResetPeriod,
	}
}

// withService opens the service with full access (needs administrator rights).
func withService(fn func(s *mgr.Service) error) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(Name)
	if err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return ErrNotInstalled
		}
		return err
	}
	defer s.Close()
	return fn(s)
}

func (m *Manager) install() error {
	err := withService(func(*mgr.Service) error { return nil })
	switch {
	case errors.Is(err, ErrNotInstalled):
		if err := m.svc.Install(); err != nil {
			if errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
				return fmt.Errorf("the previous service is still marked for deletion; close the Services console and retry: %w", err)
			}
			return err
		}
	case err != nil:
		return err
	}
	if err := withService(func(s *mgr.Service) error { return configure(s, m.cfg.Executable) }); err != nil {
		return fmt.Errorf("configure service: %w", err)
	}
	return m.restart()
}

// configure makes an existing registration match this build: binary path,
// names, automatic (not delayed) start and recovery actions.
func configure(s *mgr.Service, exe string) error {
	c, err := s.Config()
	if err != nil {
		return err
	}
	c.BinaryPathName = windows.EscapeArg(exe) + " " + RunArg
	c.DisplayName = DisplayName
	c.Description = Description
	c.ServiceType = windows.SERVICE_WIN32_OWN_PROCESS
	c.StartType = mgr.StartAutomatic
	c.ErrorControl = mgr.ErrorNormal
	c.DelayedAutoStart = false
	// Empty values mean "leave unchanged" for ChangeServiceConfig.
	c.ServiceStartName, c.Password, c.LoadOrderGroup, c.Dependencies = "", "", "", nil
	if err := s.UpdateConfig(c); err != nil {
		return err
	}
	actions := make([]mgr.RecoveryAction, recoveryAttempts)
	for i := range actions {
		actions[i] = mgr.RecoveryAction{Type: mgr.ServiceRestart, Delay: recoveryDelay}
	}
	if err := s.SetRecoveryActions(actions, recoveryResetPeriod); err != nil {
		return err
	}
	// Also recover when the process exits with an error instead of crashing.
	return s.SetRecoveryActionsOnNonCrashFailures(true)
}

func (m *Manager) uninstall() error {
	err := withService(func(s *mgr.Service) error {
		if err := stopAndWait(s); err != nil {
			return err
		}
		return s.Delete()
	})
	if errors.Is(err, ErrNotInstalled) {
		err = nil
	}
	if err != nil {
		return err
	}
	// The event log source may already be gone.
	_ = eventlog.Remove(Name)
	return nil
}

func (m *Manager) status() (Status, error) {
	s, err := m.svc.Status()
	switch {
	case err == nil:
		return Status{Installed: true, Running: s == service.StatusRunning}, nil
	case errors.Is(err, service.ErrNotInstalled):
		return Status{}, nil
	}
	return Status{}, err
}

func (m *Manager) start() error {
	return withService(startService)
}

func (m *Manager) stop() error {
	return withService(stopAndWait)
}

func (m *Manager) restart() error {
	return withService(func(s *mgr.Service) error {
		if err := stopAndWait(s); err != nil {
			return err
		}
		return startService(s)
	})
}

func startService(s *mgr.Service) error {
	if err := s.Start(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return err
	}
	return nil
}

// stopAndWait asks the service to stop and waits until it has, up to stopTimeout.
func stopAndWait(s *mgr.Service) error {
	st, err := s.Query()
	if err != nil {
		return err
	}
	deadline := time.Now().Add(stopTimeout)
	for st.State != winsvc.Stopped {
		if st.State == winsvc.Running || st.State == winsvc.Paused {
			if _, err := s.Control(winsvc.Stop); err != nil &&
				!errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) &&
				!errors.Is(err, windows.ERROR_SERVICE_CANNOT_ACCEPT_CTRL) {
				return err
			}
		}
		if time.Now().After(deadline) {
			return errors.New("timed out waiting for the service to stop")
		}
		time.Sleep(200 * time.Millisecond)
		if st, err = s.Query(); err != nil {
			return err
		}
	}
	return nil
}
