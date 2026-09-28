package platform

import (
	"context"
	"encoding/binary"
	"fmt"
	"net/netip"
	"strings"
	"testing"
)

var (
	peerClient = netip.MustParseAddrPort("127.0.0.1:52345")
	peerServer = netip.MustParseAddrPort("127.0.0.1:47600")
)

// procHexAddr prints an address the way /proc/net/tcp{,6} does on this
// machine: each 32-bit word as a native-endian number.
func procHexAddr(a netip.AddrPort) string {
	b := a.Addr().AsSlice()
	var s strings.Builder
	for i := 0; i < len(b); i += 4 {
		fmt.Fprintf(&s, "%08X", binary.NativeEndian.Uint32(b[i:]))
	}
	return fmt.Sprintf("%s:%04X", s.String(), a.Port())
}

func procLine(local, remote netip.AddrPort, state string, inode uint64) string {
	return fmt.Sprintf("  0: %s %s %s 00000000:00000000 00:00000000 00000000  1000        0 %d 1 0000000000000000 20 4 30 10 -1",
		procHexAddr(local), procHexAddr(remote), state, inode)
}

func TestParseProcNetTCP(t *testing.T) {
	header := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"
	table := strings.Join([]string{
		header,
		procLine(peerServer, netip.MustParseAddrPort("0.0.0.0:0"), "0A", 111), // listener
		procLine(peerServer, peerClient, tcpEstablished, 222),                 // the guardian's end
		procLine(peerClient, peerServer, "06", 333),                           // TIME_WAIT, not it
		procLine(peerClient, peerServer, tcpEstablished, 444),                 // the client's end
	}, "\n")
	if inode, ok := parseProcNetTCP([]byte(table), peerClient, peerServer); !ok || inode != 444 {
		t.Fatalf("inode = %d, %v", inode, ok)
	}
	if _, ok := parseProcNetTCP([]byte(table), netip.MustParseAddrPort("127.0.0.1:1"), peerServer); ok {
		t.Fatal("unknown connection found")
	}
	// A dual-stack client shows up in tcp6 as ::ffff:127.0.0.1.
	mapped := netip.AddrPortFrom(netip.AddrFrom16(peerClient.Addr().As16()), peerClient.Port())
	mappedServer := netip.AddrPortFrom(netip.AddrFrom16(peerServer.Addr().As16()), peerServer.Port())
	tcp6 := header + "\n" + procLine(mapped, mappedServer, tcpEstablished, 555)
	if inode, ok := parseProcNetTCP([]byte(tcp6), peerClient, peerServer); !ok || inode != 555 {
		t.Fatalf("tcp6 inode = %d, %v", inode, ok)
	}
	for _, bad := range []string{"", header, header + "\n0: garbage", header + "\n" + strings.Replace(procLine(peerClient, peerServer, "01", 7), " 7 ", " x ", 1)} {
		if _, ok := parseProcNetTCP([]byte(bad), peerClient, peerServer); ok {
			t.Errorf("parsed %q", bad)
		}
	}
	if a, ok := parseProcAddr("0100007F:1F90"); binary.NativeEndian.Uint16([]byte{1, 0}) == 1 && (!ok || a != netip.MustParseAddrPort("127.0.0.1:8080")) {
		t.Fatalf("parseProcAddr = %v, %v", a, ok)
	}
	for _, bad := range []string{"", "0100007F", "0100007F:1F9", "zz00007F:1F90", "0100007F00:1F90", "0100007F:FFFFF"} {
		if _, ok := parseProcAddr(bad); ok {
			t.Errorf("parseProcAddr(%q) accepted", bad)
		}
	}
}

// tcpRow4 and tcpRow6 build MIB_TCPROW_OWNER_PID and MIB_TCP6ROW_OWNER_PID.
func tcpRow4(state uint32, local, remote netip.AddrPort, pid uint32) []byte {
	row := make([]byte, tcpRowSize)
	binary.LittleEndian.PutUint32(row[0:], state)
	l, r := local.Addr().As4(), remote.Addr().As4()
	copy(row[4:], l[:])
	binary.BigEndian.PutUint16(row[8:], local.Port())
	copy(row[12:], r[:])
	binary.BigEndian.PutUint16(row[16:], remote.Port())
	binary.LittleEndian.PutUint32(row[20:], pid)
	return row
}

func tcpRow6(state uint32, local, remote netip.AddrPort, pid uint32) []byte {
	row := make([]byte, tcp6RowSize)
	l, r := local.Addr().As16(), remote.Addr().As16()
	copy(row[0:], l[:])
	binary.BigEndian.PutUint16(row[20:], local.Port())
	copy(row[24:], r[:])
	binary.BigEndian.PutUint16(row[44:], remote.Port())
	binary.LittleEndian.PutUint32(row[48:], state)
	binary.LittleEndian.PutUint32(row[52:], pid)
	return row
}

