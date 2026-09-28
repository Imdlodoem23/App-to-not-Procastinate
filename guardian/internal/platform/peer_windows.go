//go:build windows

package platform

import (
	"context"
	"errors"
	"net/netip"
	"unsafe"

	"golang.org/x/sys/windows"
)

// NewLazySystemDLL only loads from System32.
var procGetExtendedTcpTable = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetExtendedTcpTable")

const (
	// tcpTableOwnerPIDConnections is TCP_TABLE_OWNER_PID_CONNECTIONS.
	tcpTableOwnerPIDConnections = 4
	// tcpTableAttempts bounds the grow-and-retry loop (the table can grow
	// between the size query and the read).
	tcpTableAttempts = 8
	// maxTCPTable bounds the buffer (64 MiB: far above any real table).
	maxTCPTable = 64 << 20
)

// tcpTable and imageOf are the OS calls (tests fake them).
var (
	tcpTable = extendedTCPTable
	imageOf  = processImage
)

func lookupPeer(ctx context.Context, client, server netip.AddrPort) (int, string, bool) {
	for _, v6 := range []bool{false, true} {
		if ctx.Err() != nil {
			return 0, "", false
		}
		buf, err := tcpTable(v6)
		if err != nil {
			continue
		}
		pid, ok := parseTCPTable(buf, v6, client, server)
		if !ok || pid <= 4 { // 0 idle, 4 System
			continue
		}
		img, err := imageOf(uint32(pid))
		if err != nil || img == "" {
			return 0, "", false
		}
		return pid, img, true
	}
	return 0, "", false
}

// extendedTCPTable returns the connection table of one address family with
// owning PIDs (GetExtendedTcpTable, TCP_TABLE_OWNER_PID_CONNECTIONS).
func extendedTCPTable(v6 bool) ([]byte, error) {
	if err := procGetExtendedTcpTable.Find(); err != nil {
		return nil, err
	}
	family := uint32(windows.AF_INET)
	if v6 {
		family = windows.AF_INET6
	}
	size := uint32(16 << 10)
	for range tcpTableAttempts {
		buf := make([]byte, size)
		r, _, _ := procGetExtendedTcpTable.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)),
			0, uintptr(family), tcpTableOwnerPIDConnections, 0)
		switch windows.Errno(r) {
		case windows.ERROR_SUCCESS:
			return buf[:min(int(size), len(buf))], nil
		case windows.ERROR_INSUFFICIENT_BUFFER:
			if size > maxTCPTable {
				return nil, errors.New("platform: TCP table too large")
			}
			size += 4 << 10 // room for connections opened meanwhile
			continue
		default:
			return nil, windows.Errno(r)
		}
	}
	return nil, errors.New("platform: TCP table kept growing")
}

// processImage returns the full Win32 path of pid's executable
// (QueryFullProcessImageNameW with PROCESS_QUERY_LIMITED_INFORMATION, which
// works across sessions and integrity levels for a LocalSystem caller).
func processImage(pid uint32) (string, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &n); err != nil {
		return "", err
	}
	return windows.UTF16ToString(buf[:n]), nil
}
