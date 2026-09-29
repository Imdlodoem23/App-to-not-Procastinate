package clock

import (
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// NewLazySystemDLL only loads from System32, so no DLL planted next to the
// binary can be picked up.
var (
	modKernel32   = windows.NewLazySystemDLL("kernel32.dll")
	modKernelBase = windows.NewLazySystemDLL("kernelbase.dll")

	procQueryInterruptTimeK32      = modKernel32.NewProc("QueryInterruptTime")
	procQueryInterruptTimeKB       = modKernelBase.NewProc("QueryInterruptTime")
	procQueryUnbiasedInterruptTime = modKernel32.NewProc("QueryUnbiasedInterruptTime")
)

// bootIDKey holds BootId, a counter Windows increments at every boot (except
// on some systems; see windowsBootID).
const bootIDKey = `SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters`

// osBootClock uses QueryInterruptTime (Windows 10+), which includes sleep and
// hibernation. It is documented in realtimeapiset.h; depending on the build it
// is exported by kernel32.dll, kernelbase.dll or both. GetTickCount64 is the
// fallback: coarser (milliseconds) but it counts sleep too.
func osBootClock() (string, func() (time.Duration, error)) {
	for _, p := range []*windows.LazyProc{procQueryInterruptTimeK32, procQueryInterruptTimeKB} {
		if p.Find() != nil {
			continue
		}
		return "QueryInterruptTime", func() (time.Duration, error) {
			var t uint64 // 100 ns units; the function returns VOID.
			_, _, _ = p.Call(uintptr(unsafe.Pointer(&t)))
			return time.Duration(t) * 100, nil
		}
	}
	return "GetTickCount64", func() (time.Duration, error) {
		return windows.DurationSinceBoot(), nil
	}
}

// osAwakeClock uses QueryUnbiasedInterruptTime, which excludes sleep and
// hibernation.
func osAwakeClock() (string, func() (time.Duration, error)) {
	if procQueryUnbiasedInterruptTime.Find() != nil {
		return "", nil
	}
	return "QueryUnbiasedInterruptTime", func() (time.Duration, error) {
		var t uint64 // 100 ns units.
		r, _, err := procQueryUnbiasedInterruptTime.Call(uintptr(unsafe.Pointer(&t)))
		if r == 0 {
			return 0, err
		}
		return time.Duration(t) * 100, nil
	}
}

// osBootID combines the BootId counter with the creation time of the System
// process; see windowsBootID. If neither can be read it derives the boot
// moment from the wall clock minus the interrupt time. That fallback changes
// when the wall clock is changed, so SameBoot never compares it and decides by
// Mono continuity alone.
func osBootID() (string, error) {
	return windowsBootID(prefetchBootID, systemProcessStart, func() time.Time {
		return time.Now().Add(-BootTime())
	}), nil
}

// prefetchBootID reads the BootId counter.
func prefetchBootID() (uint64, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, bootIDKey, registry.QUERY_VALUE)
	if err != nil {
		return 0, err
	}
	defer func() { _ = k.Close() }()
	v, _, err := k.GetIntegerValue("BootId")
	return v, err
}

// systemPID is the process id of the System process on every Windows NT 6+.
const systemPID = 4

// systemProcessStart returns the creation time of the System process as a
// FILETIME (100 ns units since 1601). The kernel stamps it at boot and never
// rewrites it, so it tells boots apart when the BootId counter does not
// change. PROCESS_QUERY_LIMITED_INFORMATION is granted on protected processes
// such as System; the guardian runs as LocalSystem.
func systemProcessStart() (uint64, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, systemPID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil {
		return 0, err
	}
	return uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime), nil
}
