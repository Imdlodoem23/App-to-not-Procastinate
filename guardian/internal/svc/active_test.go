package svc

import (
	"errors"
	"testing"
)

func withActiveHooks(t *testing.T, level func() (ActiveLevel, error), blocks func() (bool, error)) {
	t.Helper()
	prevLevel, prevBlocks := HasActiveLevel, HasActiveBlocks
	t.Cleanup(func() { HasActiveLevel, HasActiveBlocks = prevLevel, prevBlocks })
	HasActiveLevel, HasActiveBlocks = level, blocks
}

func TestCheckActiveUsesLevels(t *testing.T) {
	boom := errors.New("state unreadable")
	cases := []struct {
		level    ActiveLevel
		err      error
		want     ActiveLevel
		code     int
		name     string
		active   bool
		wantsErr bool
	}{
		{ActiveNone, nil, ActiveNone, 0, "none", false, false},
		{ActiveNormal, nil, ActiveNormal, 10, "normal", true, false},
		{ActiveStrong, nil, ActiveStrong, 11, "strong", true, false},
		{ActiveLevel(7), nil, ActiveStrong, 11, "strong", true, false}, // when in doubt, warn
		{ActiveLevel(-1), nil, ActiveStrong, 11, "strong", true, false},
		{ActiveStrong, boom, ActiveNone, 0, "none", false, true},
	}
	for _, c := range cases {
		withActiveHooks(t, func() (ActiveLevel, error) { return c.level, c.err },
			func() (bool, error) {
				t.Fatal("HasActiveBlocks must not be used when levels are wired")
				return false, nil
			})
		got, err := CheckActive()
		if (err != nil) != c.wantsErr || got != c.want || got.ExitCode() != c.code || got.String() != c.name || got.Active() != c.active {
			t.Errorf("level %d: got %v (%d %s %v), %v", c.level, got, got.ExitCode(), got, got.Active(), err)
		}
	}
}

func TestCheckActiveFallsBackToHasActiveBlocks(t *testing.T) {
	withActiveHooks(t, nil, func() (bool, error) { return true, nil })
	if got, err := CheckActive(); err != nil || got != ActiveNormal || got.ExitCode() != 10 {
		t.Fatalf("true: %v, %v", got, err)
	}
	withActiveHooks(t, nil, func() (bool, error) { return false, nil })
	if got, err := CheckActive(); err != nil || got != ActiveNone || got.ExitCode() != 0 {
		t.Fatalf("false: %v, %v", got, err)
	}
	withActiveHooks(t, nil, func() (bool, error) { return false, ErrActiveBlocksNotWired })
	if _, err := CheckActive(); !errors.Is(err, ErrActiveBlocksNotWired) {
		t.Fatalf("not wired: %v", err)
	}
}
