//go:build !linux && !darwin && !windows

package clock

import "time"

// Unsupported systems compile with Go's runtime monotonic clock for both
// sources: suspend is not detected and continuity is never assumed after a
// restart, because there is no boot identifier.

func osBootClock() (string, func() (time.Duration, error)) { return "", nil }

func osAwakeClock() (string, func() (time.Duration, error)) { return "", nil }

func osBootID() (string, error) { return "", errNoBootID }
