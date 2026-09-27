package hosts

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
)

// flushDNS runs ipconfig /flushdns from the system directory (resolved with
// GetSystemDirectory, not PATH or environment variables).
func flushDNS(ctx context.Context, run runFunc) error {
	sys, err := windows.GetSystemDirectory()
	if err != nil {
		return fmt.Errorf("hosts: locate system directory: %w", err)
	}
	path := filepath.Join(sys, "ipconfig.exe")
	args := []string{"/flushdns"}
	if out, err := run(ctx, path, args...); err != nil {
		return cmdError(path, args, out, err)
	}
	return nil
}

// configureCmd hides the console window a service would otherwise flash.
func configureCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_NO_WINDOW,
	}
}
