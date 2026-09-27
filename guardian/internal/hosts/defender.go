package hosts

import (
	"runtime"
	"strings"
)

// defenderSensitive lists the Microsoft domains whose hosts entries Microsoft
// Defender may report as SettingsModifier:Win32/HostsFileHijack. Its
// remediation rewrites the hosts file, the watcher re-applies, and the loop
// raises an alert every few seconds. The detection is confirmed for telemetry
// and update hosts (under microsoft.com, windows.com, windowsupdate.com) and
// the rest are Microsoft-owned services at risk of the same rule. Each entry
// covers itself and every subdomain. Keep it sorted.
var defenderSensitive = [...]string{
	"bing.com",
	"linkedin.com",
	"live.com",
	"microsoft.com",
	"msn.com",
	"office.com",
	"skype.com",
	"windows.com",
	"windowsupdate.com",
	"xbox.com",
}

// DefenderSensitiveDomains returns the domains (each with all its
// subdomains) that the hosts layer leaves out on Windows; see
// HostsLayerDomains. The slice is a copy, sorted.
func DefenderSensitiveDomains() []string {
	return append([]string(nil), defenderSensitive[:]...)
}

// DefenderSensitive reports whether domain is one of DefenderSensitiveDomains
// or a subdomain of one. The comparison ignores ASCII case; an invalid domain
// is never sensitive.
func DefenderSensitive(domain string) bool {
	d, reason := checkDomain(domain)
	if reason != "" {
		return false
	}
	for _, s := range defenderSensitive {
		if d == s || strings.HasSuffix(d, "."+s) {
			return true
		}
	}
	return false
}

// HostsLayerDomains returns the domains the hosts layer should block on this
// system, in their original order: on Windows it leaves out the
// DefenderSensitive ones (the browser extension still blocks them), and
// elsewhere it returns every domain. skipped counts the domains left out, for
// logging (never log the domains themselves). Invalid domains are kept, so
// Apply still reports them. The engine passes the result to both Apply and
// Verify, never the unfiltered list.
func HostsLayerDomains(domains []string) (kept []string, skipped int) {
	return hostsLayerDomains(runtime.GOOS, domains)
}

func hostsLayerDomains(goos string, domains []string) ([]string, int) {
	kept := make([]string, 0, len(domains))
	for _, d := range domains {
		if goos == "windows" && DefenderSensitive(d) {
			continue
		}
		kept = append(kept, d)
	}
	return kept, len(domains) - len(kept)
}
