//go:build linux

package platform

import (
	"context"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A fake /proc: the table, the fd links and the exe link.
func TestProcPeerWithFakeProc(t *testing.T) {
	root := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(root, "net"), 0o755))
	header := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
	must(os.WriteFile(filepath.Join(root, "net", "tcp"), []byte(header+procLine(peerClient, peerServer, tcpEstablished, 4242)+"\n"), 0o644))
	for _, p := range []struct {
		pid, fd, link string
	}{
		{"10", "3", "socket:[1]"},
		{"77", "0", "/dev/null"},
		{"77", "9", "socket:[4242]"},
	} {
		must(os.MkdirAll(filepath.Join(root, p.pid, "fd"), 0o755))
		must(os.Symlink(p.link, filepath.Join(root, p.pid, "fd", p.fd)))
	}
	must(os.MkdirAll(filepath.Join(root, "self"), 0o755))
	must(os.Symlink("/opt/google/chrome/chrome", filepath.Join(root, "77", "exe")))
	pid, exe, ok := procPeer(context.Background(), root, peerClient, peerServer)
	if !ok || pid != 77 || exe != "/opt/google/chrome/chrome" {
		t.Fatalf("procPeer = %d, %q, %v", pid, exe, ok)
	}
	if _, _, ok := procPeer(context.Background(), root, netip.MustParseAddrPort("127.0.0.1:1"), peerServer); ok {
		t.Fatal("unknown connection found")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, ok := procPeer(cancelled, root, peerClient, peerServer); ok {
		t.Fatal("a cancelled lookup must fail")
	}
	// A process without a readable exe link is not an answer.
	must(os.Remove(filepath.Join(root, "77", "exe")))
	if _, _, ok := procPeer(context.Background(), root, peerClient, peerServer); ok {
		t.Fatal("no exe: must fail")
	}
}

// End to end on the real /proc: this test process is the peer.
func TestLoopbackPeerFindsThisProcess(t *testing.T) {
	c, sc := loopbackConnPair(t)
	defer c.Close()
	defer sc.Close()
	client := sc.RemoteAddr().(*net.TCPAddr).AddrPort()
	server := sc.LocalAddr().(*net.TCPAddr).AddrPort()
	pid, img, ok := LoopbackPeer(context.Background(), client, server)
	if !ok || pid != os.Getpid() {
		t.Fatalf("LoopbackPeer = %d, %q, %v; want pid %d", pid, img, ok, os.Getpid())
	}
	self, err := os.Readlink("/proc/self/exe")
	if err != nil {
		t.Fatal(err)
	}
	if img != self || !strings.HasPrefix(img, "/") {
		t.Fatalf("image = %q, want %q", img, self)
	}
}
