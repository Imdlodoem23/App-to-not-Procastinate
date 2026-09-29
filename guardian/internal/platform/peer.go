package platform

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"net/netip"
	"path"
	"strconv"
	"strings"
	"time"
)

// Loopback peer lookup (docs/ARCHITECTURE.md §9.3 pairing and heartbeats,
// §10.5 Nuclear): which local process owns the client end of a TCP
// connection the guardian accepted on 127.0.0.1.
//
//   - Windows: GetExtendedTcpTable (iphlpapi, TCP_TABLE_OWNER_PID_CONNECTIONS,
//     IPv4 and IPv6) gives the owning PID; QueryFullProcessImageNameW its
//     image.
//   - Linux: /proc/net/tcp and /proc/net/tcp6 give the socket inode of the
//     client end, the /proc/<pid>/fd links the process holding it, and
//     /proc/<pid>/exe its image.
//   - macOS: the fixed command lsofPath with lsofArgs (constant arguments,
//     nothing from the request: §9.7) gives the PID; kern.procargs2 its
//     image (the absolute, clean path the process was executed from).
//
// The parsers below have no build tag, so every platform's format is
// unit-tested everywhere.

// peerTimeout bounds one lookup (lsof on macOS).
const peerTimeout = 3 * time.Second

// LoopbackPeer returns the process at the client end of a loopback TCP
// connection: client is the remote address of a connection accepted on
// server. Both must be loopback addresses. ok is false when the connection
// or its process cannot be found (the peer already closed it, the table
// could not be read) or its image path is unknown: callers fail closed.
func LoopbackPeer(ctx context.Context, client, server netip.AddrPort) (pid int, imagePath string, ok bool) {
	if !loopbackPair(client, server) {
		return 0, "", false
	}
	ctx, cancel := context.WithTimeout(ctx, peerTimeout)
	defer cancel()
	pid, imagePath, ok = lookupPeer(ctx, unmapPort(client), unmapPort(server))
	if !ok || pid <= 0 || imagePath == "" {
		return 0, "", false
	}
	return pid, imagePath, true
}

// loopbackPair reports whether both endpoints are valid loopback addresses
// with a port.
func loopbackPair(client, server netip.AddrPort) bool {
	for _, a := range []netip.AddrPort{client, server} {
		if !a.IsValid() || a.Port() == 0 || !a.Addr().Unmap().IsLoopback() {
			return false
		}
	}
	return true
}

func unmapPort(a netip.AddrPort) netip.AddrPort {
	return netip.AddrPortFrom(a.Addr().Unmap().WithZone(""), a.Port())
}

// sameEndpoint compares endpoints, treating IPv4-mapped IPv6 addresses as
// IPv4 and ignoring zones.
func sameEndpoint(a, b netip.AddrPort) bool {
	return a.Port() == b.Port() && a.Addr().Unmap().WithZone("") == b.Addr().Unmap().WithZone("")
}

// tcpEstablished is the ESTABLISHED state in /proc/net/tcp (TCP_ESTABLISHED).
const tcpEstablished = "01"

// parseProcNetTCP finds, in a /proc/net/tcp or /proc/net/tcp6 table, the
// socket inode of the established connection whose local end is client and
// whose remote end is server. Addresses there are the kernel's 32-bit words
// printed as native-endian hex; ports are big-endian hex.
func parseProcNetTCP(data []byte, client, server netip.AddrPort) (uint64, bool) {
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 4096), 1<<20)
	first := true
	for sc.Scan() {
		if first { // header line
			first = false
			continue
		}
		f := strings.Fields(sc.Text())
		if len(f) < 10 || f[3] != tcpEstablished {
			continue
		}
		local, ok1 := parseProcAddr(f[1])
		remote, ok2 := parseProcAddr(f[2])
		if !ok1 || !ok2 || !sameEndpoint(local, client) || !sameEndpoint(remote, server) {
			continue
		}
		inode, err := strconv.ParseUint(f[9], 10, 64)
		if err != nil || inode == 0 {
			continue
		}
		return inode, true
	}
	return 0, false
}

// parseProcAddr parses "0100007F:1F90" (IPv4) or a 32-hex-digit IPv6
// address with its port, as /proc/net/tcp{,6} print them: each 32-bit word
// of the address as a native-endian number.
func parseProcAddr(s string) (netip.AddrPort, bool) {
	hexAddr, hexPort, ok := strings.Cut(s, ":")
	if !ok || len(hexPort) != 4 {
		return netip.AddrPort{}, false
	}
	port, err := strconv.ParseUint(hexPort, 16, 16)
	if err != nil {
		return netip.AddrPort{}, false
	}
	raw, err := hex.DecodeString(hexAddr)
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return netip.AddrPort{}, false
	}
	b := make([]byte, len(raw))
	for i := 0; i < len(raw); i += 4 {
		binary.NativeEndian.PutUint32(b[i:], binary.BigEndian.Uint32(raw[i:]))
	}
	addr, ok := netip.AddrFromSlice(b)
	if !ok {
		return netip.AddrPort{}, false
	}
	return netip.AddrPortFrom(addr, uint16(port)), true
}

