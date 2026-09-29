package clock

import (
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// FallbackClockName is what BootClockName and AwakeClockName report when the
// operating system clock could not be read and Go's runtime monotonic clock is
// used instead. It never happens on supported systems; the engine may log it.
const FallbackClockName = "go-runtime-monotonic"

// errNoBootID is returned by BootID when the system offers no boot identifier.
var errNoBootID = errors.New("clock: boot id not available")

// Prefixes of the boot identifiers that come from a fallback source. Both are
// derived from the wall clock, so a clock change can alter them within one
// boot; SameBoot therefore ignores their value (see there).
const (
	derivedIDPrefix  = "derived:"  // Windows: boot moment from the wall clock
	boottimeIDPrefix = "boottime:" // macOS: kern.boottime
)

// isFallbackID reports whether id comes from a fallback source.
func isFallbackID(id string) bool {
	return strings.HasPrefix(id, derivedIDPrefix) || strings.HasPrefix(id, boottimeIDPrefix)
}

// processStart anchors the last-resort fallback clock.
var processStart = time.Now()

// monoSource wraps one operating system clock. It is probed once; if the probe
// fails it falls back to Go's runtime monotonic clock for the whole process
// lifetime (mixing sources would break monotonicity). Readings never decrease.
type monoSource struct {
	name string
	read func() (time.Duration, error)
	last atomic.Int64
}

func newMonoSource(name string, read func() (time.Duration, error)) *monoSource {
	if read == nil {
		return &monoSource{name: FallbackClockName, read: goMonotonic}
	}
	if _, err := read(); err != nil {
		return &monoSource{name: FallbackClockName, read: goMonotonic}
	}
	return &monoSource{name: name, read: read}
}

func goMonotonic() (time.Duration, error) { return time.Since(processStart), nil }

func (s *monoSource) now() time.Duration {
	v, err := s.read()
	for {
		old := s.last.Load()
		if err != nil || int64(v) <= old {
			return time.Duration(old)
		}
		if s.last.CompareAndSwap(old, int64(v)) {
			return v
		}
	}
}

var (
	bootSource  = sync.OnceValue(func() *monoSource { return newMonoSource(osBootClock()) })
	awakeSource = sync.OnceValue(func() *monoSource { return newMonoSource(osAwakeClock()) })
	cachedID    = sync.OnceValues(osBootID)
)

// BootTime returns the time elapsed since the system booted, including the
// time spent suspended or hibernated. It is monotonic (never decreases), is
// not affected by changes to the wall clock, and is the default Mono source of
// a Detector. See the package documentation for the clock used on each system.
func BootTime() time.Duration { return bootSource().now() }

// AwakeTime returns a monotonic reading that does NOT advance while the system
// is suspended. BootTime minus AwakeTime grows exactly by the time spent
// suspended. Its origin is unspecified; only differences are meaningful.
func AwakeTime() time.Duration { return awakeSource().now() }

// BootClockName names the clock behind BootTime, for diagnostics.
func BootClockName() string { return bootSource().name }

// AwakeClockName names the clock behind AwakeTime, for diagnostics.
func AwakeClockName() string { return awakeSource().name }

// BootID returns an identifier that is the same for the whole life of the
// current boot and different after a reboot. Identifiers that come from a
// fallback source carry a prefix ("boottime:", "derived:") so they can never
// equal a primary one; SameBoot does not compare their value, because a clock
// change can alter it. The value is read once per process and cached.
func BootID() (string, error) { return cachedID() }

// validID reports whether s looks like a boot identifier: 1 to 128 printable
// ASCII characters. It keeps garbage from files or sysctls out of snapshots.
func validID(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x21 || s[i] > 0x7e {
			return false
		}
	}
	return true
}
