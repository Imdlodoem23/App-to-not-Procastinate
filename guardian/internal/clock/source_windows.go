package clock

import (
	"strconv"
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

// bootIDKey holds BootId, a counter Windows increments at every boot.
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

// osBootID reads the BootId counter. If it is missing, it derives the boot
// moment from the wall clock minus the interrupt time, rounded to the minute.
// That fallback changes when the wall clock is changed or drifts across a
// minute boundary, which only makes Restore treat the restart as a reboot and
// fall back to the wall clock: it can never fake continuity.
func osBootID() (string, error) {
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, bootIDKey, registry.QUERY_VALUE); err == nil {
		v, _, err := k.GetIntegerValue("BootId")
		_ = k.Close()
		if err == nil {
			return "bootid:" + strconv.FormatUint(v, 10), nil
		}
	}
	boot := time.Now().Add(-BootTime()).Round(time.Minute) // Round strips the monotonic reading.
	return "derived:" + strconv.FormatInt(boot.Unix(), 10), nil
}
