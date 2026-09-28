package engine

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
	"github.com/imdlodoem23/centrate/guardian/internal/clock"
	"github.com/imdlodoem23/centrate/guardian/internal/points"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// The startup and recovery ladder (§10.12). The store runs steps 1–7 (lock, stale
// temporary files, markers, key, state candidates, log verification, anchor) and
// reports; the engine turns the report into state, events and modes, restores the clock
// (step 8), prices a stop during a block (step 9), writes guardian_started and the
// day_closed catch-up (step 10) and reconciles enforcement before the API opens (11).

// startInfo is what the ladder learns about the previous run.
type startInfo struct {
	rep       store.RecoveryReport
	haveState bool
	snap      *clock.Snapshot
	sameBoot  bool
	rebooted  bool
	downtime  int64
	savedT    int64
	recovery  string
	// activeAtStop are the blocks that were active when the previous run stopped.
	activeAtStop []string
	// hostsAtStart is the section found at startup, before any reconcile.
	hostsAtStart  []string
	hostsReadable bool
}

func (e *Engine) startup() error {
	c := e.o.Clock
	st, rep, err := store.Open(e.o.DataDir, store.Options{
		Now:           c.Wall,
		BootTime:      c.Boot,
		BootID:        c.BootID,
		Anchor:        e.o.Anchor,
		FS:            e.o.StoreFS,
		SchemaVersion: e.o.SchemaVersion,
		Migrations:    e.o.Migrations,
	})
	if err != nil {
		return fmt.Errorf("engine: open the data directory: %w", err)
	}
	e.lifeMu.Lock()
	e.st = st
	e.lifeMu.Unlock()
	e.bootID, _ = c.BootID()
	e.det = clock.NewDetector(clock.Options{Wall: c.Wall, Mono: c.Boot, Awake: c.Awake, BootID: c.BootID})
	e.readClocks()
	e.startBoot = e.bootNow
	if restored, err := e.o.Hosts.Recover(); err != nil {
		e.log.Warn("hosts file damaged and not restorable", "err", err)
	} else if restored {
		e.log.Warn("hosts file restored from backup at startup")
	}
	// The section as the stop left it, before any reconcile rewrites it (step 9).
	hostsAtStart, hostsErr := e.o.Hosts.Current()

	if rep.Frozen {
		return e.startFrozen(rep)
	}
	if rep.SafeMode {
		e.mode = ModeGuardianSafe
	}
	if rep.Repair != nil {
		e.startProblems = append(e.startProblems, "ledger_repaired")
		e.integrity = "repaired"
	}
	if rep.AnchorCheck == store.AnchorRollback {
		e.startProblems = append(e.startProblems, "rollback_detected")
		e.integrity = "rollback"
	}

	si := startInfo{rep: rep, recovery: string(rep.Recovery), hostsAtStart: hostsAtStart, hostsReadable: hostsErr == nil}
	// Steps 5–6: the snapshot, then the events after it.
	var loaded engineState
	ls, lerr := st.LoadState(&loaded)
	switch {
	case lerr == nil:
		si.haveState = true
		loaded.normalize()
		e.state = loaded
		e.idem = ls.Idempotency
	case errors.Is(lerr, store.ErrNoState):
		if rep.NeedEpoch == "" {
			e.integrity = "rebuilt"
		}
	default:
		return fmt.Errorf("engine: load state: %w", lerr)
	}
	if rep.NeedEpoch == "" {
		from := rep.ReplayFrom
		if !si.haveState {
			from = 0
			e.state = newEngineState()
		}
		if err := e.replay(from); err != nil {
			return err
		}
	}

	// Step 8 (first half): restore the trusted clock, so every startup event carries the
	// right time.
	si.snap = e.loadClockSnapshot()
	if si.snap != nil {
		rr := e.det.Restore(*si.snap)
		si.sameBoot = rr.SameBoot
		si.rebooted = !rr.SameBoot
		si.savedT = si.snap.Trusted.UnixMilli()
		if rr.SameBoot {
			si.downtime = rr.Downtime.Milliseconds()
		}
		e.startClock()
		if rr.SameBoot && rr.Jump.Jumped() {
			e.pendingStartJump("restore", rr.Jump.Delta.Milliseconds())
		}
		if !rr.SameBoot && rr.WallBehind {
			e.pendingStartJump("reboot", e.wallOffsetMs()-si.snap.Offset.Milliseconds())
		}
	} else {
		e.startClock()
	}
	for _, b := range e.state.Blocks {
		if b.Status == StatusActive && si.snap != nil && b.StartsAt <= si.savedT && b.EndsAt > si.savedT {
			si.activeAtStop = append(si.activeAtStop, b.ID)
		}
	}
	e.state.Versions.State = max(e.state.Versions.State+1, e.now)
	e.state.Versions.ExtRules = max(e.state.Versions.ExtRules+1, e.now)

	// A new epoch when the store has none (install, untrusted key, unreadable log).
	if rep.NeedEpoch != "" {
		if err := e.startNeededEpoch(&si); err != nil {
			return err
		}
	}
	// From here on a failed append (a full disk) never stops enforcement: it is logged,
	// health shows disk_full and writes answer 503 until the store accepts batches again.
	if err := e.flushStartJumps(); err != nil {
		e.log.Error("startup clock jump not logged", "err", err)
	}
	e.startupIntegrityEvents(&si)

	// Step 8 (second half): reboot or same-boot consequences.
	if si.snap != nil {
		e.cal.creditDowntime = true
		e.cal.stopT = si.savedT
	}
	// The guardian was down from savedT to the start (measured on the boot clock in the
	// same boot, estimated from the trusted clock after a reboot): each block active at
	// the stop records the part of it before its end.
	downUntil := si.savedT + si.downtime
	if si.rebooted {
		downUntil = e.now
	}
	for _, id := range si.activeAtStop {
		if b := e.block(id); b != nil {
			b.DowntimeMs += max(0, min(downUntil, b.EndsAt)-si.savedT)
		}
	}
	if si.rebooted {
		e.state.Clock.Restore = &restoreJump{SavedT: si.savedT, RestoredT: e.now}
		e.emergencyOnReboot()
		e.studyOnStart(false)
		if e.state.Settings.ServerTimeCheck {
			e.hold = &bootHold{savedT: si.savedT, untilBoot: e.bootNow + bootHoldMax}
		}
		e.cal.dueBoot = e.bootNow // calibrate at once
	} else {
		if si.sameBoot {
			e.studyOnStart(true)
		}
		if si.snap == nil {
			e.cal.dueBoot = e.bootNow
		} else {
			e.cal.dueBoot = e.bootNow + calibrateAfterBoot
		}
	}
	// Step 9: the stopped-service check (same boot only).
	e.stoppedServiceCheck(&si)

	// Step 10: guardian_started, then the day_closed catch-up.
	var downtime *int64
	if si.sameBoot {
		downtime = ptr(si.downtime)
	}
	b := e.newBatch()
	b.add(EvGuardianStarted, GuardianStartedData{
		Version:         e.o.Version,
		SchemaVersion:   store.SchemaVersion,
		CatalogVersion:  e.cat.Version(),
		RulesVersion:    points.RulesVersion(),
		Mode:            e.mode,
		SameBoot:        si.sameBoot,
		DowntimeMs:      downtime,
		UncleanShutdown: rep.UncleanShutdown,
		Recovery:        si.recovery,
	})
	if err := e.commit(b); err != nil {
		e.log.Error("guardian_started not logged", "err", err)
	}
	e.closeDays(e.now)

	// Step 11: enforcement before the API opens.
	e.reconcile()
	e.flushTamper()
	e.startedAt = e.now
	e.markDirty(true)
	e.persistIfDue()
	return nil
}

