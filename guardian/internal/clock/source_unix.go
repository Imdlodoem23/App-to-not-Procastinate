//go:build linux || darwin

package clock

import (
	"time"

	"golang.org/x/sys/unix"
)

// clockGettime returns a reader for clock_gettime(id). On macOS x/sys/unix
// calls libc through the runtime's trampolines, so this needs no cgo.
func clockGettime(id int32) func() (time.Duration, error) {
	return func() (time.Duration, error) {
		var ts unix.Timespec
		if err := unix.ClockGettime(id, &ts); err != nil {
			return 0, err
		}
		return time.Duration(ts.Nano()), nil
	}
}
