package clock

import (
	"errors"
	"runtime"
	"testing"
	"time"
)

// supportedOS lists the systems where a real OS clock and boot id must work.
func supportedOS() bool {
	switch runtime.GOOS {
	case "linux", "darwin", "windows":
		return true
	}
	return false
}

func TestOSClocksAreUsed(t *testing.T) {
	if !supportedOS() {
		t.Skip("no OS clock on " + runtime.GOOS)
	}
	if n := BootClockName(); n == FallbackClockName || n == "" {
		t.Fatalf("BootTime fell back to %q on %s", n, runtime.GOOS)
	}
	if n := AwakeClockName(); n == FallbackClockName || n == "" {
		t.Fatalf("AwakeTime fell back to %q on %s", n, runtime.GOOS)
	}
}

func TestBootTimeIsMonotonicAndPositive(t *testing.T) {
	prev := BootTime()
	if prev <= 0 {
		t.Fatalf("BootTime = %v, want > 0", prev)
	}
	for range 1000 {
		cur := BootTime()
		if cur < prev {
			t.Fatalf("BootTime went back from %v to %v", prev, cur)
		}
		prev = cur
	}
}

// Over a short awake interval, BootTime and AwakeTime advance like Go's own
// monotonic clock (Windows clocks tick every ~15.6 ms and CI machines are
// busy, hence the margin).
func TestClocksAdvanceWithRealTime(t *testing.T) {
	const margin = 100 * time.Millisecond
	g0, b0, a0 := time.Now(), BootTime(), AwakeTime()
	time.Sleep(200 * time.Millisecond)
	a1, b1, g1 := AwakeTime(), BootTime(), time.Now()
	goDelta := g1.Sub(g0)
	if d := (b1 - b0) - goDelta; d.Abs() > margin {
		t.Fatalf("BootTime advanced %v while Go's clock advanced %v", b1-b0, goDelta)
	}
	if d := (a1 - a0) - goDelta; d.Abs() > margin {
		t.Fatalf("AwakeTime advanced %v while Go's clock advanced %v", a1-a0, goDelta)
	}
}

// AwakeTime excludes suspend and BootTime includes it, so on real clocks the
// awake reading never exceeds the boot reading taken just after it.
func TestAwakeNotAheadOfBoot(t *testing.T) {
	if !supportedOS() {
		t.Skip("no OS clock on " + runtime.GOOS)
	}
	a := AwakeTime()
	b := BootTime()
	if a > b+20*time.Millisecond {
		t.Fatalf("AwakeTime %v is ahead of BootTime %v", a, b)
	}
}

func TestBootID(t *testing.T) {
	if !supportedOS() {
		if _, err := BootID(); !errors.Is(err, errNoBootID) {
			t.Fatalf("BootID error = %v, want errNoBootID", err)
		}
		return
	}
	id, err := BootID()
	if err != nil {
		t.Fatalf("BootID: %v", err)
	}
	if !validID(id) {
		t.Fatalf("BootID = %q is not a valid id", id)
	}
	// The underlying source (not only the cache) must be stable within a
	// boot. Fallback ids are derived from the wall clock and may change; only
	// their form is checked (SameBoot does not compare them).
	again, err := osBootID()
	if err != nil {
		t.Fatalf("osBootID: %v", err)
	}
	if !isFallbackID(id) && again != id {
		t.Fatalf("boot id changed within one boot: %q then %q", id, again)
	}
	t.Logf("boot id on %s: %q", runtime.GOOS, id)
}

func TestValidID(t *testing.T) {
	cases := map[string]bool{
		"8c4c1c42-5d0e-4a7b-9d0e-1f2a3b4c5d6e": true,
		"bootid:42":                            true,
		"":                                     false,
		"has space":                            false,
		"new\nline":                            false,
		"ñ":                                    false,
		string(make([]byte, 129)):              false,
	}
	for in, want := range cases {
		if got := validID(in); got != want {
			t.Errorf("validID(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestMonoSourceFallbackAndClamp(t *testing.T) {
	failing := newMonoSource("broken", func() (time.Duration, error) { return 0, errors.New("nope") })
	if failing.name != FallbackClockName {
		t.Fatalf("name = %q, want the fallback", failing.name)
	}
	if v := failing.now(); v <= 0 {
		t.Fatalf("fallback reading = %v, want > 0", v)
	}

	vals := []time.Duration{5, 9, 7, 12}
	errs := []error{nil, nil, nil, errors.New("transient")}
	i := 0
	s := newMonoSource("fake", func() (time.Duration, error) {
		if i >= len(vals) {
			return 0, nil
		}
		v, err := vals[i], errs[i]
		i++
		return v, err
	})
	i = 0                               // forget the probe made by newMonoSource
	want := []time.Duration{5, 9, 9, 9} // never decreases; errors repeat the last value
	for n, w := range want {
		if got := s.now(); got != w {
			t.Fatalf("reading %d = %v, want %v", n, got, w)
		}
	}
}
