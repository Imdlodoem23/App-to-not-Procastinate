package platform

import "strings"

// HostsPathRedirected reports whether the system hosts file is somewhere
// other than the OS default. On Windows the resolver reads the hosts file
// from the directory in the DataBasePath registry value (HKLM\SYSTEM\
// CurrentControlSet\Services\Tcpip\Parameters, normally
// %SystemRoot%\System32\drivers\etc), which some corporate images and hosts
// managers change; DefaultHostsPath and HostsPath follow it, re-reading the
// value on every call, and this reports when it points elsewhere so the
// engine can say so. Always false on macOS and Linux. It ignores
// CENTRATE_HOSTS_PATH.
func HostsPathRedirected() bool {
	_, redirected := systemHostsPath()
	return redirected
}

// windowsLocalDir validates a directory taken from the Windows registry,
// after environment expansion, without touching the file system (so it is
// tested on every OS). It accepts only an absolute path on a local drive
// ("C:\..."; not UNC, device or relative paths) with no "." or ".."
// elements, no alternate data stream or wildcard characters, no unexpanded
// variables and no control characters. It returns the path without trailing
// separators ("C:\" for a drive root).
func windowsLocalDir(v string) (string, bool) {
	v = strings.TrimSpace(v)
	if len(v) < 3 || !isDriveLetter(v[0]) || v[1] != ':' || (v[2] != '\\' && v[2] != '/') {
		return "", false
	}
	rest := v[2:]
	if strings.ContainsAny(rest, `:*?"<>|%`) {
		return "", false
	}
	for i := range len(rest) {
		if rest[i] < 0x20 || rest[i] == 0x7f {
			return "", false
		}
	}
	for _, part := range strings.FieldsFunc(rest, func(r rune) bool { return r == '\\' || r == '/' }) {
		if strings.Trim(part, ". ") == "" {
			return "", false // ".", "..", "...", " ." and the like
		}
	}
	v = strings.TrimRight(v, `\/`)
	if len(v) == 2 {
		v += `\`
	}
	return v, true
}

func isDriveLetter(c byte) bool {
	return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z'
}
