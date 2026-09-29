//go:build !linux && !darwin && !windows

package platform

import (
	"context"
	"net/netip"
)

// lookupPeer has no implementation on this OS: every lookup fails, so
// peer-checked requests are refused (fail closed).
func lookupPeer(context.Context, netip.AddrPort, netip.AddrPort) (int, string, bool) {
	return 0, "", false
}
