package engine

import (
	"context"
	"slices"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/clock"
)

// Clock handling (§4, §10.2): tick jumps, calibration against network time, the
// correction of deadlines created while the trusted clock ran ahead, resurrection of
// completions a restore jump crossed, and the boot hold.

// calibration is the (in-memory) calibration schedule.
type calibration struct {
	// dueBoot is the boot-clock reading at which the next calibration runs.
	dueBoot  time.Duration
	backoff  time.Duration
	inFlight bool
	// answered: a calibration succeeded (agreement or disagreement) this run.
	answered bool
	last     *CalibrationInfo
	// creditDowntime: pending settings may be credited the verified downtime once.
	creditDowntime bool
	// stopT is the trusted time the previous run stopped at (downtime credit).
	stopT int64
}

// bootHold keeps completions the reboot crossed until a time check answers (§10.2).
type bootHold struct {
	savedT    int64
	untilBoot time.Duration
}

// trust is the clockTrust stamped on completions and events.
func (e *Engine) trust() string {
	if !e.state.Settings.ServerTimeCheck {
		return TrustDisabled
	}
	if e.state.Clock.Trust == TrustVerified && e.state.Clock.TrustBootID == e.bootID {
		return TrustVerified
	}
	return TrustUnverified
}

// onTickJump handles a wall-clock jump the detector saw while running (§10.2 Tick).
func (e *Engine) onTickJump(j clock.JumpResult) {
	b := e.newBatch()
	b.add(EvClockJump, ClockJumpData{
		Source:              "tick",
		DeltaMs:             j.Delta.Milliseconds(),
		WallOffsetMs:        e.wallOffsetMs(),
		Trust:               e.trust(),
		ReactivatedBlockIDs: []string{},
		ShiftedBlockIDs:     []string{},
		ShiftedAllowanceIDs: []string{},
	})
	e.commitNow(b, "clock_jump")
	e.bumpState()
	e.bumpExtRules()
	e.enfDirty = true
	e.scheduleCalibration(e.bootNow + calibrateAfterJump)
}

// scheduleCalibration moves the next calibration earlier to at (boot clock).
func (e *Engine) scheduleCalibration(at time.Duration) {
	if e.cal.dueBoot == 0 || at < e.cal.dueBoot {
		e.cal.dueBoot = at
	}
}

// maybeCalibrate starts a due calibration: asynchronously on the loop (the result
// comes back as a command), synchronously inline (tests, and POST /v1/_test/clock so a
// fake-clock run stays deterministic).
//
// The answer describes the moment NetworkNow returned; it is applied later, after the
// engine finished whatever turn it was in (a long test advance, a suspend in between).
// The boot-clock time since then is added to it, so the comparison with T is made at
// one instant: otherwise the delay would read as T running ahead and move it back.
func (e *Engine) maybeCalibrate() {
	if !e.state.Settings.ServerTimeCheck || e.cal.inFlight || e.bootNow < e.cal.dueBoot {
		return
	}
	e.cal.inFlight = true
	nt := e.o.NetworkTime
	clk := e.o.Clock
	trusted := e.det.EffectiveNow
	if !e.loopMode || e.inlineCalibration {
		ctx, cancel := context.WithTimeout(context.Background(), calibrateTimeout)
		ref, ok := nt.NetworkNow(ctx, trusted)
		sampled := clk.Boot()
		cancel()
		e.readClocks()
		e.now = e.trustedNowMs()
		e.onCalibration(answerNow(ref, ok, e.bootNow-sampled), ok)
		return
	}
	e.lifeMu.Lock()
	parent := e.loopCtx
	e.lifeMu.Unlock()
	if parent == nil {
		parent = context.Background()
	}
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		ctx, cancel := context.WithTimeout(parent, calibrateTimeout)
		ref, ok := nt.NetworkNow(ctx, trusted)
		sampled := clk.Boot()
		cancel()
		_ = e.exec(context.Background(), func() {
			if e.opened {
				e.readClocks()
				e.now = e.trustedNowMs()
				e.onCalibration(answerNow(ref, ok, e.bootNow-sampled), ok)
				e.afterTurn()
			}
		})
	}()
}

// answerNow moves a network time answer by the boot-clock time elapsed since it was
// received (never back), so it describes the moment it is applied.
func answerNow(ref time.Time, ok bool, elapsed time.Duration) time.Time {
	if !ok || elapsed <= 0 {
		return ref
	}
	return ref.Add(elapsed)
}

// onCalibration applies a calibration answer (§10.2 Calibration and Correction).
func (e *Engine) onCalibration(ref time.Time, ok bool) {
	e.cal.inFlight = false
	if !ok {
		// A failed check does not release the boot hold early: completions the reboot
		// crossed stay enforced until a check answers or bootHoldMax passes (stricter
		// than releasing on "offline", so a block never ends early because the network
		// was not up yet at boot).
		e.cal.backoff = min(max(e.cal.backoff*2, calibrateBackoffMin), calibrateBackoffMax)
		e.cal.dueBoot = e.bootNow + e.cal.backoff
		e.cal.last = &CalibrationInfo{At: e.display(e.now), OK: false, DeltaMs: 0, Sources: 0}
		e.enfDirty = true
		return
	}
	e.cal.answered = true
	e.hold = nil
	e.cal.backoff = 0
	e.cal.dueBoot = e.bootNow + calibrateEvery
	if j := e.det.Tick(); j.Jumped() {
		e.now = e.trustedNowMs()
		e.onTickJump(j)
	}
	r := e.det.Calibrate(ref)
	corr := r.Delta.Milliseconds() // > 0: T moved back by corr
	e.now = e.trustedNowMs()
	if corr > 0 {
		e.prevT = min(e.prevT, e.now)
		e.correctAfterCalibration(corr)
	}
	e.state.Clock.Trust = TrustVerified
	e.state.Clock.TrustBootID = e.bootID
	e.state.Clock.LastCalibratedAt = ptr(e.now)
	e.cal.last = &CalibrationInfo{At: e.display(e.now), OK: true, DeltaMs: -corr, Sources: 2}
	if e.cal.creditDowntime {
		e.cal.creditDowntime = false
		uptime := (e.bootNow - e.startBoot).Milliseconds()
		if gap := ref.UnixMilli() - uptime - e.cal.stopT; gap > 0 {
			e.creditVerifiedDowntime(gap)
			e.limitsCreditVerifiedDowntime(gap)
		}
	}
	e.state.Clock.Restore = nil
	e.state.Clock.Unverified = nil
	e.bumpState()
	e.enfDirty = true
	e.markDirty(true)
}

