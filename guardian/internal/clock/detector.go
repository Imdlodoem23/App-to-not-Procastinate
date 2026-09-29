package clock

import (
	"math"
	"sync"
	"time"
)

// Defaults applied by NewDetector to zero-valued Options fields.
const (
	// DefaultTolerance is how far the wall clock may disagree with the
	// monotonic clock before the difference is reported as a jump.
	DefaultTolerance = 60 * time.Second
	// DefaultSuspendThreshold is the shortest suspend that Tick reports.
	DefaultSuspendThreshold = 2 * time.Second
	// DefaultMaxSlew is the fastest rate (0.1 %: 3.6 s per hour) at which the
	// trusted clock follows small wall-clock corrections.
	DefaultMaxSlew = 0.001
)

// minPlausibleTime rejects references that cannot be the current time (a zero
// time.Time, a server with a broken clock): the project did not exist before.
var minPlausibleTime = time.Date(2025, time.January, 1, 0, 0, 0, 0, time.UTC)

// maxSnapshotSkew is how far a snapshot's trusted time may disagree with the
// rest of the evidence before Restore considers the snapshot corrupt.
const maxSnapshotSkew = 366 * 24 * time.Hour

// Options configures a Detector. Every source is injectable so tests can drive
// the clocks by hand; zero values select the real clocks and the defaults.
type Options struct {
	// Wall reads the system wall clock. Default: time.Now. Any monotonic
	// reading the returned time carries is stripped: only the wall value counts.
	Wall func() time.Time
	// Mono reads a monotonic clock that keeps counting during suspend and that
	// nobody can step. Default: BootTime.
	Mono func() time.Duration
	// Awake reads a monotonic clock that stops during suspend; it is only used
	// to measure suspends. Default: AwakeTime.
	Awake func() time.Duration
	// BootID identifies the current boot. It is called once, by NewDetector.
	// Default: BootID. An error or an invalid value means "unknown".
	BootID func() (string, error)
	// Tolerance: a disagreement between the wall clock and Mono larger than
	// this (strictly) is a jump. Values <= 0 select DefaultTolerance.
	Tolerance time.Duration
	// SuspendThreshold: suspends longer than this (strictly) are reported.
	// Values <= 0 select DefaultSuspendThreshold.
	SuspendThreshold time.Duration
	// MaxSlew bounds how fast the trusted clock follows disagreements smaller
	// than Tolerance, as a fraction of the Mono time elapsed. 0 selects
	// DefaultMaxSlew; a negative value disables following altogether.
	MaxSlew float64
}

// JumpResult is what the detector observed since the previous reading.
type JumpResult struct {
	// Delta is the signed amount by which the wall clock was moved relative to
	// real time: +2h when someone moves the clock two hours forward, −1h when
	// one hour back. It is zero unless the move exceeds the tolerance. Deadlines
	// compared with EffectiveNow need no change; a deadline expressed in the
	// machine's wall clock must have Delta added to keep pointing at the same
	// real instant. Delta is already included in WallOffset.
	Delta time.Duration
	// Forward is true when Delta > 0.
	Forward bool
	// Suspended is true when the machine slept for more than the suspend
	// threshold since the previous reading.
	Suspended bool
	// SuspendedFor is how long the machine slept (set when Suspended).
	SuspendedFor time.Duration
	// Elapsed is the real time since the previous reading, suspend included.
	Elapsed time.Duration
	// Reset is true when Mono went backwards, which no supported clock does
	// within one boot. The detector then keeps EffectiveNow where it was and
	// resumes from the new reading; the time since the previous tick is lost.
	Reset bool
	// TrustedShift is how far Resync moved EffectiveNow forward because the
	// reference showed it lagging real time by more than the tolerance (after
	// a reboot the trusted clock can restart behind; see Restore). It is zero
	// in every other result. WallOffset drops by the same amount, so the
	// wall clock is not reported as moved.
	//
	// The caller must add TrustedShift to every pending deadline it keeps in
	// trusted time, inside the lock that guards its expiry checks: remaining
	// durations and display times (deadline + WallOffset) then stay exactly
	// as they were and no deadline is reached earlier than before. A deadline
	// set before the lag appeared ends later than promised by at most the
	// lag, as it already would have without Resync.
	TrustedShift time.Duration
	// Correction is how far Calibrate (or Resync) moved EffectiveNow back
	// because it ran ahead of the reference by more than the tolerance; zero
	// in every other result. It is also part of Delta (and of WallOffset),
	// which may additionally hold a jump the same call's Tick saw.
	//
	// When the trusted clock ran ahead because a reboot restore trusted a
	// wall clock that was ahead, the caller moves back by Correction every
	// trusted deadline created at or after the restore, in the same batch
	// (docs/ARCHITECTURE.md §4; see RestoreJump.Shift), so a block or an
	// allowance created while T ran ahead lasts exactly what it promised.
	Correction time.Duration
}

