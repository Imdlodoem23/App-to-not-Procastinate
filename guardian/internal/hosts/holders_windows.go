package hosts

import (
	"errors"
	"fmt"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Restart Manager (rstrtmgr.dll), loaded lazily from System32.
var (
	modRstrtmgr             = windows.NewLazySystemDLL("rstrtmgr.dll")
	procRmStartSession      = modRstrtmgr.NewProc("RmStartSession")
	procRmRegisterResources = modRstrtmgr.NewProc("RmRegisterResources")
	procRmGetList           = modRstrtmgr.NewProc("RmGetList")
	procRmEndSession        = modRstrtmgr.NewProc("RmEndSession")
)

const (
	cchRMSessionKey = 32 // CCH_RM_SESSION_KEY
	rmMaxHolders    = 256

	rmService  = 3    // RmService
	rmExplorer = 4    // RmExplorer
	rmCritical = 1000 // RmCritical
)

// rmProcessInfo is RM_PROCESS_INFO.
type rmProcessInfo struct {
	PID              uint32
	StartTime        windows.Filetime
	AppName          [256]uint16 // CCH_RM_MAX_APP_NAME + 1
	ServiceShortName [64]uint16  // CCH_RM_MAX_SVC_NAME + 1
	AppType          uint32
	AppStatus        uint32
	TSSessionID      uint32
	Restartable      int32
}

// osLockHolders asks the Restart Manager which processes hold path open.
// Processes that exited or whose PID was reused since (their start time no
// longer matches) are left out.
func osLockHolders(path string) ([]LockHolder, error) {
	if err := modRstrtmgr.Load(); err != nil {
		return nil, err
	}
	var session uint32
	var key [cchRMSessionKey + 1]uint16
	if r, _, _ := procRmStartSession.Call(uintptr(unsafe.Pointer(&session)), 0, uintptr(unsafe.Pointer(&key[0]))); r != 0 {
		return nil, fmt.Errorf("hosts: RmStartSession: %w", windows.Errno(r))
	}
	defer func() { _, _, _ = procRmEndSession.Call(uintptr(session)) }()

	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	files := [1]*uint16{p}
	if r, _, _ := procRmRegisterResources.Call(uintptr(session), 1, uintptr(unsafe.Pointer(&files[0])), 0, 0, 0, 0); r != 0 {
		return nil, fmt.Errorf("hosts: RmRegisterResources: %w", windows.Errno(r))
	}
	infos := make([]rmProcessInfo, 16)
	for {
		var needed, n uint32 = 0, uint32(len(infos))
		var reasons uint32
		r, _, _ := procRmGetList.Call(uintptr(session), uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&n)),
			uintptr(unsafe.Pointer(&infos[0])), uintptr(unsafe.Pointer(&reasons)))
		switch windows.Errno(r) {
		case 0:
			return holdersFrom(infos[:n]), nil
		case windows.ERROR_MORE_DATA:
			if needed > rmMaxHolders {
				return nil, errors.New("hosts: too many processes hold the file")
			}
			infos = make([]rmProcessInfo, needed+4)
		default:
			return nil, fmt.Errorf("hosts: RmGetList: %w", windows.Errno(r))
		}
	}
}

func holdersFrom(infos []rmProcessInfo) []LockHolder {
	out := make([]LockHolder, 0, len(infos))
	for _, info := range infos {
		name, ok := holderImage(info.PID, info.StartTime)
		if !ok {
			continue
		}
		out = append(out, LockHolder{
			PID:      int(info.PID),
			Name:     name,
			Session:  info.TSSessionID,
			Service:  info.AppType == rmService,
			Critical: info.AppType == rmCritical || info.AppType == rmExplorer,
		})
	}
	return out
}

// holderImage returns the executable name of pid if it is still the process
// the Restart Manager reported (same start time). The name is "" when it
// cannot be read, which makes the holder unbreakable.
func holderImage(pid uint32, start windows.Filetime) (string, bool) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		// Gone, or not openable even by LocalSystem (a protected process):
		// report it without a name so it is waited for, never closed.
		return "", !errors.Is(err, windows.ERROR_INVALID_PARAMETER)
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &created, &exited, &kernel, &user); err == nil && created != start {
		return "", false
	}
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &n); err != nil {
		return "", true
	}
	return filepath.Base(windows.UTF16ToString(buf[:n])), true
}
