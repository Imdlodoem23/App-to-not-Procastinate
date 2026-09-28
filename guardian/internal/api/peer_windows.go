//go:build windows

package api

import (
	"context"
	"net/netip"
	"path/filepath"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procGetExtendedTcpTable = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetExtendedTcpTable")

const (
	// tcpTableOwnerPIDConnections is TCP_TABLE_OWNER_PID_CONNECTIONS.
	tcpTableOwnerPIDConnections = 4
	// errInsufficientBuffer is ERROR_INSUFFICIENT_BUFFER.
	errInsufficientBuffer = 122
	// tcpTableAttempts bounds the grow-and-retry loop (the table changes size between
	// calls).
	tcpTableAttempts = 8
)

// OSPeerResolver returns the Windows resolver: GetExtendedTcpTable gives the owning PID
// of the client end, QueryFullProcessImageNameW its image and ProcessIdToSessionId its
// session (0 is services; the console session is WTSGetActiveConsoleSessionId).
func OSPeerResolver() PeerResolver { return windowsPeers{} }

type windowsPeers struct{}

func (windowsPeers) Resolve(_ context.Context, client, server netip.AddrPort) (PeerInfo, error) {
	tables := []struct {
		family uint32
		parse  func([]byte, netip.AddrPort, netip.AddrPort) (int, bool)
	}{
		{windows.AF_INET, parseTCPOwnerPIDTable},
		{windows.AF_INET6, parseTCP6OwnerPIDTable},
	}
	var firstErr error
	for _, tb := range tables {
		buf, err := extendedTCPTable(tb.family)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if pid, ok := tb.parse(buf, client, server); ok && pid > 0 {
			return describeProcess(uint32(pid))
		}
	}
	if firstErr != nil {
		return PeerInfo{}, firstErr
	}
	return PeerInfo{}, errPeerNotFound
}

// extendedTCPTable returns the connection table of an address family with owning
// PIDs.
func extendedTCPTable(family uint32) ([]byte, error) {
	size := uint32(16 << 10)
	for range tcpTableAttempts {
		buf := make([]byte, size)
		r, _, _ := procGetExtendedTcpTable.Call(
			uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 0,
			uintptr(family), tcpTableOwnerPIDConnections, 0)
		switch r {
		case 0:
			return buf, nil
		case errInsufficientBuffer:
			size += 4 << 10
		default:
			return nil, syscall.Errno(r)
		}
	}
	return nil, syscall.Errno(errInsufficientBuffer)
}

// describeProcess reads the image path and session of pid.
func describeProcess(pid uint32) (PeerInfo, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return PeerInfo{}, err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &n); err != nil {
		return PeerInfo{}, err
	}
	path := windows.UTF16ToString(buf[:n])
	var session uint32
	if err := windows.ProcessIdToSessionId(pid, &session); err != nil {
		return PeerInfo{}, err
	}
	console := windows.WTSGetActiveConsoleSessionId()
	return PeerInfo{
		PID: int(pid), Name: filepath.Base(path), Path: path,
		Interactive: session != 0, Console: session != 0 && session == console,
	}, nil
}
