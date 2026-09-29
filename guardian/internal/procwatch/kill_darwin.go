package procwatch

import (
	"errors"
	"fmt"
	"time"

	"golang.org/x/sys/unix"
)

func osKillPlan(grace time.Duration) killPlan {
	return killPlan{
		goos:      "darwin",
		open:      openDarwin,
		graceful:  true,
		grace:     grace,
		forceWait: forceWait,
	}
}

// openDarwin binds the target to the process's start time (kinfo_proc
// p_starttime): once the process exits, a new process that reuses its PID has
// another start time and reads as gone, so it is never signalled after an
// identity check. Only the few microseconds between that check and kill(2)
// remain open.
func openDarwin(pid int) (procTarget, error) {
	k, err := kinfoPID(pid)
	if err != nil {
		return nil, err
	}
	if k.Proc.P_stat == sZomb {
		return nil, ErrNotFound
	}
	start := k.Proc.P_starttime
	current := func(pid int) (*unix.KinfoProc, error) {
		k, err := kinfoPID(pid)
		switch {
		case err != nil:
			return nil, err
		case k.Proc.P_starttime != start || k.Proc.P_stat == sZomb:
			return nil, ErrNotFound
		}
		return k, nil
	}
	return &pidTarget{
		pid: pid,
		read: func(pid int) (Process, error) {
			k, err := current(pid)
			if err != nil {
				return Process{}, err
			}
			return fromKinfo(k), nil
		},
		exited: func(pid int) bool {
			_, err := current(pid)
			return errors.Is(err, ErrNotFound)
		},
	}, nil
}

// kinfoPID reads one process with sysctl kern.proc.pid (no cgo, no exec). A
// missing process makes the sysctl return no data, which x/sys reports as an
// error; kill(pid, 0) then tells a missing process (ErrNotFound) from a real
// failure, which is returned as is.
func kinfoPID(pid int) (*unix.KinfoProc, error) {
	k, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		if killGone(pid) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("procwatch: sysctl kern.proc.pid: %w", err)
	}
	if int(k.Proc.P_pid) != pid {
		return nil, ErrNotFound
	}
	return k, nil
}
