//go:build !windows

package platform

// systemHostsPath returns the hosts file path and whether it differs from the
// OS default; outside Windows it never does.
func systemHostsPath() (string, bool) {
	return defaultHostsPath(), false
}