// socketLink is the /proc/<pid>/fd/<n> link target of a socket inode.
func socketLink(inode uint64) string { return "socket:[" + strconv.FormatUint(inode, 10) + "]" }

// Row sizes of GetExtendedTcpTable's TCP_TABLE_OWNER_PID_* tables.
const (
	// tcpRowSize is sizeof(MIB_TCPROW_OWNER_PID): state, local address,
	// local port, remote address, remote port, owning PID (six DWORDs).
	tcpRowSize = 24
	// tcp6RowSize is sizeof(MIB_TCP6ROW_OWNER_PID): local address (16),
	// scope, port, remote address (16), scope, port, state, owning PID.
	tcp6RowSize = 56
	// mibTCPStateEstab is MIB_TCP_STATE_ESTAB.
	mibTCPStateEstab = 5
)

// parseTCPTable finds the owning PID of the established connection whose
// local end is client and whose remote end is server in a
// MIB_TCPTABLE_OWNER_PID (v6 false) or MIB_TCP6TABLE_OWNER_PID (v6 true)
// buffer: a DWORD count, then the rows. Addresses are in network byte
// order; a port is in network byte order in the low 16 bits of its DWORD.
func parseTCPTable(buf []byte, v6 bool, client, server netip.AddrPort) (int, bool) {
	if len(buf) < 4 {
		return 0, false
	}
	size := tcpRowSize
	if v6 {
		size = tcp6RowSize
	}
	n := int(binary.LittleEndian.Uint32(buf))
	for i := range n {
		off := 4 + i*size
		if off < 0 || off+size > len(buf) {
			break
		}
		row := buf[off : off+size]
		var local, remote netip.AddrPort
		var state, pid uint32
		if v6 {
			local = netip.AddrPortFrom(netip.AddrFrom16([16]byte(row[0:16])), binary.BigEndian.Uint16(row[20:22]))
			remote = netip.AddrPortFrom(netip.AddrFrom16([16]byte(row[24:40])), binary.BigEndian.Uint16(row[44:46]))
			state, pid = binary.LittleEndian.Uint32(row[48:52]), binary.LittleEndian.Uint32(row[52:56])
		} else {
			state = binary.LittleEndian.Uint32(row[0:4])
			local = netip.AddrPortFrom(netip.AddrFrom4([4]byte(row[4:8])), binary.BigEndian.Uint16(row[8:10]))
			remote = netip.AddrPortFrom(netip.AddrFrom4([4]byte(row[12:16])), binary.BigEndian.Uint16(row[16:18]))
			pid = binary.LittleEndian.Uint32(row[20:24])
		}
		if state == mibTCPStateEstab && sameEndpoint(local, client) && sameEndpoint(remote, server) && pid > 0 {
			return int(pid), true
		}
	}
	return 0, false
}

// lsofPath is the absolute path of lsof on macOS (§9.7: absolute path,
// constant arguments).
const lsofPath = "/usr/sbin/lsof"

// lsofArgs are the constant arguments of the macOS lookup: established TCP
// connections with an end on 127.0.0.1 (the guardian listens only there),
// no DNS or port-name lookups, machine-readable PID and name fields.
var lsofArgs = []string{"-nP", "-iTCP@127.0.0.1", "-sTCP:ESTABLISHED", "-Fpn"}

// parseLsof finds the PID whose file name is "client->server" in `lsof -F pn`
// output (lines "p<pid>", "f<fd>", "n<name>").
func parseLsof(out []byte, client, server netip.AddrPort) (int, bool) {
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 4096), 1<<20)
	pid := 0
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			n, err := strconv.Atoi(line[1:])
			if err != nil || n <= 0 {
				pid = 0
				continue
			}
			pid = n
		case 'n':
			from, to, ok := strings.Cut(line[1:], "->")
			if !ok || pid <= 0 {
				continue
			}
			a, err1 := netip.ParseAddrPort(from)
			b, err2 := netip.ParseAddrPort(to)
			if err1 == nil && err2 == nil && sameEndpoint(a, client) && sameEndpoint(b, server) {
				return pid, true
			}
		}
	}
	return 0, false
}

// execPathFromProcargs2 returns the exec path from a macOS kern.procargs2
// buffer (a native-endian int32 argc, then the NUL-terminated path the
// process was executed from) when it is absolute and clean, else "".
func execPathFromProcargs2(b []byte) string {
	if len(b) <= 4 {
		return ""
	}
	b = b[4:]
	i := bytes.IndexByte(b, 0)
	if i <= 0 {
		return ""
	}
	p := string(b[:i])
	if !strings.HasPrefix(p, "/") || path.Clean(p) != p {
		return ""
	}
	return p
}
