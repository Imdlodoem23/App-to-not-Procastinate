package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"

	"github.com/imdlodoem23/centrate/guardian/internal/clock"
	"github.com/imdlodoem23/centrate/guardian/internal/platform"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// ActiveLevel is the answer of `centrate-guardian has-active` (§13), which is also its
// exit code.
type ActiveLevel int

const (
	// ActiveNone: nothing is active (exit 0).
	ActiveNone ActiveLevel = 0
	// ActiveNormal: a normal or strict block is active (exit 10).
	ActiveNormal ActiveLevel = 10
	// ActiveStrong: a hardcore, exam or punishment block is active (exit 11).
	ActiveStrong ActiveLevel = 11
)

// HasActive reads the enforcement core of dataDir/state.json (state.prev.json as a
// fallback) and reports what is active now. It needs no lock and no secret, so it works
// while the service runs and while it is stopped: the trusted time comes from the
// core's clock snapshot restored with the machine's clocks (the same rules as a guardian
// start: a clock change made while stopped does not end a block). A data directory
// without state (never installed, or wiped) has nothing active.
func HasActive(dataDir string) (ActiveLevel, error) { return HasActiveWith(dataDir, SystemClock{}) }

// HasActiveWith is HasActive with an injected clock (tests).
func HasActiveWith(dataDir string, c Clock) (ActiveLevel, error) {
	raw, err := store.ReadEnforcement(dataDir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ActiveNone, nil
		}
		return ActiveNone, fmt.Errorf("engine: read the enforcement core: %w", err)
	}
	var core enforcementCore
	if err := json.Unmarshal(raw, &core); err != nil {
		return ActiveNone, fmt.Errorf("engine: decode the enforcement core: %w", err)
	}
	if core.V != 1 {
		return ActiveNone, fmt.Errorf("engine: enforcement core version %d", core.V)
	}
	det := clock.NewDetector(clock.Options{Wall: c.Wall, Mono: c.Boot, Awake: c.Awake, BootID: c.BootID})
	if core.Clock != nil && !core.Clock.Trusted.IsZero() {
		det.Restore(*core.Clock)
	}
	now := det.EffectiveNow().UnixMilli()
	level := ActiveNone
	for _, it := range core.Items {
		end, ok := parseMs(it.EndsAtTrusted)
		if ok && end <= now {
			continue
		}
		// An unreadable end counts as active: when in doubt, warn.
		if it.Kind == KindPunishment || it.Mode == ModeHardcore || it.Mode == ModeExam {
			return ActiveStrong, nil
		}
		level = ActiveNormal
	}
	return level, nil
}

// HasActiveBlocks has the signature of svc.HasActiveBlocks (true for exit 10 or 11) on
// the system data directory.
func HasActiveBlocks() (bool, error) {
	l, err := HasActive(platform.DataDir())
	return l != ActiveNone, err
}