// Jumped reports whether a wall-clock jump was detected.
func (r JumpResult) Jumped() bool { return r.Delta != 0 }

// Snapshot is the detector state worth persisting across restarts of the
// guardian. It marshals to JSON; durations are in nanoseconds.
type Snapshot struct {
	// Wall is the system wall clock (UTC) when the snapshot was taken.
	Wall time.Time `json:"wall"`
	// Trusted is EffectiveNow when the snapshot was taken.
	Trusted time.Time `json:"trusted"`
	// Offset is WallOffset when the snapshot was taken. It is kept apart from
	// Wall − Trusted so a jump not yet reported is still reported on Restore.
	Offset time.Duration `json:"offsetNs"`
	// Boot is the Mono reading when the snapshot was taken.
	Boot time.Duration `json:"bootNs"`
	// BootID identifies the boot the snapshot was taken in; empty if unknown.
	BootID string `json:"bootId"`
}

// SameBoot reports whether cur was taken in the same boot as prev, so that
// their Mono readings are comparable. prev must not be empty, both boot
// identifiers must be known and Mono must not have gone backwards (a negative
// saved reading, which no clock produces, is corrupt). Then, if
// either identifier comes from a fallback source (prefix "derived:" or
// "boottime:"), whose value a clock change can alter within one boot, that
// Mono continuity alone decides; otherwise the identifiers must be equal.
// Unknown identifiers count as a different boot.
//
// The fallback rule leans towards "same boot" on purpose. A wrong "same boot"
// after a real reboot only makes the trusted clock lag (Mono restarted from
// zero, so less time is counted than really passed): blocks last longer. A
// wrong "different boot" would accept a clock change made while the guardian
// was stopped: blocks could end early.
func SameBoot(prev, cur Snapshot) bool {
	if prev.BootID == "" || cur.BootID == "" || prev.Trusted.IsZero() || prev.Boot < 0 || cur.Boot < prev.Boot {
		return false
	}
	if isFallbackID(prev.BootID) || isFallbackID(cur.BootID) {
		return true
	}
	return prev.BootID == cur.BootID
}

// RestoreResult describes how a saved Snapshot relates to the present.
type RestoreResult struct {
	// SameBoot is true when monotonic continuity was kept since the snapshot.
	SameBoot bool
	// Downtime is the real time since the snapshot (only when SameBoot).
	Downtime time.Duration
	// Jump holds any wall-clock jump made while the guardian was not running
	// (only when SameBoot). Suspend during the downtime is not measured.
	Jump JumpResult
	// WallBehind is true when, after a reboot, the wall clock (also once
	// corrected by the saved offset) read earlier than the saved trusted time
	// by more than the tolerance, which a correct clock cannot do (dead CMOS
	// battery, clock set back while the machine was off). EffectiveNow then
	// resumed from the saved trusted time.
	WallBehind bool
	// Discarded is true when the snapshot was rejected as corrupt, and the
	// detector started afresh from the wall clock as if there were no
	// snapshot. That happens only when its trusted time is implausible
	// (before 2025, or more than a year ahead of the wall clock both as read
	// and as corrected by the saved offset) and also contradicts the
	// snapshot's own wall clock and offset by more than a year. A snapshot
	// that is consistent with itself is always used, however odd.
	Discarded bool
	// Restore is the restore jump of a reboot (set when the snapshot was used
	// and SameBoot is false): the trusted clock had reached SavedT when the
	// snapshot was taken and restarted at RestoredT. Persist it until a
	// calibration resolves it (docs/ARCHITECTURE.md §4, §10.2): blocks
	// completed with an endsAt in (SavedT, RestoredT] may be resurrected, and
	// deadlines created at or after RestoredT move back with a Correction.
	Restore RestoreJump
}

