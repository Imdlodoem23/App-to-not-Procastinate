//go:build windows

package engine

// OWNER: settings teammate (docs/ARCHITECTURE.md §4).

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

// windowsOSZone reads the registry TimeZoneKeyName (the Windows zone the OS uses) and maps
// it to IANA with the CLDR windowsZones table; "" when it cannot be told.
func windowsOSZone() string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\TimeZoneInformation`, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	name, _, err := k.GetStringValue("TimeZoneKeyName")
	if err != nil {
		return ""
	}
	// Some Windows builds store trailing NULs or spaces after the name.
	return windowsZoneIANA(strings.TrimSpace(strings.TrimRight(name, "\x00")))
}
