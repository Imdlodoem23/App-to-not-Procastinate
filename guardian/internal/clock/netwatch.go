package clock

import (
	"context"
	"net"
	"net/netip"
	"slices"
	"time"
)

// DefaultNetworkPoll is how often a NetworkWatcher looks at the interfaces.
const DefaultNetworkPoll = 5 * time.Second

// NetworkWatcher notices when the machine gets a network (docs/ARCHITECTURE.md
// §10.2: a failed calibration is retried at once on every network-up
// notification while the clock is unverified). It polls the interface
// addresses, which works the same on every OS and needs no privileges or
// subscriptions, and calls onUp when a usable address appears that the
// previous poll did not have: the first network after boot or resume, a new
// Wi-Fi, a VPN coming up. Losing addresses never calls it.
//
// Usable addresses are unicast addresses of interfaces that are up and not
// loopback, excluding loopback, link-local and unspecified addresses.
type NetworkWatcher struct {
	// Interval between polls; zero or negative selects DefaultNetworkPoll.
	Interval time.Duration
	// Addrs lists the usable addresses; nil selects SystemAddrs.
	Addrs func() ([]netip.Addr, error)

	newTicker func(time.Duration) (<-chan time.Time, func())
}

// Run polls until ctx is done and returns ctx.Err(). The first poll only
// records the baseline (the engine calibrates at start anyway). onUp runs on
// the polling goroutine and must not block: the engine posts a command to its
// own loop.
func (w *NetworkWatcher) Run(ctx context.Context, onUp func()) error {
	interval := w.Interval
	if interval <= 0 {
		interval = DefaultNetworkPoll
	}
	list := w.Addrs
	if list == nil {
		list = SystemAddrs
	}
	newTicker := w.newTicker
	if newTicker == nil {
		newTicker = func(d time.Duration) (<-chan time.Time, func()) {
			t := time.NewTicker(d)
			return t.C, t.Stop
		}
	}
	ticks, stop := newTicker(interval)
	defer stop()
	var st netState
	st.update(list)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticks:
			if st.update(list) && onUp != nil {
				onUp()
			}
		}
	}
}

// netState is the set of usable addresses seen by the previous poll.
type netState struct {
	addrs []netip.Addr
	known bool
}

// update polls once and reports whether an address appeared. An error keeps
// the previous state (a transient failure is not a network change).
func (s *netState) update(list func() ([]netip.Addr, error)) bool {
	addrs, err := list()
	if err != nil {
		return false
	}
	addrs = usableAddrs(addrs)
	appeared := false
	if s.known {
		for _, a := range addrs {
			if _, found := slices.BinarySearchFunc(s.addrs, a, netip.Addr.Compare); !found {
				appeared = true
				break
			}
		}
	}
	s.addrs, s.known = addrs, true
	return appeared
}

// usableAddrs returns the sorted, deduplicated unicast addresses of addrs,
// without loopback, link-local, multicast and unspecified ones.
func usableAddrs(addrs []netip.Addr) []netip.Addr {
	out := make([]netip.Addr, 0, len(addrs))
	for _, a := range addrs {
		a = a.Unmap().WithZone("")
		if !a.IsValid() || a.IsUnspecified() || a.IsLoopback() || a.IsMulticast() ||
			a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() || a.IsInterfaceLocalMulticast() {
			continue
		}
		out = append(out, a)
	}
	slices.SortFunc(out, netip.Addr.Compare)
	return slices.Compact(out)
}

// SystemAddrs returns the addresses of the interfaces that are up and not
// loopback.
func SystemAddrs() ([]netip.Addr, error) {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	var out []netip.Addr
	for _, ifc := range ifs {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if addr, ok := netip.AddrFromSlice(ip); ok {
				out = append(out, addr)
			}
		}
	}
	return out, nil
}
