package daemon

import (
	"bytes"
	"strings"
)

// systemdStopping reports whether `systemctl is-system-running` output says the system
// is shutting down or rebooting.
func systemdStopping(out []byte) bool {
	line, _, _ := bytes.Cut(out, []byte("\n"))
	return strings.TrimSpace(string(line)) == "stopping"
}
