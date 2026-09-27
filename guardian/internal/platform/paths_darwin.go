package platform

// caseInsensitivePaths: APFS and HFS+ volumes are case-insensitive by default.
const caseInsensitivePaths = true

func defaultDataDir() string {
	return "/Library/Application Support/Centrate"
}

func defaultHostsPath() string {
	return "/etc/hosts"
}