// Detector tracks a trusted clock that wall-clock changes cannot move and
// reports those changes, as described in the package documentation. It is
// safe for concurrent use.
type Detector struct {
	wall       func() time.Time
	mono       func() time.Duration
	awake      func() time.Duration
	bootID     string
	tol        time.Duration
	suspendMin time.Duration
	maxSlew    float64

	mu         sync.Mutex
	baseWall   time.Time     // T at baseMono
	baseMono   time.Duration // Mono reading that anchors T
	off        time.Duration // W: sum of reported jumps
	lastMono   time.Duration
	lastAwake  time.Duration
	awakeKnown bool // lastAwake belongs to the same timeline as lastMono
}

// NewDetector reads every source once and anchors the trusted clock on the
// current wall clock. Call Restore next when a saved Snapshot exists.
func NewDetector(opts Options) *Detector {
	d := &Detector{
		wall:       opts.Wall,
		mono:       opts.Mono,
		awake:      opts.Awake,
		tol:        opts.Tolerance,
		suspendMin: opts.SuspendThreshold,
		maxSlew:    opts.MaxSlew,
	}
	if d.wall == nil {
		d.wall = time.Now
	}
	if d.mono == nil {
		d.mono = BootTime
	}
	if d.awake == nil {
		d.awake = AwakeTime
	}
	if d.tol <= 0 {
		d.tol = DefaultTolerance
	}
	if d.suspendMin <= 0 {
		d.suspendMin = DefaultSuspendThreshold
	}
	if d.maxSlew == 0 {
		d.maxSlew = DefaultMaxSlew
	}
	idFn := opts.BootID
	if idFn == nil {
		idFn = BootID
	}
	if id, err := idFn(); err == nil && validID(id) {
		d.bootID = id
	}
	d.anchor(d.read())
	return d
}

// Tick compares how far the wall clock and Mono advanced since the trusted
// clock was last consistent with the wall clock, and reports jumps and
// suspends. Call it every few seconds.
func (d *Detector) Tick() JumpResult {
	d.mu.Lock()
	defer d.mu.Unlock()
	w, m, a := d.read()
	return d.advance(w, m, a)
}

// EffectiveNow returns the trusted current time (UTC): the wall clock as it
// was when the detector was anchored, advanced by Mono since then. Changing
// the system clock does not move it; see the package documentation.
func (d *Detector) EffectiveNow() time.Time {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.trusted(max(d.mono(), d.lastMono))
}

// WallOffset returns how far the system wall clock is believed to be from
// EffectiveNow: the signed sum of every Delta reported (Calibrate and Resync
// corrections included), minus every TrustedShift. endsAt.Add(WallOffset())
// is when a deadline will be reached according to the machine's clock.
func (d *Detector) WallOffset() time.Duration {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.off
}

// Snapshot captures the state to persist so that Restore can resume it after
// the guardian restarts.
func (d *Detector) Snapshot() Snapshot {
	d.mu.Lock()
	defer d.mu.Unlock()
	w := stripWall(d.wall())
	m := max(d.mono(), d.lastMono)
	return Snapshot{Wall: w, Trusted: d.trusted(m), Offset: d.off, Boot: m, BootID: d.bootID}
}

