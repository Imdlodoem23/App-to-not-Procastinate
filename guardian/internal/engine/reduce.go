package engine

import (
	"encoding/json"
	"fmt"
	"slices"

	"github.com/imdlodoem23/centrate/guardian/internal/points"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// The reducer: the only code that changes engineState from events. The live path
// (commit) and recovery (replay of seq > state.lastEventSeq, §10.12 step 6) both apply
// every event through applyEvent, so the two can never disagree. Reducers never emit
// events and never touch enforcement; they only change memory.

// storeEvent is a committed event (the feature files' reducers take it).
type storeEvent = store.Event

// applyEvent applies one committed event: its recorded ledger deltas, then its effect on
// the entities. Feature events go to the reducers of the feature files.
func (e *Engine) applyEvent(ev *store.Event) error {
	e.applyLedger(ev)
	var err error
	switch ev.Type {
	case EvGuardianStarted, EvProcessClosed, EvDayClosed, EvTamperDetected, EvLedgerRepaired:
		// Ledger only (or nothing).
	case EvEpochStarted:
		err = e.applyEpochStarted(ev)
	case EvClockJump:
		err = e.applyClockJump(ev)
	case EvBlockCreated:
		err = e.applyBlockCreated(ev)
	case EvBlockExtended:
		err = e.applyBlockExtended(ev)
	case EvBlockCompleted:
		err = e.applyBlockCompleted(ev)
	case EvBlockCancelled:
		err = e.applyBlockCancelled(ev)
	case EvBlockReactivated:
		err = e.applyBlockReactivated(ev)
	case EvPunishmentStarted:
		err = e.applyPunishmentStarted(ev)
	case EvPunishmentEnded:
		err = e.applyPunishmentEnded(ev)
	case EvAttempt:
		err = e.applyAttempt(ev)
	case EvStudyStarted:
		err = e.applyStudyStarted(ev)
	case EvStudyPaused:
		err = e.applyStudyPaused(ev)
	case EvStudyResumed:
		err = e.applyStudyResumed(ev)
	case EvFocusMinutes:
		err = e.applyFocusMinutes(ev)
	case EvStrike:
		err = e.applyStrike(ev)
	case EvStudyEnded:
		err = e.applyStudyEnded(ev)
	case EvStudyOutcome:
		err = e.applyStudyOutcome(ev)
	case EvEmergencyRequested:
		err = e.applyEmergencyRequested(ev)
	case EvEmergencyCancelled:
		err = e.applyEmergencyCancelled(ev)
	case EvEmergencyConfirmed:
		err = e.applyEmergencyConfirmed(ev)
	case EvRewardRedeemed:
		err = e.applyRewardRedeemed(ev)
	case EvRewardEnded:
		err = e.applyRewardEnded(ev)
	case EvScheduleCreated:
		err = e.applyScheduleCreated(ev)
	case EvScheduleUpdated:
		err = e.applyScheduleUpdated(ev)
	case EvScheduleDeleted:
		err = e.applyScheduleDeleted(ev)
	case EvSettingsChanged:
		err = e.applySettingsChanged(ev)
	case EvExtensionPaired:
		err = e.applyExtensionPaired(ev)
	case EvExtensionRevoked:
		err = e.applyExtensionRevoked(ev)
	default:
		// Unknown types (written by a newer guardian): recorded deltas only (§7.1).
	}
	e.advanceOpenDay(ev.Day)
	e.state.Epoch = ev.Epoch
	e.state.LastEventSeq = ev.Seq
	e.lastAppliedAt = atMs(ev)
	return err
}

// advanceOpenDay derives the open day from the log (§6.3), so a state rebuilt from the
// events still closes it at startup: the first day after the last closed one that has
// events. The live path keeps it at today already; a day whose day_closed failed stays
// open (closeDays retries it).
func (e *Engine) advanceOpenDay(day string) {
	if day == "" {
		return
	}
	lc := e.state.Ledger.LastClosedDay
	if lc != nil && day <= *lc {
		return
	}
	if open := e.state.OpenDay; open == "" || (lc != nil && open <= *lc) {
		e.state.OpenDay = day
	}
}

// applyLedger applies the recorded deltas and derives everything else, exactly like
// points.ReplayEvents does for one event (§6).
func (e *Engine) applyLedger(ev *store.Event) {
	pe := points.Event{Seq: ev.Seq, At: ev.At, Day: ev.Day, Type: ev.Type, Points: ev.Points, XP: ev.XP, Data: ev.Data}
	in, ok, _ := points.LedgerInputFromEvent(pe)
	l := &e.state.Ledger
	if !ok {
		l.Balance += ev.Points
		l.XP += ev.XP
		return
	}
	before := *l
	step := points.ApplyLedgerInput(before, in, points.DefaultPointRules())
	*l = step.State
	if in.Type == points.InputEpochStarted {
		l.Balance, l.XP = ev.Points, ev.XP
	} else {
		l.Balance, l.XP = before.Balance+ev.Points, before.XP+ev.XP
	}
}

// decode reads an event's data.
func decode[T any](ev *store.Event) (T, error) {
	var v T
	if err := json.Unmarshal(ev.Data, &v); err != nil {
		return v, fmt.Errorf("seq %d (%s): %w", ev.Seq, ev.Type, err)
	}
	return v, nil
}

// atMs is the event's trusted time.
func atMs(ev *store.Event) int64 {
	ms, _ := parseMs(ev.At)
	return ms
}

func (e *Engine) applyEpochStarted(ev *store.Event) error {
	d, err := decode[EpochStartedData](ev)
	if err != nil {
		return err
	}
	k := d.Kept
	e.state.Blocks = []*blockRec{}
	e.state.Punishments = []*punishmentRec{}
	e.state.Settings = k.Settings.Clone()
	for i := range k.Blocks {
		rec, err := e.recFromWire(k.Blocks[i])
		if err != nil {
			return err
		}
		e.state.Blocks = append(e.state.Blocks, rec)
	}
	for i := range k.Punishments {
		p, err := punishmentFromWire(k.Punishments[i])
		if err != nil {
			return err
		}
		e.state.Punishments = append(e.state.Punishments, p)
	}
	e.state.Study = studyState{}
	e.state.Emergency = emergencyState{}
	e.restoreKeptAllowances(k.Allowances)
	e.restoreKeptSchedules(k.Schedules, k.MaterializedOccurrences)
	e.restoreKeptPending(k.PendingSettings)
	e.lastCountKey = map[string]attemptMemo{}
	return nil
}

func (e *Engine) applyClockJump(ev *store.Event) error {
	d, err := decode[ClockJumpData](ev)
	if err != nil {
		return err
	}
	at := atMs(ev)
	if d.Source == "reboot" {
		// Every reboot restore is logged (restoreClock): the restore jump runs from the
		// last trace of the previous run (the event before it) to this start. Startup
		// replaces it with the exact snapshot time; a rebuild keeps this bound, which
		// can only widen the completions a calibration checks (§10.2).
		e.state.Clock.Restore = &restoreJump{SavedT: e.lastAppliedAt, RestoredT: at}
		if d.DeltaMs == 0 {
			return nil // a reboot without a wall-clock change is no jump
		}
	}
	e.state.Clock.LastJump = &jumpRec{AtMs: at, DeltaMs: d.DeltaMs, Source: d.Source}
	e.state.Clock.Jumps = append(e.state.Clock.Jumps, at)
	if d.Source != "calibrate" {
		return nil
	}
	// The correction resolves the restore jump and the unverified completions (the
	// block_reactivated events before it took theirs back): replayed after a crash that
	// lost state.json, it can never be applied twice (§10.2).
	e.state.Clock.Restore = nil
	e.state.Clock.Unverified = nil
	shift := -d.DeltaMs
	for _, id := range d.ShiftedBlockIDs {
		rec := e.block(id)
		if rec == nil {
			continue
		}
		rec.StartsAt += shift
		rec.EndsAt += shift
		rec.OriginalEndsAt += shift
		if rec.PunishmentID != nil {
			if p := e.punishment(*rec.PunishmentID); p != nil {
				p.StartsAt += shift
				p.EndsAt += shift
			}
		}
	}
	e.shiftAllowances(d.ShiftedAllowanceIDs, shift)
	return nil
}

// recFromWire builds a blockRec from a trusted-time Block snapshot and resolves it.
func (e *Engine) recFromWire(b Block) (*blockRec, error) {
	var times [4]int64
	for i, s := range []string{b.CreatedAt, b.StartsAt, b.EndsAt, b.OriginalEndsAt} {
		ms, ok := parseMs(s)
		if !ok {
			return nil, fmt.Errorf("block %s: invalid timestamp", b.ID)
		}
		times[i] = ms
	}
	rec := &blockRec{
		ID: b.ID, Kind: b.Kind, Mode: b.Mode, Status: b.Status,
		Targets: b.Targets.normalized(), WhitelistOnly: b.WhitelistOnly, Allow: b.Allow.normalized(), Reason: b.Reason,
		CreatedAt: times[0], StartsAt: times[1], EndsAt: times[2], OriginalEndsAt: times[3],
		ExtendedMinutes: b.ExtendedMinutes, ScheduleID: b.ScheduleID, PunishmentID: b.PunishmentID,
		AttemptsCounted: b.AttemptsCounted, PointsDelta: b.PointsDelta,
		Rank: e.state.NextRank,
	}
	if b.EndedAt != nil {
		if ms, ok := parseMs(*b.EndedAt); ok {
			rec.EndedAt = &ms
		}
	}
	e.state.NextRank++
	e.resolveBlock(rec)
	return rec, nil
}

func punishmentFromWire(p Punishment) (*punishmentRec, error) {
	s, ok1 := parseMs(p.StartsAt)
	en, ok2 := parseMs(p.EndsAt)
	if !ok1 || !ok2 {
		return nil, fmt.Errorf("punishment %s: invalid timestamp", p.ID)
	}
	r := &punishmentRec{ID: p.ID, BlockID: p.BlockID, SessionID: p.SessionID, Task: p.Task, Cause: p.Cause, Level: p.Level,
		Minutes: p.Minutes, StartsAt: s, EndsAt: en, Status: p.Status}
	if p.EndedAt != nil {
		if ms, ok := parseMs(*p.EndedAt); ok {
			r.EndedAt = &ms
		}
	}
	return r, nil
}

func (e *Engine) applyBlockCreated(ev *store.Event) error {
	d, err := decode[BlockCreatedData](ev)
	if err != nil {
		return err
	}
	if e.block(d.Block.ID) != nil {
		return fmt.Errorf("seq %d: block %s exists", ev.Seq, d.Block.ID)
	}
	rec, err := e.recFromWire(d.Block)
	if err != nil {
		return err
	}
	e.state.Blocks = append(e.state.Blocks, rec)
	if d.Source == "schedule" {
		e.markScheduleOccurrence(rec, atMs(ev))
	}
	return nil
}

// markScheduleOccurrence records the occurrence a schedule block materialized (the one
// of its schedule that contains the block's start and ends at its original end), so a
// state rebuilt from the log never materializes it again, even after an emergency
// cancelled the block (§10.3). The live path marks it too (schMark), with the same key.
func (e *Engine) markScheduleOccurrence(rec *blockRec, at int64) {
	if rec.ScheduleID == nil {
		return
	}
	s := e.schedule(*rec.ScheduleID)
	if s == nil {
		return
	}
	loc, ok := loadLocation(s.Timezone)
	if !ok {
		return
	}
	for _, occ := range schOccurrences(s, loc, rec.StartsAt, -1, 0) {
		if occ.End != rec.OriginalEndsAt || rec.StartsAt < occ.Start {
			continue
		}
		st := &e.state.Schedules
		if st.Materialized == nil {
			st.Materialized = map[string]schOccMark{}
		}
		if _, done := st.Materialized[occ.Key]; !done {
			st.Materialized[occ.Key] = schOccMark{At: at, StartsAt: occ.Start, EndsAt: occ.End}
		}
		return
	}
}

func (e *Engine) applyBlockExtended(ev *store.Event) error {
	d, err := decode[BlockExtendedData](ev)
	if err != nil {
		return err
	}
	rec := e.block(d.BlockID)
	ends, ok := parseMs(d.EndsAt)
	if rec == nil || !ok {
		return fmt.Errorf("seq %d: unknown block or bad endsAt", ev.Seq)
	}
	rec.EndsAt = ends
	rec.ExtendedMinutes += d.AddMinutes
	return nil
}

func (e *Engine) applyBlockCompleted(ev *store.Event) error {
	d, err := decode[BlockCompletedData](ev)
	if err != nil {
		return err
	}
	rec := e.block(d.BlockID)
	if rec == nil {
		return fmt.Errorf("seq %d: unknown block", ev.Seq)
	}
	rec.Status = StatusCompleted
	rec.EndedAt = ptr(rec.EndsAt)
	rec.PointsDelta = ptr(ev.Points)
	rec.CompletedSeq = ev.Seq
	e.recordUnverifiedCompletion(rec, ev.Seq, ev.Points, d.ClockTrust)
	return nil
}

func (e *Engine) applyBlockCancelled(ev *store.Event) error {
	d, err := decode[BlockCancelledData](ev)
	if err != nil {
		return err
	}
	rec := e.block(d.BlockID)
	if rec == nil {
		return fmt.Errorf("seq %d: unknown block", ev.Seq)
	}
	rec.Status = StatusCancelledEmergency
	rec.EndedAt = ptr(atMs(ev))
	rec.PointsDelta = ptr(int64(0))
	return nil
}

func (e *Engine) applyBlockReactivated(ev *store.Event) error {
	d, err := decode[BlockReactivatedData](ev)
	if err != nil {
		return err
	}
	rec := e.block(d.BlockID)
	if rec == nil {
		return fmt.Errorf("seq %d: unknown block", ev.Seq)
	}
	if ends, ok := parseMs(d.EndsAt); ok {
		rec.EndsAt = ends
	}
	rec.Status = StatusActive
	rec.EndedAt = nil
	rec.PointsDelta = nil
	rec.CompletedSeq = 0
	if rec.PunishmentID != nil {
		if p := e.punishment(*rec.PunishmentID); p != nil {
			p.Status = StatusActive
			p.EndedAt = nil
		}
	}
	e.state.Clock.Unverified = slices.DeleteFunc(e.state.Clock.Unverified, func(u unverifiedCompletion) bool { return u.BlockID == d.BlockID })
	return nil
}

func (e *Engine) applyPunishmentStarted(ev *store.Event) error {
	d, err := decode[PunishmentStartedData](ev)
	if err != nil {
		return err
	}
	p, err := punishmentFromWire(d.Punishment)
	if err != nil {
		return err
	}
	e.state.Punishments = append(e.state.Punishments, p)
	return nil
}

func (e *Engine) applyPunishmentEnded(ev *store.Event) error {
	d, err := decode[PunishmentEndedData](ev)
	if err != nil {
		return err
	}
	p := e.punishment(d.PunishmentID)
	if p == nil {
		return fmt.Errorf("seq %d: unknown punishment", ev.Seq)
	}
	if d.Outcome == "emergency" {
		p.Status = StatusCancelledEmergency
		p.EndedAt = ptr(atMs(ev))
	} else {
		p.Status = StatusCompleted
		end := p.EndsAt
		if rec := e.block(p.BlockID); rec != nil {
			end = rec.EndsAt
		}
		p.EndedAt = &end
	}
	return nil
}
