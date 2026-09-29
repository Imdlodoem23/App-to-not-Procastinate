package svc

import (
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"time"

	"github.com/kardianos/service"
	"golang.org/x/sys/windows"
	winsvc "golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	// recoveryResetPeriod: the failure count resets after a day without failures.
	recoveryResetPeriod = 24 * 60 * 60 // seconds

	// stopTimeout bounds the wait for the SCM to report STOPPED.
	stopTimeout = 30 * time.Second
	// exitWait is the least time given to the process to exit after STOPPED.
	exitWait = 10 * time.Second
	// terminateWait bounds the wait after TerminateProcess.
	terminateWait = 5 * time.Second
	// startTimeout bounds the wait for RUNNING after StartService.
	startTimeout = 30 * time.Second
	// deleteWait bounds the wait for a registration marked for deletion to go.
	deleteWait = 10 * time.Second
	// pollInterval is how often the service state is queried.
	pollInterval = 200 * time.Millisecond
)

// recoveryDelays: restart 5 s, 10 s and 30 s after the first, second and
// third failure. The SCM repeats the last action for every later failure, so
// the guardian keeps being restarted every 30 s.
var recoveryDelays = []time.Duration{5 * time.Second, 10 * time.Second, 30 * time.Second}

func serviceID() string { return Name }

// registeredExecutable registers the binary where it is; install refuses it
// unless only administrators can replace it (checkTrustedExecutable).
func registeredExecutable(src string) string { return src }

func platformOptions() service.KeyValue {
	return service.KeyValue{
		"StartType":              "automatic",
		"DelayedAutoStart":       false,
		"OnFailure":              "restart",
		"OnFailureDelayDuration": recoveryDelays[0].String(),
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
	if err := checkTrustedExecutable(m.cfg.Executable); err != nil {
		return err
	}
	err := m.register()
	if errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
		// An uninstall left the old registration behind (the Services console
		// or another handle keeps it open): it goes away when they close.
		m.logger.Info("previous registration still marked for deletion; waiting")
		if waitDeleted(deleteWait) {
			err = m.register()
		}
		if errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
			return fmt.Errorf("%w: %w", ErrMarkedForDeletion, err)
		}
	}
	if err != nil {
		return err
	}
	return withService(func(s *mgr.Service) error {
		if err := stopAndWait(s, m.logger); err != nil {
			return err
		}
		if err := startService(s); err != nil {
			return err
		}
		return waitRunning(s, startTimeout)
	})
}

// register creates the service or updates an existing registration in place.
// Both paths fail with ERROR_SERVICE_MARKED_FOR_DELETE while an old
// registration is pending deletion.
func (m *Manager) register() error {
	err := withService(func(*mgr.Service) error { return nil })
	switch {
	case errors.Is(err, ErrNotInstalled):
		if err := m.svc.Install(); err != nil {
			return err
		}
	case err != nil:
		return err
	}
	if err := withService(func(s *mgr.Service) error { return configure(s, m.cfg.Executable) }); err != nil {
		return fmt.Errorf("configure service: %w", err)
	}
	return nil
}

// waitDeleted polls until the service no longer exists, up to d.
func waitDeleted(d time.Duration) bool {
	deadline := time.Now().Add(d)
	for {
		if st, err := queryStatus(Name); err == nil && !st.Installed {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(pollInterval)
	}
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
	actions := make([]mgr.RecoveryAction, len(recoveryDelays))
	for i, d := range recoveryDelays {
		actions[i] = mgr.RecoveryAction{Type: mgr.ServiceRestart, Delay: d}
	}
	if err := s.SetRecoveryActions(actions, recoveryResetPeriod); err != nil {
		return err
	}
	// Also recover when the process exits with an error instead of crashing
	// (a failed start). An explicit stop always exits 0 (program.Stop).
	return s.SetRecoveryActionsOnNonCrashFailures(true)
}

func (m *Manager) uninstall() error {
	err := withService(func(s *mgr.Service) error {
		stopErr := stopAndWait(s, m.logger)
		// Delete even when stopping failed: the SCM never starts (or
		// recovers) a service marked for deletion and removes it as soon as
		// it stops.
		if err := s.Delete(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
			return errors.Join(stopErr, err)
		}
		return stopErr
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
	return queryStatus(Name)
}

// queryStatus asks the SCM for the state of service name with the smallest
// rights (SC_MANAGER_CONNECT, SERVICE_QUERY_STATUS), which every
// authenticated user holds on a default service DACL, so it works from the
// desktop app without elevation. kardianos' Status also asks for
// SERVICE_START and SERVICE_STOP and fails with "access denied" there.
func queryStatus(name string) (Status, error) {
	scm, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return Status{}, err
	}
	defer windows.CloseServiceHandle(scm)
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return Status{}, err
	}
	h, err := windows.OpenService(scm, namePtr, windows.SERVICE_QUERY_STATUS)
	if err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return Status{}, nil
		}
		return Status{}, err
	}
	defer windows.CloseServiceHandle(h)
	var st windows.SERVICE_STATUS
	if err := windows.QueryServiceStatus(h, &st); err != nil {
		return Status{}, err
	}
	running := st.CurrentState == windows.SERVICE_RUNNING || st.CurrentState == windows.SERVICE_START_PENDING
	return Status{Installed: true, Running: running}, nil
}

func (m *Manager) start() error {
	return withService(startService)
}