// startClock samples the clocks after the detector is anchored.
func (e *Engine) startClock() {
	e.readClocks()
	e.now = e.trustedNowMs()
	e.prevT = e.now
	e.lastAwake, e.lastBoot = e.awakeNow, e.bootNow
}

// normalize replaces nil lists and maps of a decoded state.
func (s *engineState) normalize() {
	if s.Blocks == nil {
		s.Blocks = []*blockRec{}
	}
	if s.Punishments == nil {
		s.Punishments = []*punishmentRec{}
	}
	if s.Ledger.OpenDays == nil {
		s.Ledger.OpenDays = map[string]int64{}
	}
	if s.Ledger.Dedupe == nil {
		s.Ledger.Dedupe = map[string]int64{}
	}
	if s.Clock.Trust == "" {
		s.Clock.Trust = TrustUnverified
	}
}

// replay applies every committed event with seq > after (§10.12 step 6). In safe mode it
// stops at the first event that fails to apply and keeps the rest unapplied.
func (e *Engine) replay(after int64) error {
	for {
		page, err := e.st.ReadEvents(e.st.Epoch(), after, limits().EventsPageMax)
		if err != nil {
			return fmt.Errorf("engine: replay the log: %w", err)
		}
		for i := range page.Events {
			if aerr := e.applyEvent(&page.Events[i]); aerr != nil {
				e.log.Warn("replayed event failed to apply", "seq", page.Events[i].Seq, "err", aerr)
				if e.mode == ModeGuardianSafe {
					return nil
				}
			}
		}
		if !page.HasMore || page.LastSeq <= after {
			return nil
		}
		after = page.LastSeq
	}
}