// Restore resumes from a Snapshot saved by a previous run of the guardian.
//
// Same boot: the trusted clock continues exactly from the snapshot (Trusted
// plus the Mono time since), the saved offset is kept, and a wall-clock jump
// made meanwhile is reported in RestoreResult.Jump.
//
// Different boot (or unknown boot identifiers): monotonic continuity is lost,
// so the trusted clock restarts from the earlier of the wall clock and the
// wall clock minus the saved Offset, and never below the saved Trusted time.
// WallOffset becomes the wall clock minus that value. Nothing is reported as
// a jump. The trusted clock may then lag real time; Resync corrects that.
//
// A zero Snapshot behaves like a fresh start, and so does a corrupt one
// (RestoreResult.Discarded).
func (d *Detector) Restore(prev Snapshot) RestoreResult {
	d.mu.Lock()
	defer d.mu.Unlock()
	w, m, a := d.read()
	prev.Wall, prev.Trusted = stripWall(prev.Wall), stripWall(prev.Trusted)
	if prev.Trusted.IsZero() || corruptSnapshot(prev, w) {
		d.anchor(w, m, a)
		return RestoreResult{Discarded: !prev.Trusted.IsZero()}
	}
	if SameBoot(prev, Snapshot{Boot: m, BootID: d.bootID}) {
		d.baseWall, d.baseMono, d.off = prev.Trusted, prev.Boot, prev.Offset
		d.lastMono, d.awakeKnown = prev.Boot, false
		j := d.advance(w, m, a)
		return RestoreResult{SameBoot: true, Downtime: j.Elapsed, Jump: j}
	}

	// Two readings of "now" are possible: the wall clock as it is, or corrected
	// by the saved offset (right if the clock is still as wrong as it was).
	// Either may be wrong if the clock was changed while nothing watched it;
	// the earlier one is chosen because a trusted clock that is behind only
	// makes blocks last longer, while one that is ahead would end them early.
	var res RestoreResult
	t := w
	if c := w.Add(negSat(prev.Offset)); c.Before(t) {
		t = c
	}
	if t.Before(prev.Trusted) {
		res.WallBehind = prev.Trusted.Sub(t) > d.tol
		t = prev.Trusted
	}
	d.baseWall, d.baseMono, d.off = t, m, w.Sub(t)
	d.lastMono, d.lastAwake, d.awakeKnown = m, a, true
	res.Restore = RestoreJump{SavedT: prev.Trusted, RestoredT: t}
	return res
}

// corruptSnapshot reports whether s cannot be a snapshot this package wrote
// on a working machine, given the wall clock w at restore time. Its trusted
// time must be implausible: before minPlausibleTime (the project did not
// exist), or more than maxSnapshotSkew ahead of both w and w − Offset (using
// it would push EffectiveNow years ahead and end every block at once). And it
// must also contradict the snapshot's own wall clock and offset: a detector
// keeps Trusted + Offset within the tolerance of the wall clock, except for a
// jump made after its last Tick.
//
// The second condition keeps real snapshots whose timeline is merely odd: a
// dead CMOS battery that resets the clock to a firmware date more than a year
// back, or a trusted clock that was first anchored on a wrong wall clock. The
// first condition means a discarded snapshot can only move EffectiveNow back
// (blocks last longer) or away from a date before 2025.
func corruptSnapshot(s Snapshot, w time.Time) bool {
	limit := s.Trusted.Add(-maxSnapshotSkew)
	implausible := s.Trusted.Before(minPlausibleTime) ||
		(w.Before(limit) && w.Add(negSat(s.Offset)).Before(limit))
	if !implausible {
		return false
	}
	own := s.Wall.Add(negSat(s.Offset))
	return s.Trusted.Sub(own).Abs() > maxSnapshotSkew
}

// Calibrate compares the trusted clock with an external reference, typically
// NetworkTime. It first performs a Tick. Then, if EffectiveNow is ahead of ref
// by more than the tolerance (the wall clock was moved forward while nothing
// could observe it, for instance with the machine off), it moves the trusted
// clock back to ref and reports that correction as a forward jump in the
// returned Delta (it also joins WallOffset). Blocks then last until their
// promised real moment instead of ending early.
//
// It never moves the trusted clock forward: a block created while the trusted
// clock was behind would otherwise end early. A lag left by Restore after a
// reboot therefore stays; Resync corrects it for callers that shift their
// deadlines. References before 2025 are ignored.
func (d *Detector) Calibrate(ref time.Time) JumpResult { return d.calibrate(ref, false) }

// Resync is Calibrate that also corrects a trusted clock that lags ref by
// more than the tolerance: EffectiveNow moves forward to ref, WallOffset drops
// by as much (so the wall clock is not reported as moved), and the returned
// TrustedShift tells the caller to add that amount to every pending deadline
// (see JumpResult.TrustedShift). A lag appears when Restore, after a reboot,
// cannot tell a wrong clock from one put right while the machine was off
// (it picks the earlier reading), when the wall clock read earlier than the
// saved trusted time (dead CMOS battery), or when the detector was first
// anchored on a clock that was behind. Without Resync that lag would last
// forever, and recurring schedules evaluated against EffectiveNow would stay
// shifted by it.
//
// Use it only with a reference that is hard to fake (NetworkTime requires
// two agreeing HTTPS sources). References before 2025 are ignored.
func (d *Detector) Resync(ref time.Time) JumpResult { return d.calibrate(ref, true) }

