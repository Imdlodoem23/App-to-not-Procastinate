//go:build unix && !darwin

package platform

const caseInsensitivePaths = false

func defaultDataDir() string {
	return "/var/lib/centrate"
}

func defaultHostsPath() string {
	return "/etc/hosts"
}
