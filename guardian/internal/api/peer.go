package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"net/netip"
	"strconv"
	"strings"
)

// Loopback peer lookup (docs/ARCHITECTURE.md §9.3, §10.5): which local process owns the
// client end of a request's TCP connection. The OS resolvers map the connection to a
// PID from the kernel's connection table (Windows GetExtendedTcpTable; Linux
// /proc/net/tcp{,6} inode → /proc/<pid>/fd; macOS lsof with a constant argument list,
// §9.7) and then describe that process. The parsers below are OS-independent so every
// platform's format is unit-tested everywhere.

// PeerInfo describes the process at the other end of a loopback connection.
type PeerInfo struct {
	PID int
	// Name is the executable file name ("chrome.exe", "firefox", "Google Chrome
	// Helper"), matched against the catalog's browsers by the engine.
	Name string
	// Path is the full executable path ("" when unknown).
	Path string
	// Interactive: the process belongs to an interactive user (not a service or
	// system account; Windows: not session 0).
	Interactive bool
	// Console: the process runs in the active console session (Windows: the active
	// console session id; macOS: the owner of /dev/console; Linux: Interactive).
	Console bool
}

// PeerResolver finds the process that owns client, the remote end of a connection
// accepted on server.
type PeerResolver interface {
	Resolve(ctx context.Context, client, server netip.AddrPort) (PeerInfo, error)
}

// PeerResolverFunc adapts a function to PeerResolver.
type PeerResolverFunc func(ctx context.Context, client, server netip.AddrPort) (PeerInfo, error)

// Resolve calls f.
func (f PeerResolverFunc) Resolve(ctx context.Context, client, server netip.AddrPort) (PeerInfo, error) {
	return f(ctx, client, server)
}

// errPeerNotFound: the connection is not in the table (the peer already closed it, or
// it is not local).
var errPeerNotFound = errors.New("api: loopback peer not found")

// sameEndpoint compares endpoints, treating IPv4-mapped IPv6 addresses as IPv4.
func sameEndpoint(a, b netip.AddrPort) bool {
	return a.Port() == b.Port() && a.Addr().Unmap() == b.Addr().Unmap()
}

// parseProcNetTCP finds the socket inode of the connection whose local end is client
// and whose remote end is server in a /proc/net/tcp or /proc/net/tcp6 table. Addresses
// there are the kernel's __be32 words printed as native-endian hex; ports are hex.
func parseProcNetTCP(data []byte, client, server netip.AddrPort) (uint64, bool) {
	sc := bufio.NewScanner(bytes.NewReader(data))
	first := true
	for sc.Scan() {
		if first { // header line
			first = false
			continue
		}
		f := strings.Fields(sc.Text())
		if len(f) < 10 {
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

// parseProcAddr parses "0100007F:1F90" (IPv4) or a 32-hex-digit IPv6 address.
func parseProcAddr(s string) (netip.AddrPort, bool) {
	hexAddr, hexPort, ok := strings.Cut(s, ":")
	if !ok {
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
	// Each 32-bit word was printed as a native-endian integer: rebuild its bytes.
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

// socketInodeLink is the /proc/<pid>/fd/<n> link target of a socket inode.
func socketInodeLink(inode uint64) string { return "socket:[" + strconv.FormatUint(inode, 10) + "]" }

// tcpOwnerPIDRowSize is sizeof(MIB_TCPROW_OWNER_PID): six DWORDs.
const tcpOwnerPIDRowSize = 24

// parseTCPOwnerPIDTable finds the owning PID of the connection whose local end is
// client and whose remote end is server in a MIB_TCPTABLE_OWNER_PID buffer (Windows
// GetExtendedTcpTable, AF_INET): dwNumEntries, then rows {state, localAddr, localPort,
// remoteAddr, remotePort, owningPid}. Addresses are in network byte order; a port is
// in network byte order in the low 16 bits of its DWORD.
func parseTCPOwnerPIDTable(buf []byte, client, server netip.AddrPort) (int, bool) {
	if len(buf) < 4 {
		return 0, false
	}
	n := int(binary.LittleEndian.Uint32(buf))
	for i := range n {
		off := 4 + i*tcpOwnerPIDRowSize
		if off+tcpOwnerPIDRowSize > len(buf) {
			break
		}
		row := buf[off : off+tcpOwnerPIDRowSize]
		local := netip.AddrPortFrom(netip.AddrFrom4([4]byte(row[4:8])), binary.BigEndian.Uint16(row[8:10]))
		remote := netip.AddrPortFrom(netip.AddrFrom4([4]byte(row[12:16])), binary.BigEndian.Uint16(row[16:18]))
		if sameEndpoint(local, client) && sameEndpoint(remote, server) {
			return int(binary.LittleEndian.Uint32(row[20:24])), true
		}
	}
	return 0, false
}

// lsofArgs are the constant arguments of the macOS lookup (§9.7: no request data on a
// command line): established TCP connections involving 127.0.0.1, machine-readable
// PID and name fields, no DNS or port-name lookups.
var lsofArgs = []string{"-nP", "-iTCP@127.0.0.1", "-sTCP:ESTABLISHED", "-Fpn"}

// parseLsofPeer finds the PID whose file name is "client->server" in `lsof -F pn`
// output (lines "p<pid>", "f<fd>", "n<name>").
func parseLsofPeer(out []byte, client, server netip.AddrPort) (int, bool) {
	sc := bufio.NewScanner(bytes.NewReader(out))
	pid := 0
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			n, err := strconv.Atoi(line[1:])
			if err != nil {
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
