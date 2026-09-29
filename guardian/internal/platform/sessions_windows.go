package platform

import (
	"fmt"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/imdlodoem23/centrate/guardian/internal/clock"
)

var procWTSQuerySessionInformationW = windows.NewLazySystemDLL("wtsapi32.dll").NewProc("WTSQuerySessionInformationW")

const wtsSessionInfo = 24 // WTS_INFO_CLASS WTSSessionInfo

// wtsInfo is WTSINFOW.
type wtsInfo struct {
	State                   uint32
	SessionID               uint32
	IncomingBytes           uint32
	OutgoingBytes           uint32
	IncomingFrames          uint32
	OutgoingFrames          uint32
	IncomingCompressedBytes uint32
	OutgoingCompressedBytes uint32
	WinStationName          [32]uint16
	Domain                  [17]uint16
	UserName                [21]uint16
	ConnectTime             int64
	DisconnectTime          int64
	LastInputTime           int64
	LogonTime               int64
	CurrentTime             int64
}

// osSessions lists the WTS sessions other than session 0 that have a user
// (active or disconnected), with their logon time.
func osSessions() ([]LogonSession, error) {
	var infos *windows.WTS_SESSION_INFO
	var count uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &infos, &count); err != nil {
		return nil, fmt.Errorf("platform: WTSEnumerateSessions: %w", err)
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(infos)))
	console := windows.WTSGetActiveConsoleSessionId()
	now := clock.BootTime()
	var out []LogonSession
	for _, s := range unsafe.Slice(infos, count) {
		if s.SessionID == 0 || s.State == windows.WTSListen || s.State == windows.WTSDown || s.State == windows.WTSInit {
			continue
		}
		info, ok := querySessionInfo(s.SessionID)
		if !ok || info.UserName[0] == 0 {
			continue
		}
		ls := LogonSession{
			ID:      fmt.Sprintf("%d@%d", s.SessionID, info.LogonTime),
			Console: s.SessionID == console && s.State == windows.WTSActive,
		}
		if info.LogonTime > 0 && info.CurrentTime >= info.LogonTime {
			elapsed := time.Duration(info.CurrentTime-info.LogonTime) * 100 // FILETIME ticks
			ls.LogonBoot, ls.HasLogon = logonFromElapsed(now, elapsed), true
		}
		out = append(out, ls)
	}
	return out, nil
}

func querySessionInfo(id uint32) (wtsInfo, bool) {
	var buf *byte
	var n uint32
	r, _, _ := procWTSQuerySessionInformationW.Call(0, uintptr(id), wtsSessionInfo,
		uintptr(unsafe.Pointer(&buf)), uintptr(unsafe.Pointer(&n)))
	if r == 0 || buf == nil {
		return wtsInfo{}, false
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(buf)))
	if uintptr(n) < unsafe.Sizeof(wtsInfo{}) {
		return wtsInfo{}, false
	}
	return *(*wtsInfo)(unsafe.Pointer(buf)), true
}