func tcpTableOf(rows ...[]byte) []byte {
	buf := binary.LittleEndian.AppendUint32(nil, uint32(len(rows)))
	for _, r := range rows {
		buf = append(buf, r...)
	}
	return buf
}

func TestParseTCPTable(t *testing.T) {
	v4 := tcpTableOf(
		tcpRow4(mibTCPStateEstab, peerServer, peerClient, 900), // the guardian's end
		tcpRow4(2, peerClient, peerServer, 901),                // LISTEN-ish state, not it
		tcpRow4(mibTCPStateEstab, peerClient, peerServer, 1234),
	)
	if pid, ok := parseTCPTable(v4, false, peerClient, peerServer); !ok || pid != 1234 {
		t.Fatalf("v4 pid = %d, %v", pid, ok)
	}
	if _, ok := parseTCPTable(v4[:len(v4)-1], false, peerClient, peerServer); ok {
		t.Fatal("a cut row must not be read")
	}
	mapped := netip.AddrPortFrom(netip.AddrFrom16(peerClient.Addr().As16()), peerClient.Port())
	mappedServer := netip.AddrPortFrom(netip.AddrFrom16(peerServer.Addr().As16()), peerServer.Port())
	v6 := tcpTableOf(tcpRow6(mibTCPStateEstab, mapped, mappedServer, 4321))
	if pid, ok := parseTCPTable(v6, true, peerClient, peerServer); !ok || pid != 4321 {
		t.Fatalf("v6 pid = %d, %v", pid, ok)
	}
	for _, bad := range [][]byte{nil, {1, 0}, binary.LittleEndian.AppendUint32(nil, 1<<30)} {
		if _, ok := parseTCPTable(bad, false, peerClient, peerServer); ok {
			t.Errorf("parsed %x", bad)
		}
	}
	if _, ok := parseTCPTable(tcpTableOf(tcpRow4(mibTCPStateEstab, peerClient, peerServer, 0)), false, peerClient, peerServer); ok {
		t.Fatal("PID 0 accepted")
	}
}

func TestParseLsof(t *testing.T) {
	out := "p100\nf5\nn127.0.0.1:47600->127.0.0.1:52345\n" + // the guardian's end
		"pbad\nf3\nn127.0.0.1:52345->127.0.0.1:47600\n" + // unparseable PID: ignored
		"p2345\nf7\nn127.0.0.1:50000->127.0.0.1:47600\nf8\nn127.0.0.1:52345->127.0.0.1:47600\n"
	if pid, ok := parseLsof([]byte(out), peerClient, peerServer); !ok || pid != 2345 {
		t.Fatalf("pid = %d, %v", pid, ok)
	}
	for _, bad := range []string{"", "n127.0.0.1:52345->127.0.0.1:47600\n", "p1\nnjunk\n", "p0\nn127.0.0.1:52345->127.0.0.1:47600\n"} {
		if _, ok := parseLsof([]byte(bad), peerClient, peerServer); ok {
			t.Errorf("parsed %q", bad)
		}
	}
	// The command is fixed: absolute path, constant arguments.
	if lsofPath != "/usr/sbin/lsof" || strings.Join(lsofArgs, " ") != "-nP -iTCP@127.0.0.1 -sTCP:ESTABLISHED -Fpn" {
		t.Fatalf("lsof command = %s %v", lsofPath, lsofArgs)
	}
}

func TestExecPathFromProcargs2(t *testing.T) {
	argc := binary.NativeEndian.AppendUint32(nil, 2)
	mk := func(s string) []byte { return append(append(append([]byte{}, argc...), s...), 0, 0, 'a', 0) }
	good := "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
	if got := execPathFromProcargs2(mk(good)); got != good {
		t.Fatalf("got %q", got)
	}
	for _, bad := range [][]byte{nil, argc, mk(""), mk("relative/bin"), mk("/tmp/../Applications/x"), mk("/a//b"), append(append([]byte{}, argc...), "/no/nul"...)} {
		if got := execPathFromProcargs2(bad); got != "" {
			t.Errorf("accepted %q", got)
		}
	}
}

func TestLoopbackPeerRejectsNonLoopback(t *testing.T) {
	ctx := context.Background()
	for _, c := range [][2]netip.AddrPort{
		{netip.MustParseAddrPort("192.168.1.2:5000"), peerServer},
		{peerClient, netip.MustParseAddrPort("10.0.0.1:47600")},
		{netip.MustParseAddrPort("127.0.0.1:0"), peerServer},
		{netip.AddrPort{}, peerServer},
	} {
		if pid, img, ok := LoopbackPeer(ctx, c[0], c[1]); ok || pid != 0 || img != "" {
			t.Errorf("LoopbackPeer(%v, %v) = %d, %q, %v", c[0], c[1], pid, img, ok)
		}
	}
}
