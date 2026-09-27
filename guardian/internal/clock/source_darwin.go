package clock

import (
	"fmt"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// In Apple's libc (gen/clock_gettime.c) CLOCK_MONOTONIC_RAW is
// mach_continuous_time, which keeps counting during sleep and is not affected
// by frequency or time adjustments. This is the clock PROMPT.md asks for.
func osBootClock() (string, func() (time.Duration, error)) {
	return "CLOCK_MONOTONIC_RAW (mach_continuous_time)", clockGettime(unix.CLOCK_MONOTONIC_RAW)
}

// CLOCK_UPTIME_RAW is mach_absolute_time, which stops during sleep.
func osAwakeClock() (string, func() (time.Duration, error)) {
	return "CLOCK_UPTIME_RAW (mach_absolute_time)", clockGettime(unix.CLOCK_UPTIME_RAW)
}

// osBootID prefers kern.bootsessionuuid (a UUID generated at every boot). The
// fallback, kern.boottime, is shifted by the kernel whenever the wall clock is
// set, so after a clock change it may look like a reboot: that only makes
// Restore fall back to the wall clock, never trust a broken continuity.
func osBootID() (string, error) {
	if id, err := unix.Sysctl("kern.bootsessionuuid"); err == nil {
		if id = strings.TrimSpace(id); validID(id) {
			return id, nil
		}
	}
	tv, err := unix.SysctlTimeval("kern.boottime")
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("boottime:%d.%06d", tv.Sec, tv.Usec), nil
}
