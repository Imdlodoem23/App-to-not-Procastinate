package clock

import (
	"os"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// bootIDPath holds a random UUID the kernel generates at every boot.
const bootIDPath = "/proc/sys/kernel/random/boot_id"

// CLOCK_BOOTTIME is CLOCK_MONOTONIC plus the time spent in suspend.
func osBootClock() (string, func() (time.Duration, error)) {
	return "CLOCK_BOOTTIME", clockGettime(unix.CLOCK_BOOTTIME)
}

// CLOCK_MONOTONIC stops while the system is suspended.
func osAwakeClock() (string, func() (time.Duration, error)) {
	return "CLOCK_MONOTONIC", clockGettime(unix.CLOCK_MONOTONIC)
}

func osBootID() (string, error) {
	b, err := os.ReadFile(bootIDPath)
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(string(b))
	if !validID(id) {
		return "", errNoBootID
	}
	return id, nil
}
