//go:build !linux && !windows && !darwin

package api

import (
	"context"
	"errors"
	"net/netip"
)

// OSPeerResolver has no implementation on this OS: every lookup fails, so peer-checked
// routes refuse (fail closed).
func OSPeerResolver() PeerResolver {
	return PeerResolverFunc(func(context.Context, netip.AddrPort, netip.AddrPort) (PeerInfo, error) {
		return PeerInfo{}, errors.New("api: loopback peer lookup is not supported on this OS")
	})
}
