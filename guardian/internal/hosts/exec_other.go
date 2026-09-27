//go:build !windows

package hosts

import (
	"os"
	"os/exec"
)

// configureCmd pins the C locale so error messages can be recognised.
func configureCmd(cmd *exec.Cmd) {
	cmd.Env = append(os.Environ(), "LC_ALL=C")
}
