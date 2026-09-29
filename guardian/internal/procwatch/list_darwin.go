package procwatch

import (
	"fmt"

	"golang.org/x/sys/unix"
)

// sZomb is SZOMB from <sys/proc.h>: the process exited and was not reaped.
const sZomb = 5

// List returns the running processes from sysctl kern.proc.all, without
// zombies (see kinfo.go).
func List() ([]Process, error) {
	kps, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil, fmt.Errorf("procwatch: sysctl kern.proc.all: %w", err)
	}
	procs := make([]Process, 0, len(kps))
	for i := range kps {
		if kps[i].Proc.P_stat == sZomb {
			continue
		}
		procs = append(procs, fromKinfo(&kps[i]))
	}
	return procs, nil
}

// fromKinfo builds a Process from a kinfo_proc. The exec path is only read
// for user processes: system ones are never matched.
func fromKinfo(k *unix.KinfoProc) Process {
	pid, ppid, uid := int(k.Proc.P_pid), int(k.Eproc.Ppid), k.Eproc.Ucred.Uid
	comm := cString(k.Proc.P_comm[:])
	p := darwinProcess(pid, ppid, uid, comm, "")
	if p.System || pid <= 0 {
		return p
	}
	return darwinProcess(pid, ppid, uid, comm, execPathOf(pid))
}

// execPathOf reads the exec path of pid from sysctl kern.procargs2, or "" when
// it cannot be read (the process exited, or belongs to another user and the
// caller is not root).
func execPathOf(pid int) string {
	b, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil {
		return ""
	}
	return execPathFromProcargs2(b)
}
