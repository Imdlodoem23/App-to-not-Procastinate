package api

import (
	"encoding/binary"
	"fmt"
	"net/netip"
	"testing"
)

var (
	testClient = netip.MustParseAddrPort("127.0.0.1:54321")
	testServer = netip.MustParseAddrPort("127.0.0.1:47600")
)

// procHex prints an address like the kernel: each 32-bit word native-endian, %08X.
func procHex(a netip.AddrPort) string {
	b := a.Addr().AsSlice()
	out := ""
	for i := 0; i < len(b); i += 4 {
		out += fmt.Sprintf("%08X", binary.NativeEndian.Uint32(b[i:]))
	}
	return fmt.Sprintf("%s:%04X", out, a.Port())
}

func TestParseProcNetTCP(t *testing.T) {
	header := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
	line := func(sl int, local, remote netip.AddrPort, inode int) string {
		return fmt.Sprintf("   %d: %s %s 01 00000000:00000000 00:00000000 00000000  1000        0 %d 1 0000000000000000 20 4 30 10 -1\n",
			sl, procHex(local), procHex(remote), inode)
	}
	if got := procHex(testServer); binary.NativeEndian.Uint16([]byte{1, 0}) == 1 && got != "0100007F:B9F0" {
		t.Fatalf("little-endian rendering %q", got)
	}
	table := header +
		line(0, testServer, netip.MustParseAddrPort("0.0.0.0:0"), 111) + // the listener
		line(1, testServer, testClient, 222) + // our accepted end
		line(2, testClient, testServer, 333) // the peer's end
	if inode, ok := parseProcNetTCP([]byte(table), testClient, testServer); !ok || inode != 333 {
		t.Fatalf("tcp: %d %v", inode, ok)
	}
	if _, ok := parseProcNetTCP([]byte(table), netip.MustParseAddrPort("127.0.0.1:1"), testServer); ok {
		t.Fatal("matched another connection")
	}
	// tcp6 with an IPv4-mapped client socket.
	mapped := func(a netip.AddrPort) netip.AddrPort {
		return netip.AddrPortFrom(netip.AddrFrom16(a.Addr().As16()), a.Port())
	}
	table6 := header + line(0, mapped(testClient), mapped(testServer), 444)
	if inode, ok := parseProcNetTCP([]byte(table6), testClient, testServer); !ok || inode != 444 {
		t.Fatalf("tcp6: %d %v", inode, ok)
	}
	if _, ok := parseProcNetTCP([]byte(header+"garbage line\n  3: zz:zz yy:yy\n"), testClient, testServer); ok {
		t.Fatal("garbage matched")
	}
}

func TestParseTCPOwnerPIDTable(t *testing.T) {
	row := func(local, remote netip.AddrPort, pid uint32) []byte {
		b := make([]byte, tcpOwnerPIDRowSize)
		binary.LittleEndian.PutUint32(b[0:], 5) // MIB_TCP_STATE_ESTAB
		l4, r4 := local.Addr().As4(), remote.Addr().As4()
		copy(b[4:8], l4[:])
		binary.BigEndian.PutUint16(b[8:10], local.Port())
		copy(b[12:16], r4[:])
		binary.BigEndian.PutUint16(b[16:18], remote.Port())
		binary.LittleEndian.PutUint32(b[20:], pid)
		return b
	}
	buf := binary.LittleEndian.AppendUint32(nil, 2)
	buf = append(buf, row(testServer, testClient, 4)...)
	buf = append(buf, row(testClient, testServer, 7777)...)
	if pid, ok := parseTCPOwnerPIDTable(buf, testClient, testServer); !ok || pid != 7777 {
		t.Fatalf("pid %d %v", pid, ok)
	}
	if _, ok := parseTCPOwnerPIDTable(buf[:30], testClient, testServer); ok {
		t.Fatal("truncated table matched")
	}
	if _, ok := parseTCPOwnerPIDTable(nil, testClient, testServer); ok {
		t.Fatal("empty table matched")
	}
}

func TestParseTCP6OwnerPIDTable(t *testing.T) {
	row := func(local, remote netip.AddrPort, pid uint32) []byte {
		b := make([]byte, tcp6OwnerPIDRowSize)
		l16, r16 := local.Addr().As16(), remote.Addr().As16()
		copy(b[0:16], l16[:])
		binary.BigEndian.PutUint16(b[20:22], local.Port())
		copy(b[24:40], r16[:])
		binary.BigEndian.PutUint16(b[44:46], remote.Port())
		binary.LittleEndian.PutUint32(b[48:], 5)
		binary.LittleEndian.PutUint32(b[52:], pid)
		return b
	}
	mapped := func(a netip.AddrPort) netip.AddrPort {
		return netip.AddrPortFrom(netip.AddrFrom16(a.Addr().As16()), a.Port())
	}
	buf := binary.LittleEndian.AppendUint32(nil, 2)
	buf = append(buf, row(mapped(testServer), mapped(testClient), 4)...)
	buf = append(buf, row(mapped(testClient), mapped(testServer), 8888)...)
	if pid, ok := parseTCP6OwnerPIDTable(buf, testClient, testServer); !ok || pid != 8888 {
		t.Fatalf("pid %d %v", pid, ok)
	}
	if _, ok := parseTCP6OwnerPIDTable(buf[:60], testClient, testServer); ok {
		t.Fatal("truncated table matched")
	}
}

func TestParseLsofPeer(t *testing.T) {
	out := "p100\nf10\nn127.0.0.1:47600->127.0.0.1:54321\np200\nf33\nn127.0.0.1:50000->127.0.0.1:8080\nf34\nn127.0.0.1:54321->127.0.0.1:47600\n"
	if pid, ok := parseLsofPeer([]byte(out), testClient, testServer); !ok || pid != 200 {
		t.Fatalf("pid %d %v", pid, ok)
	}
	mappedOut := "p300\nf5\nn[::ffff:127.0.0.1]:54321->[::ffff:127.0.0.1]:47600\n"
	if pid, ok := parseLsofPeer([]byte(mappedOut), testClient, testServer); !ok || pid != 300 {
		t.Fatalf("mapped: pid %d %v", pid, ok)
	}
	if _, ok := parseLsofPeer([]byte("pnope\nn127.0.0.1:54321->127.0.0.1:47600\n"), testClient, testServer); ok {
		t.Fatal("matched without a valid pid")
	}
	for _, a := range lsofArgs {
		if a == "" || a[0] != '-' {
			t.Fatalf("lsof argument %q is not a constant flag", a)
		}
	}
}
