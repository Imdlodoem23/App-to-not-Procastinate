package procwatch

import (
	"os"
	"sync"
)

// sysProc is the real procfs. UID_MIN is read from /etc/login.defs once.
var sysProc = procFS{
	root:     "/proc",
	readlink: os.Readlink,
	uidMin:   sync.OnceValue(func() int { return readUIDMin("/etc/login.defs") }),
}

// List returns the running processes, read from /proc.
func List() ([]Process, error) { return sysProc.list() }
