package procwatch

import (
	"errors"
	"fmt"
	"math"
	"time"

	"golang.org/x/sys/windows"
)

// terminateExitCode is the exit code given to terminated processes.
const terminateExitCode = 1

// osKillPlan has no graceful step: a service in session 0 cannot post
// WM_CLOSE to the user's windows. grace is how long Kill waits for the process
// to be gone after TerminateProcess.
func osKillPlan(grace time.Duration) killPlan {
	return killPlan{
		goos:      "windows",
		open:      openWindows,
		graceful:  false,
		forceWait: grace,
	}
}

// openWindows opens a handle that keeps referring to this process object even
// after it exits, so a reused PID can never be hit.
func openWindows(pid int) (procTarget, error) {
	const access = windows.PROCESS_TERMINATE | windows.PROCESS_QUERY_LIMITED_INFORMATION | windows.SYNCHRONIZE
	if pid <= 0 || int64(pid) > math.MaxUint32 {
		return nil, ErrInvalid
	}
	h, err := windows.OpenProcess(access, false, uint32(pid))
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("procwatch: open process: %w", err)
	}
	return &winTarget{h: h, pid: pid}, nil
}

type winTarget struct {
	h   windows.Handle
	pid int
}

// identity reads the process through the handle. While the handle is open
// the PID cannot be reused, so the by-PID queries below (session, name
// fallback) still refer to this process.
func (t *winTarget) identity() (Process, error) {
	if t.wait(0) {
		return Process{}, ErrNotFound
	}
	p := Process{PID: t.pid}
	if path, err := imagePath(t.h); err == nil && path != "" {
		p.Name, p.Path = baseName(path), path
	} else {
		// No image path (rare): fall back to the process table.
		name, err := processName(t.pid)
		if err != nil {
			return Process{}, err
		}
		p.Name = name
	}
	system, err := t.system()
	if err != nil {
		if t.wait(0) {
			return Process{}, ErrNotFound
		}
		// The owner is unknown: refuse rather than guess.
		return Process{}, err
	}
	p.System = system
	return p, nil
}

// system reports whether the process runs in session 0 or as LocalSystem,
// LocalService or NetworkService (a service's helper started in the user's
// session, the UAC prompt…).
func (t *winTarget) system() (bool, error) {
	var session uint32
	if err := windows.ProcessIdToSessionId(uint32(t.pid), &session); err != nil {
		return false, fmt.Errorf("procwatch: process session: %w", err)
	}
	if session == 0 {
		return true, nil
	}
	var tok windows.Token
	if err := windows.OpenProcessToken(t.h, windows.TOKEN_QUERY, &tok); err != nil {
		return false, fmt.Errorf("procwatch: process token: %w", err)
	}
	defer tok.Close()
	u, err := tok.GetTokenUser()
	if err != nil {
		return false, fmt.Errorf("procwatch: process token user: %w", err)
	}
	for _, sid := range [...]windows.WELL_KNOWN_SID_TYPE{windows.WinLocalSystemSid, windows.WinLocalServiceSid, windows.WinNetworkServiceSid} {
		if u.User.Sid.IsWellKnown(sid) {
			return true, nil
		}
	}
	return false, nil
}

func (t *winTarget) signal(bool) error {
	if err := windows.TerminateProcess(t.h, terminateExitCode); err != nil {
		if t.wait(0) {
			return ErrNotFound
		}
		return fmt.Errorf("procwatch: terminate process: %w", err)
	}
	return nil
}

func (t *winTarget) wait(d time.Duration) bool {
	ms := int64(0)
	if d > 0 {
		ms = int64((d + time.Millisecond - 1) / time.Millisecond)
	}
	ev, err := windows.WaitForSingleObject(t.h, uint32(min(ms, int64(windows.INFINITE-1))))
	return err == nil && ev == windows.WAIT_OBJECT_0
}

func (t *winTarget) close() { _ = windows.CloseHandle(t.h) }