// loadClockSnapshot picks the Detector snapshot: run/clock.json (sealed), else the one
// saved with the state (§10.12 step 8).
func (e *Engine) loadClockSnapshot() *clock.Snapshot {
	var s clock.Snapshot
	if ok, err := e.st.LoadClock(&s); err == nil && ok && !s.Trusted.IsZero() {
		return &s
	}
	if s := e.state.Clock.Snapshot; s != nil && !s.Trusted.IsZero() {
		c := *s
		return &c
	}
	return nil
}

// pendingStartJump queues a clock_jump of the restore, written once an epoch exists.
func (e *Engine) pendingStartJump(source string, deltaMs int64) {
	e.startJumps = append(e.startJumps, jumpRec{AtMs: e.now, DeltaMs: deltaMs, Source: source})
}

func (e *Engine) flushStartJumps() error {
	if len(e.startJumps) == 0 {
		return nil
	}
	b := e.newBatch()
	for _, j := range e.startJumps {
		b.add(EvClockJump, ClockJumpData{
			Source: j.Source, DeltaMs: j.DeltaMs, WallOffsetMs: e.wallOffsetMs(), Trust: e.trust(),
			ReactivatedBlockIDs: []string{}, ShiftedBlockIDs: []string{}, ShiftedAllowanceIDs: []string{},
		})
	}
	e.startJumps = nil
	if err := e.commit(b); err != nil {
		return fmt.Errorf("engine: write the restore clock jump: %w", err)
	}
	return nil
}

// startNeededEpoch starts the epoch the store asked for (§10.12, §10.11 step 4).
func (e *Engine) startNeededEpoch(si *startInfo) error {
	rep := si.rep
	reason := rep.NeedEpoch
	var prev *string
	if rep.Epoch != "" {
		prev = ptr(rep.Epoch)
	} else if e.state.Epoch != "" {
		prev = ptr(e.state.Epoch)
	}
	carry := int64(0)
	esc := EscalationState{}
	kept := e.emptyKept()
	if reason != store.EpochInstall {
		if si.haveState {
			carry = min(0, e.state.Ledger.Balance)
			esc = escalationWire(e.state.Ledger.Escalation)
			kept = e.keptNow(false)
		}
		if a := rep.Anchor; a != nil {
			carry = min(carry, min(0, a.Balance))
			if a.Escalation.LastCountedAt != nil && (esc.LastCountedAt == nil || *a.Escalation.LastCountedAt > *esc.LastCountedAt) {
				esc = EscalationState{LastCountedAt: a.Escalation.LastCountedAt, Index: a.Escalation.Index}
			}
		}
	}
	if reason == store.EpochInstall {
		if tz := e.o.DetectTimezone(); tz != "" {
			kept.Settings.Timezone = ptr(tz)
		}
	}
	// Every state file and the log are gone (log_unreadable, or a directory wiped so
	// thoroughly that it looks like an install): the hosts header decides (§10.12).
	if (reason == store.EpochLogUnreadable || reason == store.EpochInstall) && !si.haveState {
		if rb, ok := e.recoveredBlock(); ok {
			kept.Blocks = append(kept.Blocks, rb)
			si.recovery = string(store.RecoveryHostsSection)
		} else if reason == store.EpochLogUnreadable {
			si.recovery = string(store.RecoveryEmpty)
		}
	}
	extra := func(b *batch) {
		if reason == store.EpochUntrustedKey {
			b.add(EvTamperDetected, TamperDetectedData{Kind: "untrusted_key"})
		}
	}
	return e.startEpoch(reason, prev, carry, esc, kept, extra)
}

