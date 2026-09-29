package svc

// ActiveLevel is the answer of `centrate-guardian has-active`
// (docs/ARCHITECTURE.md §13), which is also its exit code: installers warn
// «se perderán los puntos y la racha» for 10 and for 11.
type ActiveLevel int

const (
	// ActiveNone: no block is active (exit 0).
	ActiveNone ActiveLevel = 0
	// ActiveNormal: a normal or strict block is active (exit 10).
	ActiveNormal ActiveLevel = 10
	// ActiveStrong: a hardcore, exam or punishment block is active (exit 11).
	ActiveStrong ActiveLevel = 11
)

// HasActiveLevel reports the strongest active level from the state files
// (it must work while the service is stopped). cmd/centrate-guardian wires
// it to the engine:
//
//	svc.HasActiveLevel = func() (svc.ActiveLevel, error) {
//		l, err := engine.HasActive(platform.DataDir())
//		return svc.ActiveLevel(l), err
//	}
//
// While it is nil, CheckActive falls back to HasActiveBlocks.
var HasActiveLevel func() (ActiveLevel, error)

// CheckActive returns the has-active answer: HasActiveLevel when wired,
// otherwise HasActiveBlocks (true reads as ActiveNormal). A level other than
// 0, 10 or 11 reads as ActiveStrong: when in doubt, warn.
func CheckActive() (ActiveLevel, error) {
	if HasActiveLevel != nil {
		l, err := HasActiveLevel()
		if err != nil {
			return ActiveNone, err
		}
		return l.normalize(), nil
	}
	active, err := HasActiveBlocks()
	if err != nil {
		return ActiveNone, err
	}
	if active {
		return ActiveNormal, nil
	}
	return ActiveNone, nil
}

func (l ActiveLevel) normalize() ActiveLevel {
	switch l {
	case ActiveNone, ActiveNormal, ActiveStrong:
		return l
	}
	return ActiveStrong
}

// Active reports whether any block is active.
func (l ActiveLevel) Active() bool { return l.normalize() != ActiveNone }

// ExitCode is the process exit code of has-active: 0, 10 or 11.
func (l ActiveLevel) ExitCode() int { return int(l.normalize()) }

// String is "none", "normal" or "strong", for the JSON has-active prints.
func (l ActiveLevel) String() string {
	switch l.normalize() {
	case ActiveNone:
		return "none"
	case ActiveNormal:
		return "normal"
	}
	return "strong"
}
