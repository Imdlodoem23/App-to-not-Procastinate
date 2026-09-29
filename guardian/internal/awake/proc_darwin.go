//go:build darwin

package awake

import "syscall"

// sysProcAttr puts the child in its own process group (caffeinate -w ends it when the
// guardian dies: macOS has no Pdeathsig).
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}