// startEpoch writes epoch_started (and extra events of the same batch) with NewEpoch,
// applies it and moves the anchor to the new epoch.
func (e *Engine) startEpoch(reason store.EpochReason, prev *string, carry int64, esc EscalationState, kept EpochKeptState, extra func(*batch)) error {
	b := e.newBatch()
	data := EpochStartedData{Reason: string(reason), PreviousEpoch: prev, CarryOverBalance: carry, Escalation: esc, Kept: kept}
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	b.events = append(b.events, store.Event{
		At: fmtMs(b.at), WallOffsetMs: b.wallMs, Day: b.day, Type: EvEpochStarted, Points: carry, Req: b.req, Data: raw,
	})
	in, ok, _ := points.LedgerInputFromEvent(points.Event{At: fmtMs(b.at), Day: b.day, Type: EvEpochStarted, Points: carry, Data: raw})
	if ok {
		b.ledger = points.ApplyLedgerInput(b.ledger, in, points.DefaultPointRules()).State
		b.ledger.Balance = carry
	}
	if extra != nil {
		extra(b)
	}
	out, err := e.st.NewEpoch(reason, b.events)
	if err != nil && !errors.Is(err, store.ErrCleanup) {
		return fmt.Errorf("engine: start a new epoch: %w", err)
	}
	if err != nil {
		e.log.Warn("new epoch started but cleanup failed", "err", err)
	}
	e.state.Epoch = ""
	for i := range out {
		if aerr := e.applyEvent(&out[i]); aerr != nil {
			e.log.Error("applying the epoch batch failed", "seq", out[i].Seq, "err", aerr)
		}
	}
	e.eventsNotify.broadcast()
	e.bumpState()
	e.enfDirty = true
	e.putAnchor()
	e.markDirty(true)
	return nil
}

// emptyKept is the kept state of an install: nothing but the default settings.
func (e *Engine) emptyKept() EpochKeptState {
	return EpochKeptState{
		Blocks: []Block{}, Punishments: []Punishment{}, Allowances: []RewardAllowance{}, Schedules: []Schedule{},
		Settings: embeddedDefaultSettings(), PendingSettings: []PendingSettingChange{}, MaterializedOccurrences: []string{},
	}
}

// keptNow is the kept state of the current state (trusted times): every active block,
// punishment and allowance, the schedules (all of them, or for a data deletion only those
// the schedules file keeps), the settings and pending changes, and the materialized
// occurrence keys (§10.11 step 2, §10.12).
func (e *Engine) keptNow(dataDeletion bool) EpochKeptState {
	k := e.emptyKept()
	for _, b := range e.activeBlocks() {
		k.Blocks = append(k.Blocks, e.blockWire(b, 0))
	}
	for _, p := range e.state.Punishments {
		if p.Status == StatusActive {
			k.Punishments = append(k.Punishments, punishmentWire(p, 0))
		}
	}
	k.Allowances = nonNil(e.keptAllowances())
	k.Schedules = nonNil(e.keptSchedules(dataDeletion))
	k.MaterializedOccurrences = nonNil(e.materializedOccurrences())
	k.Settings = e.state.Settings.Clone()
	k.PendingSettings = nonNil(e.keptPending(dataDeletion))
	return k
}

