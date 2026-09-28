//go:build windows

package platform

import (
	"context"
	"errors"
	"net/netip"
	"os"
	"testing"
)

func TestLookupPeerWindowsWithFakes(t *testing.T) {
	prevTable, prevImage := tcpTable, imageOf
	t.Cleanup(func() { tcpTable, imageOf = prevTable, prevImage })
	mapped := netip.AddrPortFrom(netip.AddrFrom16(peerClient.Addr().As16()), peerClient.Port())
	mappedServer := netip.AddrPortFrom(netip.AddrFrom16(peerServer.Addr().As16()), peerServer.Port())
	tcpTable = func(v6 bool) ([]byte, error) {
		if v6 {
			return tcpTableOf(tcpRow6(mibTCPStateEstab, mapped, mappedServer, 3000)), nil
		}
		return nil, errors.New("v4 table unavailable")
	}
	imageOf = func(pid uint32) (string, error) {
		if pid != 3000 {
			t.Errorf("image of %d", pid)
		}
		return `C:\Program Files\Mozilla Firefox\firefox.exe`, nil
	}
	pid, img, ok := LoopbackPeer(context.Background(), peerClient, peerServer)
	if !ok || pid != 3000 || img != `C:\Program Files\Mozilla Firefox\firefox.exe` {
		t.Fatalf("LoopbackPeer = %d, %q, %v", pid, img, ok)
	}
	imageOf = func(uint32) (string, error) { return "", errors.New("gone") }
	if _, _, ok := LoopbackPeer(context.Background(), peerClient, peerServer); ok {
		t.Fatal("an unknown image must fail")
	}
	tcpTable = func(bool) ([]byte, error) {
		return tcpTableOf(tcpRow4(mibTCPStateEstab, peerClient, peerServer, 4)), nil
	}
	if _, _, ok := LoopbackPeer(context.Background(), peerClient, peerServer); ok {
		t.Fatal("the System process is never a peer")
	}
}

// The real tables: this test process is the peer.
func TestLookupPeerWindowsReal(t *testing.T) {
	c, sc := loopbackConnPair(t)
	defer c.Close()
	defer sc.Close()
	pid, img, ok := LoopbackPeer(context.Background(), sc.RemoteAddr().(interface{ AddrPort() netip.AddrPort }).AddrPort(),
		sc.LocalAddr().(interface{ AddrPort() netip.AddrPort }).AddrPort())
	if !ok || pid != os.Getpid() {
		t.Fatalf("LoopbackPeer = %d, %q, %v", pid, img, ok)
	}
	exe, _ := os.Executable()
	a, err1 := os.Stat(img)
	b, err2 := os.Stat(exe)
	if err1 != nil || err2 != nil || !os.SameFile(a, b) {
		t.Fatalf("image %q, want %q (%v, %v)", img, exe, err1, err2)
	}
}