// correctAfterCalibration writes the correction batch when a calibration moved T back
// by corr ms: block_reactivated for completions the restore jump crossed whose end is
// still ahead, the shift of deadlines created while T ran ahead, and clock_jump
// {calibrate} last (§4, §10.2).
func (e *Engine) correctAfterCalibration(corr int64) {
	T := e.now
	b := e.newBatch()
	reactivated := []string{}
	cands := slices.Clone(e.state.Clock.Unverified)
	slices.SortFunc(cands, func(a, b unverifiedCompletion) int { return int(a.Seq - b.Seq) })
	for _, c := range cands {
		rec := e.block(c.BlockID)
		if rec == nil || rec.Status != StatusCompleted || c.EndsAt <= T {
			continue
		}
		b.add(EvBlockReactivated, BlockReactivatedData{
			BlockID: c.BlockID, RevertsSeq: c.Seq, RevertPoints: c.Points, EndsAt: fmtMs(c.EndsAt), Reason: "clock_correction",
		})
		reactivated = append(reactivated, c.BlockID)
	}
	shifted := []string{}
	allowances := []string{}
	if rj := e.state.Clock.Restore; rj != nil {
		for _, rec := range e.state.Blocks {
			if rec.Status == StatusActive && rec.CreatedAt >= rj.RestoredT {
				shifted = append(shifted, rec.ID)
			}
		}
		allowances = append(allowances, e.allowancesToShift(rj.RestoredT)...)
		e.forgetOccurrencesAfter(rj.RestoredT, T)
	}
	b.add(EvClockJump, ClockJumpData{
		Source:              "calibrate",
		DeltaMs:             corr,
		WallOffsetMs:        e.wallOffsetMs(),
		Trust:               TrustVerified,
		ReactivatedBlockIDs: reactivated,
		ShiftedBlockIDs:     shifted,
		ShiftedAllowanceIDs: allowances,
	})
	e.commitNow(b, "calibration correction")
	e.bumpExtRules()
}

// recordUnverifiedCompletion remembers a completion a restore jump crossed (§10.2
// Resurrection), bounded by unverifiedCompletionsMax: normal entries are evicted first,
// oldest first; hardcore, exam and punishment entries are never evicted.
func (e *Engine) recordUnverifiedCompletion(rec *blockRec, seq, pts int64, trust string) {
	rj := e.state.Clock.Restore
	if trust == TrustVerified || trust == TrustDisabled || rj == nil {
		return
	}
	if rec.EndsAt <= rj.SavedT || rec.EndsAt > rj.RestoredT {
		return
	}
	list := append(e.state.Clock.Unverified, unverifiedCompletion{
		BlockID: rec.ID, Seq: seq, EndsAt: rec.EndsAt, Points: pts, Kind: rec.Kind, Mode: rec.Mode,
	})
	maxN := limits().UnverifiedCompletionsMax
	for len(list) > maxN {
		i := slices.IndexFunc(list, func(u unverifiedCompletion) bool {
			return u.Kind != KindPunishment && u.Mode == ModeNormal
		})
		if i < 0 {
			i = slices.IndexFunc(list, func(u unverifiedCompletion) bool {
				return u.Kind != KindPunishment && u.Mode != ModeHardcore && u.Mode != ModeExam
			})
		}
		if i < 0 {
			break
		}
		list = slices.Delete(list, i, i+1)
	}
	e.state.Clock.Unverified = list
}

// held reports whether the boot hold keeps a block from completing now (§10.2).
func (e *Engine) held(rec *blockRec) bool {
	h := e.hold
	if h == nil {
		return false
	}
	if e.cal.answered || e.bootNow >= h.untilBoot {
		e.hold = nil
		return false
	}
	return rec.EndsAt > h.savedT && rec.EndsAt <= e.now
}

// bootHoldUntil is ClockStatus.bootHoldUntil (display time), or nil.
func (e *Engine) bootHoldUntil() *string {
	h := e.hold
	if h == nil || e.cal.answered || e.bootNow >= h.untilBoot {
		return nil
	}
	s := e.display(e.now + (h.untilBoot - e.bootNow).Milliseconds())
	return &s
}

// clockStatus is /v1/state.clock.
func (e *Engine) clockStatus() ClockStatus {
	cs := ClockStatus{
		WallOffsetMs:  e.wallOffsetMs(),
		Trust:         e.trust(),
		BootHoldUntil: e.bootHoldUntil(),
	}
	if lj := e.state.Clock.LastJump; lj != nil {
		cs.LastJump = &ClockJumpInfo{At: e.display(lj.AtMs), DeltaMs: lj.DeltaMs, Source: lj.Source}
	}
	cs.LastCalibratedAt = e.displayPtr(e.state.Clock.LastCalibratedAt)
	return cs
}
