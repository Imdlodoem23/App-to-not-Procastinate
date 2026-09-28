package clock

import "time"

// Calibration schedule (docs/ARCHITECTURE.md §10.2). These values are not in
// the generated contract data (guardian/internal/embedded), so they live here.
const (
	// CalibrateAfterBoot is when the first network time check runs after
	// boot or resume (a reboot restore calibrates at once instead).
	CalibrateAfterBoot = 60 * time.Second
	// CalibrateAfterJump is when a check runs after a wall-clock jump.
	CalibrateAfterJump = 10 * time.Second
	// CalibrateEvery is the period of checks once one succeeded.
	CalibrateEvery = 30 * time.Minute
	// CalibrateRetryMin and CalibrateRetryMax bound the backoff after a
	// failed check: 15 s, 30 s, 1 min, 2 min, 4 min, then every 5 min.
	CalibrateRetryMin = 15 * time.Second
	CalibrateRetryMax = 5 * time.Minute
	// BootHoldMax is the longest a new boot holds completions the reboot
	// crossed while it waits for the first check to answer.
	BootHoldMax = 120 * time.Second
)

// Backoff yields the delays before retrying a failed network time check:
// Min, then doubling up to Max (CalibrateRetryMin and CalibrateRetryMax when
// zero). The zero value is ready to use. It is not safe for concurrent use:
// the engine goroutine owns it.
type Backoff struct {
	Min, Max time.Duration
	next     time.Duration
	failures int
}

// Next records one more failure and returns how long to wait before the next
// attempt.
func (b *Backoff) Next() time.Duration {
	lo, hi := b.Min, b.Max
	if lo <= 0 {
		lo = CalibrateRetryMin
	}
	if hi < lo {
		hi = max(CalibrateRetryMax, lo)
	}
	d := min(max(b.next, lo), hi)
	b.next = min(2*d, hi)
	b.failures++
	return d
}

// Reset forgets the failures (after a check that answered).
func (b *Backoff) Reset() { b.next, b.failures = 0, 0 }

// Failures is the number of Next calls since the last Reset.
func (b *Backoff) Failures() int { return b.failures }

// RestoreJump is the restore jump of a reboot (RestoreResult.Restore): the
// trusted clock had reached SavedT when the last snapshot was taken and
// restarted at RestoredT after the reboot. Both are trusted times. The engine
// persists it (it marshals to JSON) until a calibration resolves it
// (docs/ARCHITECTURE.md §4, §10.2):
//
//   - Crossed: a block or punishment completed without a verified clock
//     whose trusted endsAt lies in (SavedT, RestoredT] may have been ended by
//     the restore alone; a calibration that moves T back reactivates it when
//     its endsAt is still after the corrected T.
//   - RanAhead / Shift: when the calibration moves T back by Correction,
//     every trusted deadline created at or after RestoredT (block startsAt,
//     endsAt and originalEndsAt, allowance startedAt and endsAt) moves back by
//     the same amount in the same batch, so something created while T ran
//     ahead lasts exactly what it promised, never Correction longer.
type RestoreJump struct {
	SavedT    time.Time `json:"savedT"`
	RestoredT time.Time `json:"restoredT"`
}

// IsZero reports whether there is no restore jump.
func (j RestoreJump) IsZero() bool { return j.RestoredT.IsZero() }

// Crossed reports whether deadline lies in (SavedT, RestoredT]: a completion
// at that deadline may have been caused by the restore jump alone.
func (j RestoreJump) Crossed(deadline time.Time) bool {
	return !j.IsZero() && deadline.After(j.SavedT) && !deadline.After(j.RestoredT)
}

// RanAhead reports whether something created at createdAt was created in the
// frame of the restore (at or after RestoredT), and so must move back with a
// calibration Correction.
func (j RestoreJump) RanAhead(createdAt time.Time) bool {
	return !j.IsZero() && !createdAt.Before(j.RestoredT)
}

// Shift returns t moved back by correction when createdAt (the creation time
// of what t belongs to) RanAhead, and t unchanged otherwise or when
// correction is not positive.
func (j RestoreJump) Shift(createdAt, t time.Time, correction time.Duration) time.Time {
	if correction <= 0 || !j.RanAhead(createdAt) {
		return t
	}
	return t.Add(-correction)
}
