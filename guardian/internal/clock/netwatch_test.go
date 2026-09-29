package clock

import (
	"context"
	"errors"
	"net/netip"
	"sync"
	"testing"
	"time"
)

func addrs(s ...string) []netip.Addr {
	out := make([]netip.Addr, 0, len(s))
	for _, a := range s {
		out = append(out, netip.MustParseAddr(a))
	}
	return out
}

func TestNetworkWatcherReportsAppearingAddresses(t *testing.T) {
	type step struct {
		addrs []netip.Addr
		err   error
		up    bool
	}
	steps := []step{
		// baseline (not reported): offline apart from loopback and link-local
		{addrs: addrs("127.0.0.1", "::1", "fe80::1", "169.254.3.4")},
		{addrs: addrs("127.0.0.1"), up: false},
		{addrs: addrs("192.168.1.20", "fe80::1"), up: true}, // network up
		{addrs: addrs("192.168.1.20"), up: false},           // unchanged
		{err: errors.New("transient"), up: false},           // errors keep the state
		{addrs: addrs("192.168.1.20", "2001:db8::5"), up: true},
		{addrs: addrs("2001:db8::5"), up: false},                       // losing one is not "up"
		{addrs: addrs("::ffff:192.168.1.20", "2001:db8::5"), up: true}, // mapped form of a returning v4
		{addrs: nil, up: false},                                        // offline
		{addrs: addrs("10.0.0.2"), up: true},                           // a new network
	}
	var mu sync.Mutex
	i := 0
	polled := make(chan int, len(steps))
	list := func() ([]netip.Addr, error) {
		mu.Lock()
		defer mu.Unlock()
		if i >= len(steps) {
			return nil, errors.New("script over")
		}
		s := steps[i]
		polled <- i
		i++
		return s.addrs, s.err
	}
	ticks := make(chan time.Time)
	ups := make(chan int, len(steps))
	w := &NetworkWatcher{Addrs: list, newTicker: func(d time.Duration) (<-chan time.Time, func()) {
		if d != DefaultNetworkPoll {
			t.Errorf("interval %v", d)
		}
		return ticks, func() {}
	}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- w.Run(ctx, func() {
			mu.Lock()
			ups <- i - 1
			mu.Unlock()
		})
	}()
	<-polled // baseline
	for range steps[1:] {
		ticks <- time.Now()
		<-polled
	}
	ticks <- time.Now() // the last update has finished once this send is taken…
	cancel()            // …by the select, which may pick either case
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Run = %v", err)
	}
	close(ups)
	got := map[int]bool{}
	for n := range ups {
		got[n] = true
	}
	for n, s := range steps {
		if got[n] != s.up {
			t.Errorf("step %d: up = %v, want %v", n, got[n], s.up)
		}
	}
}

func TestUsableAddrs(t *testing.T) {
	got := usableAddrs(addrs("10.0.0.2", "::", "0.0.0.0", "224.0.0.1", "ff02::1", "fe80::1%eth0", "10.0.0.2", "::ffff:10.0.0.2", "2001:db8::1"))
	want := addrs("10.0.0.2", "2001:db8::1")
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestSystemAddrs(t *testing.T) {
	a, err := SystemAddrs()
	if err != nil {
		t.Skipf("no interfaces here: %v", err)
	}
	for _, x := range a {
		if !x.IsValid() {
			t.Fatalf("invalid address in %v", a)
		}
	}
}