// calibrate implements Calibrate and, with forward set, Resync.
func (d *Detector) calibrate(ref time.Time, forward bool) JumpResult {
	d.mu.Lock()
	defer d.mu.Unlock()
	w, m, a := d.read()
	r := d.advance(w, m, a)
	ref = stripWall(ref)
	if ref.Before(minPlausibleTime) {
		return r
	}
	gap := ref.Sub(d.trusted(m)) // > 0: the trusted clock is behind ref
	if gap >= -d.tol && (!forward || gap <= d.tol) {
		return r
	}
	// T becomes ref and T + W, what the wall clock should read, is unchanged.
	d.baseWall = d.baseWall.Add(gap)
	d.off = addSat(d.off, negSat(gap))
	if gap < 0 {
		r.Delta = addSat(r.Delta, negSat(gap))
		r.Forward = r.Delta > 0
		r.Correction = negSat(gap)
	} else {
		r.TrustedShift = gap
	}
	return r
}

// advance applies one reading. The caller holds d.mu.
func (d *Detector) advance(w time.Time, m, a time.Duration) JumpResult {
	var r JumpResult
	dm := m - d.lastMono
	if dm < 0 {
		d.baseWall, d.baseMono = d.trusted(d.lastMono), m
		d.lastMono, d.lastAwake, d.awakeKnown = m, a, true
		r.Reset = true
		return r
	}
	r.Elapsed = dm
	if d.awakeKnown {
		if s := dm - (a - d.lastAwake); s > d.suspendMin {
			r.Suspended, r.SuspendedFor = true, s
		}
	}
	diff := w.Sub(d.trusted(m).Add(d.off))
	switch {
	case diff > d.tol || diff < -d.tol:
		// Report what W actually absorbs: all of diff, except when W is at
		// the limit of time.Duration (a wall clock centuries away).
		off := addSat(d.off, diff)
		r.Delta, r.Forward = off-d.off, off > d.off
		d.off = off
	case diff != 0 && d.maxSlew > 0:
		limit := time.Duration(float64(dm) * d.maxSlew)
		d.baseWall = d.baseWall.Add(min(max(diff, -limit), limit))
	}
	d.lastMono, d.lastAwake, d.awakeKnown = m, a, true
	return r
}

// anchor restarts the trusted clock on wall reading w, with no offset, as a
// fresh detector does. The caller holds d.mu (or is the constructor).
func (d *Detector) anchor(w time.Time, m, a time.Duration) {
	d.baseWall, d.baseMono, d.off = w, m, 0
	d.lastMono, d.lastAwake, d.awakeKnown = m, a, true
}

// read takes one reading of every source. The caller holds d.mu (or is the
// constructor).
func (d *Detector) read() (time.Time, time.Duration, time.Duration) {
	return stripWall(d.wall()), d.mono(), d.awake()
}

// trusted returns T for Mono reading m. The caller holds d.mu.
func (d *Detector) trusted(m time.Duration) time.Time {
	return d.baseWall.Add(m - d.baseMono)
}

// stripWall drops the monotonic reading of t (so that Sub compares wall
// values, not Go's monotonic clock) and normalises it to UTC.
func stripWall(t time.Time) time.Time { return t.Round(0).UTC() }

// addSat returns a + b, clamped to the range of time.Duration instead of
// wrapping around (an offset near the limits must not flip sign).
func addSat(a, b time.Duration) time.Duration {
	sum := a + b
	switch {
	case a > 0 && b > 0 && sum < 0:
		return math.MaxInt64
	case a < 0 && b < 0 && sum >= 0:
		return math.MinInt64
	}
	return sum
}

// negSat returns −a; −MinInt64, which does not fit, becomes MaxInt64.
func negSat(a time.Duration) time.Duration {
	if a == math.MinInt64 {
		return math.MaxInt64
	}
	return -a
}
