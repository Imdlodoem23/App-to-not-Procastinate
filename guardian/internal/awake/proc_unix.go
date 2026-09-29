//go:build linux || darwin

package awake

import (
	"errors"
	"os/exec"
	"syscall"
)

// osProcess is a real child in its own process group.
type osProcess struct {
	cmd *exec.Cmd
}

// startProcess starts argv (argv[0] an absolute path) with a fixed environment, no
// standard streams (they go to the null device) and in its own process group, so
// releasing it also ends what it runs (systemd-inhibit's `sleep`).
func startProcess(argv []string) (process, error) {
	if len(argv) == 0 {
		return nil, errors.New("awake: empty argument vector")
	}
	cmd := &exec.Cmd{
		Path:        argv[0],
		Args:        argv,
		Env:         childEnv,
		SysProcAttr: sysProcAttr(),
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &osProcess{cmd: cmd}, nil
}

// Wait implements process. Once the child is reaped, what is left of its group (an
// orphaned `sleep infinity` after systemd-inhibit died) is killed too: a group ID is not
// reused while any member lives.
func (p *osProcess) Wait() error {
	err := p.cmd.Wait()
	_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
	return err
}

// Signal implements process.
func (p *osProcess) Signal(kill bool) error {
	sig := syscall.SIGTERM
	if kill {
		sig = syscall.SIGKILL
	}
	if err := syscall.Kill(-p.cmd.Process.Pid, sig); err == nil {
		return nil
	}
	return p.cmd.Process.Signal(sig)
}