// recoveredBlock rebuilds enforcement from the hosts section header when every state
// file and the log are gone (§10.12): a strict block of kind recovered until the
// header's `until`, earning nothing. Without header support, or with `until` in the past,
// there is none (and the section is removed by the first reconcile).
func (e *Engine) recoveredBlock() (Block, bool) {
	hh, ok := e.o.Hosts.(HostsSectionHeader)
	if !ok {
		return Block{}, false
	}
	domains, until, ok, err := hh.Section()
	if err != nil || !ok || until.UnixMilli() <= e.now {
		return Block{}, false
	}
	var custom []string
	for _, d := range domains {
		if catalog.IsValidDomain(d) && !e.cat.IsProtectedDomain(d) {
			custom = append(custom, d)
		}
	}
	if len(custom) == 0 {
		return Block{}, false
	}
	t := emptyTargets()
	t.CustomDomains = sortedUnique(custom)
	return e.newBlockSnapshot(blockSpec{
		Kind: KindRecovered, Mode: ModeStrict, Targets: t, Allow: emptyAllow(),
		StartsAt: e.now, EndsAt: until.UnixMilli(),
	}), true
}

// escalationWire converts the ledger escalation.
func escalationWire(x points.Escalation) EscalationState {
	s := EscalationState{Index: x.Index}
	if x.LastCountedAtMs != nil {
		s.LastCountedAt = ptr(fmtMs(*x.LastCountedAtMs))
	}
	return s
}

// startupIntegrityEvents writes what the store found (§10.12 steps 4–7, §11.4):
// ledger_repaired, tamper_detected{state_mac} and the rollback correction.
func (e *Engine) startupIntegrityEvents(si *startInfo) {
	rep := si.rep
	anchor := rep.Anchor
	if r := rep.Repair; r != nil {
		corr := int64(0)
		if anchor != nil {
			corr = min(0, anchor.Balance-e.state.Ledger.Balance)
		}
		b := e.newBatch()
		b.add(EvLedgerRepaired, LedgerRepairedData{DroppedFromSeq: r.DroppedFromSeq, DroppedCount: r.DroppedCount, ArchivedAs: r.ArchivedAs, BalanceCorrection: corr})
		e.commitNow(b, "ledger_repaired")
	}
	if rep.StateMACInvalid {
		b := e.newBatch()
		b.add(EvTamperDetected, TamperDetectedData{Kind: "state_mac"})
		e.commitNow(b, "tamper_detected{state_mac}")
	}
	switch rep.AnchorCheck {
	case store.AnchorRollback:
		if anchor != nil && rep.NeedEpoch == "" {
			if rep.Repair == nil {
				if corr := min(0, anchor.Balance-e.state.Ledger.Balance); corr < 0 {
					b := e.newBatch()
					b.add(EvTamperDetected, TamperDetectedData{Kind: "ledger_rollback", BalanceCorrection: corr})
					e.commitNow(b, "tamper_detected{ledger_rollback}")
				}
			}
			// The streak an emergency wiped does not come back (§11.4).
			l := &e.state.Ledger
			if anchor.Streak < l.Streak {
				l.Streak = anchor.Streak
			}
			if anchor.VoidedDay != nil {
				l.VoidedDay = ptr(*anchor.VoidedDay)
			}
		}
		e.putAnchor()
	case store.AnchorPreviousEpoch, store.AnchorAbsent, store.AnchorInvalid:
		e.putAnchor()
	}
}

// stoppedServiceCheck prices a stop during a block (§10.12 step 9, same boot only): a
// stop longer than 60 s without a valid planned-stop marker costs like an emergency
// (tamper_detected{service_stopped}, streak voided); otherwise a section edited while
// stopped costs the same once (hosts_changed_while_stopped).
func (e *Engine) stoppedServiceCheck(si *startInfo) {
	if !si.sameBoot || len(si.activeAtStop) == 0 || si.rep.PlannedStop.Valid || e.mode == ModeGuardianSafe {
		return
	}
	kind := ""
	if si.downtime > stopPenaltyThreshold.Milliseconds() {
		kind = "service_stopped"
	} else if e.state.HostsHash != "" && si.hostsReadable && hashDomains(si.hostsAtStart) != e.state.HostsHash {
		kind = "hosts_changed_while_stopped"
	}
	if kind == "" {
		return
	}
	pen := points.EmergencyPenalty(e.state.Ledger.Balance+e.allowanceValue(e.now), points.DefaultPointRules())
	b := e.newBatch()
	b.add(EvTamperDetected, TamperDetectedData{Kind: kind, BalanceCorrection: -pen, VoidStreak: true})
	e.commitNow(b, "tamper_detected{"+kind+"}")
}
