//go:build linux

package api

import (
	"context"
	"net"
	"net/netip"
	"os"
	"testing"
	"time"
)

// TestLinuxPeerResolvesOwnProcess connects to a loopback listener and resolves the
// client end, which belongs to this test process.
func TestLinuxPeerResolvesOwnProcess(t *testing.T) {
	if _, err := os.Stat("/proc/net/tcp"); err != nil {
		t.Skip("no /proc/net/tcp")
	}
	var lc net.ListenConfig
	ln, err := lc.Listen(context.Background(), "tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			accepted <- c
		}
	}()
	var d net.Dialer
	conn, err := d.Dial("tcp4", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	srvConn := <-accepted
	defer func() { _ = srvConn.Close() }()

	client := netip.MustParseAddrPort(srvConn.RemoteAddr().String())
	server := netip.MustParseAddrPort(srvConn.LocalAddr().String())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	info, err := OSPeerResolver().Resolve(ctx, client, server)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if info.PID != os.Getpid() {
		t.Fatalf("pid %d, want %d (%+v)", info.PID, os.Getpid(), info)
	}
	exe, _ := os.Executable()
	if info.Name == "" || (info.Path != "" && info.Path != exe) {
		t.Fatalf("info %+v, executable %s", info, exe)
	}
	// An unknown connection is not found.
	other := netip.AddrPortFrom(client.Addr(), 1)
	if _, err := OSPeerResolver().Resolve(ctx, other, server); err == nil {
		t.Fatal("resolved a connection that does not exist")
	}
}
