//go:build linux

package awake

import "syscall"

// sysProcAttr puts the child in its own process group and has the kernel send it
// SIGTERM when the guardian dies (the unit's KillMode=mixed ends the rest at stop).
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGTERM}
}
