package platform

import (
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	// tcpipParametersKey holds DataBasePath, the directory the resolver reads
	// the hosts file from.
	tcpipParametersKey = `SYSTEM\CurrentControlSet\Services\Tcpip\Parameters`
	dataBasePathValue  = "DataBasePath"
)

// redirectLogged remembers the last redirected path logged, so the warning
// is written once per value rather than on every call.
var redirectLogged struct {
	sync.Mutex
	path string
}

// systemHostsPath returns <DataBasePath>\hosts when the registry value holds
// an absolute local path (see windowsLocalDir), and the System32 path
// otherwise; redirected reports that the two differ. A redirection is logged
// once (to slog.Default) for each new path.
func systemHostsPath() (path string, redirected bool) {
	fallback := system32HostsPath()
	dir, ok := dataBasePath()
	if !ok {
		return fallback, false
	}
	p := filepath.Join(dir, "hosts")
	if samePath(p, fallback) {
		return fallback, false
	}
	redirectLogged.Lock()
	if redirectLogged.path != p {
		redirectLogged.path = p
		slog.Default().Warn("platform: DataBasePath moves the hosts file away from the default", "path", p, "default", fallback)
	}
	redirectLogged.Unlock()
	return p, true
}

// dataBasePath reads and expands the DataBasePath registry value.
func dataBasePath() (string, bool) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, tcpipParametersKey, registry.QUERY_VALUE)
	if err != nil {
		return "", false
	}
	defer func() { _ = k.Close() }()
	v, typ, err := k.GetStringValue(dataBasePathValue)
	if err != nil {
		return "", false
	}
	if typ == registry.EXPAND_SZ {
		if v, err = registry.ExpandString(v); err != nil {
			return "", false
		}
	}
	dir, ok := windowsLocalDir(v)
	if !ok {
		return "", false
	}
	return filepath.Clean(dir), true
}

// system32HostsPath is the stock location, %SystemRoot%\System32\drivers\etc\hosts.
func system32HostsPath() string {
	sys, err := windows.GetSystemDirectory()
	if err != nil || sys == "" {
		root := os.Getenv("SystemRoot")
		if root == "" {
			root = `C:\Windows`
		}
		sys = filepath.Join(root, "System32")
	}
	return filepath.Join(sys, "drivers", "etc", "hosts")
}
