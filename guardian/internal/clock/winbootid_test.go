package clock

import (
	"errors"
	"testing"
	"time"
)

func TestWindowsBootID(t *testing.T) {
	errUnavailable := errors.New("unavailable")
	val := func(v uint64) func() (uint64, error) { return func() (uint64, error) { return v, nil } }
	fail := func() (uint64, error) { return 0, errUnavailable }
	boot := time.Date(2026, time.September, 27, 8, 0, 29, 0, time.UTC) // rounds down to 08:00
	moment := func() time.Time { return boot }

	cases := []struct {
		name              string
		counter, sysStart func() (uint64, error)
		want              string
	}{
		{"both", val(42), val(133_700_000_000_000_000), "bootid:42:133700000000000000"},
		{"counter only", val(42), fail, "bootid:42"},
		{"zero start time counts as unknown", val(42), val(0), "bootid:42"},
		{"start time only", fail, val(133_700_000_000_000_000), "systemstart:133700000000000000"},
		{"neither", fail, fail, "derived:1790496000"},
		{"neither, zero start time", fail, val(0), "derived:1790496000"},
	}
	for _, c := range cases {
		got := windowsBootID(c.counter, c.sysStart, moment)
		if got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
		if !validID(got) {
			t.Errorf("%s: %q is not a valid id", c.name, got)
		}
		if isFallbackID(got) != (c.want[:8] == "derived:") {
			t.Errorf("%s: isFallbackID(%q) = %v", c.name, got, isFallbackID(got))
		}
	}
}

// The finding this guards against: BootId does not change on some systems.
// A new System process creation time must still produce a new identifier,
// and SameBoot must then see a different boot even though Mono went forward.
func TestWindowsBootIDStuckCounter(t *testing.T) {
	stuck := func() (uint64, error) { return 7, nil }
	moment := func() time.Time { return t0 }
	first := windowsBootID(stuck, func() (uint64, error) { return 1000, nil }, moment)
	second := windowsBootID(stuck, func() (uint64, error) { return 2000, nil }, moment)
	if first == second {
		t.Fatalf("both boots got %q", first)
	}
	prev := Snapshot{Trusted: t0, Boot: time.Minute, BootID: first}
	if SameBoot(prev, Snapshot{Boot: time.Hour, BootID: second}) {
		t.Fatal("a stuck BootId counter made two boots look the same")
	}
	if !SameBoot(prev, Snapshot{Boot: time.Hour, BootID: first}) {
		t.Fatal("the same boot was not recognised")
	}
}

func TestIsFallbackID(t *testing.T) {
	cases := map[string]bool{
		"derived:1790409600":                   true,
		"boottime:1790409600.000123":           true,
		"bootid:42:1337":                       false,
		"systemstart:1337":                     false,
		"8c4c1c42-5d0e-4a7b-9d0e-1f2a3b4c5d6e": false,
		"":                                     false,
	}
	for id, want := range cases {
		if got := isFallbackID(id); got != want {
			t.Errorf("isFallbackID(%q) = %v, want %v", id, got, want)
		}
	}
}