func (m *Manager) stop() error {
	return withService(func(s *mgr.Service) error { return stopAndWait(s, m.logger) })
}

func (m *Manager) restart() error {
	return withService(func(s *mgr.Service) error {
		if err := stopAndWait(s, m.logger); err != nil {
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

// waitRunning polls until the service reports RUNNING, up to d. A service
// that stops instead (the Runner failed to start) is an error that carries its
// exit codes.
func waitRunning(s *mgr.Service, d time.Duration) error {
	deadline := time.Now().Add(d)
	for {
		st, err := s.Query()
		if err != nil {
			return err
		}
		switch st.State {
		case winsvc.Running:
			return nil
		case winsvc.Stopped:
			return fmt.Errorf("the service stopped right after starting (exit code %d, service exit code %d); see guardian.log",
				st.Win32ExitCode, st.ServiceSpecificExitCode)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the service did not reach the running state within %s", d)
		}
		time.Sleep(pollInterval)
	}
}

// stopAndWait asks the service to stop and waits until its process has
// exited. The SCM reports STOPPED as soon as kardianos returns from Execute,
// while the process still writes its last log lines and holds guardian.log
// and its binary open; an update replacing the binary or an uninstall deleting
// the data folder must wait for the exit. A process that does not stop within
// stopTimeout (or exit within exitWait of STOPPED) is terminated.
func stopAndWait(s *mgr.Service, logger *slog.Logger) error {
	st, err := s.Query()
	if err != nil {
		return err
	}
	if st.State == winsvc.Stopped {
		return nil
	}
	// Open the process before asking it to stop, so the handle keeps its PID
	// from being reused.
	proc := openServiceProcess(st.ProcessId, serviceImage(s))
	if proc != nil {
		defer proc.close()
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
			if proc == nil {
				return errors.New("timed out waiting for the service to stop")
			}
			logger.Warn("the service did not stop in time; terminating its process")
			return proc.kill()
		}
		time.Sleep(pollInterval)
		if st, err = s.Query(); err != nil {
			return err
		}
	}
	if proc == nil || proc.wait(max(time.Until(deadline), exitWait)) {
		return nil
	}
	logger.Warn("the service process is still running after the service stopped; terminating it")
	return proc.kill()
}

// serviceImage returns the binary the service is registered with, or "".
func serviceImage(s *mgr.Service) string {
	c, err := s.Config()
	if err != nil {
		return ""
	}
	args, err := windows.DecomposeCommandLine(c.BinaryPathName)
	if err != nil || len(args) == 0 {
		return ""
	}
	return args[0]
}

// serviceProcess is a handle on the service's process.
type serviceProcess struct {
	h            windows.Handle
	canTerminate bool
}

// openServiceProcess opens process pid if it still runs image (compared by
// file name, in case the PID was reused). It returns nil when it cannot. An
// elevated administrator needs SeDebugPrivilege to terminate a LocalSystem
// process; without it the handle can only be waited on.
func openServiceProcess(pid uint32, image string) *serviceProcess {
	if pid == 0 || image == "" {
		return nil
	}
	const query = windows.SYNCHRONIZE | windows.PROCESS_QUERY_LIMITED_INFORMATION
	h, err := windows.OpenProcess(query|windows.PROCESS_TERMINATE, false, pid)
	if err != nil && enablePrivilege("SeDebugPrivilege") == nil {
		h, err = windows.OpenProcess(query|windows.PROCESS_TERMINATE, false, pid)
	}
	canTerminate := err == nil
	if err != nil {
		if h, err = windows.OpenProcess(query, false, pid); err != nil {
			return nil
		}
	}
	if !sameImage(h, image) {
		_ = windows.CloseHandle(h)
		return nil
	}
	return &serviceProcess{h: h, canTerminate: canTerminate}
}

func sameImage(h windows.Handle, image string) bool {
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &n); err != nil {
		return false
	}
	return strings.EqualFold(filepath.Base(windows.UTF16ToString(buf[:n])), filepath.Base(image))
}

// wait reports whether the process exited within d.
func (p *serviceProcess) wait(d time.Duration) bool {
	ev, err := windows.WaitForSingleObject(p.h, uint32(d/time.Millisecond))
	return err == nil && ev == windows.WAIT_OBJECT_0
}

// kill terminates the process and waits for it to exit.
func (p *serviceProcess) kill() error {
	if !p.canTerminate {
		return errors.New("the service process is still running and cannot be terminated")
	}
	if err := windows.TerminateProcess(p.h, 1); err != nil {
		return fmt.Errorf("terminate the service process: %w", err)
	}
	if !p.wait(terminateWait) {
		return errors.New("the service process did not exit after being terminated")
	}
	return nil
}

func (p *serviceProcess) close() {
	_ = windows.CloseHandle(p.h)
}

// enablePrivilege enables a privilege the process token holds (best effort:
// it succeeds without effect when the token lacks it).
func enablePrivilege(name string) error {
	var tok windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &tok); err != nil {
		return err
	}
	defer tok.Close()
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	var luid windows.LUID
	if err := windows.LookupPrivilegeValue(nil, namePtr, &luid); err != nil {
		return err
	}
	tp := windows.Tokenprivileges{
		PrivilegeCount: 1,
		Privileges:     [1]windows.LUIDAndAttributes{{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}},
	}
	return windows.AdjustTokenPrivileges(tok, false, &tp, 0, nil, nil)
}
