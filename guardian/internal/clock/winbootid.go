package clock

import (
	"strconv"
	"time"
)

// windowsBootID builds the Windows boot identifier from two boot markers that
// changing the clock does not move:
//
//   - counter: the BootId value under
//     HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters,
//     which Windows increments at every boot. It is undocumented and does not
//     change on some systems (prefetcher disabled, some VM and LTSC images).
//   - systemStart: the creation time of the System process (PID 4) as a
//     FILETIME. Windows stamps it once, at boot, and never rewrites it when the
//     clock is changed afterwards. Zero counts as unknown.
//
// With both known the identifier is "bootid:<counter>:<filetime>", so a reboot
// changes it even when one of the two markers stays the same. With one known
// it is "bootid:<counter>" or "systemstart:<filetime>". With neither it is the
// fallback "derived:<Unix time of bootMoment rounded to the minute>", whose
// value SameBoot does not compare.
//
// It lives in a file without a build constraint so that tests on every system
// can drive it with injected readers; osBootID wires in the real ones.
func windowsBootID(counter, systemStart func() (uint64, error), bootMoment func() time.Time) string {
	n, errN := counter()
	ft, errS := systemStart()
	haveN, haveS := errN == nil, errS == nil && ft != 0
	switch {
	case haveN && haveS:
		return "bootid:" + strconv.FormatUint(n, 10) + ":" + strconv.FormatUint(ft, 10)
	case haveN:
		return "bootid:" + strconv.FormatUint(n, 10)
	case haveS:
		return "systemstart:" + strconv.FormatUint(ft, 10)
	}
	// Round strips the monotonic reading.
	return derivedIDPrefix + strconv.FormatInt(bootMoment().Round(time.Minute).Unix(), 10)
}
