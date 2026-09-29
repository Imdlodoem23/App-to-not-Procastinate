package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

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
	// stateClock is the snapshot saved with the loaded state and its log position.
	stateClock *clockCand
	// restored: the stop time savedT is known (a snapshot, or the log's last event).
	restored bool
	sameBoot bool
	rebooted bool
	// unverified: events are logged but no snapshot measures the stop (the files were
	// removed or an older copy put back); rebooted is set too (§10.12 step 8).
	unverified bool
	// cleanStop: the previous run stopped cleanly (restoreClock).
	cleanStop bool
	// downtime is the same-boot time from the last trace of the previous run to now.
	downtime int64
	savedT   int64
	// prevBinary is the binary identity sealed in the up-to-date run/clock.json by the
	// run that stopped ("" when unknown).
	prevBinary string
	recovery   string
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
		if c := loaded.Clock.Snapshot; c != nil && !c.Trusted.IsZero() {
			si.stateClock = &clockCand{snap: *c, epoch: ls.Epoch, seq: ls.LastEventSeq}
		}
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
	e.restoreClock(&si)
	e.addLostResponses()
	for _, b := range e.state.Blocks {
		if b.Status == StatusActive && si.restored && b.StartsAt <= si.savedT && b.EndsAt > si.savedT {
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
	//
	// The evidence of the previous run (the restore jump, the integrity corrections and
	// the price of the stop, step 9) is decided now, from the snapshots as the stop left
	// them, and goes into the first startup batch. Until that batch is committed nothing
	// else is appended and neither the clock snapshot, state.json nor the rollback anchor
	// moves (critical.go): a crash or a full disk cannot launder it.
	e.queueStartJumps()
	e.startupIntegrityEvents(&si)
	e.stoppedServiceCheck(&si)
	if err := e.flushCritical(); err != nil {
		e.log.Error("startup evidence not logged; retrying before any other write", "err", err)
	}

	// Step 8 (second half): reboot or same-boot consequences.
	if si.restored {
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
		if si.unverified {
			e.state.Clock.Trust = TrustUnverified
		}
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
		if !si.restored {
			e.cal.dueBoot = e.bootNow
		} else {
			e.cal.dueBoot = e.bootNow + calibrateAfterBoot
		}
	}
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
			if r := page.Events[i].Req; r != nil {
				if e.replayedReqs == nil {
					e.replayedReqs = map[string]int64{}
				}
				e.replayedReqs[*r] = max(e.replayedReqs[*r], atMs(&page.Events[i]))
			}
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

// pendingStartJump queues a clock_jump of the restore, written once an epoch exists.
func (e *Engine) pendingStartJump(source string, deltaMs int64) {
	e.startJumps = append(e.startJumps, jumpRec{AtMs: e.now, DeltaMs: deltaMs, Source: source})
}

// queueStartJumps queues the restore clock jumps as critical startup evidence.
func (e *Engine) queueStartJumps() {
	for _, j := range e.startJumps {
		e.addCritical("clock_jump{"+j.Source+"}", func(b *batch) {
			b.add(EvClockJump, ClockJumpData{
				Source: j.Source, DeltaMs: j.DeltaMs, WallOffsetMs: e.wallOffsetMs(), Trust: e.trust(),
				ReactivatedBlockIDs: []string{}, ShiftedBlockIDs: []string{}, ShiftedAllowanceIDs: []string{},
			})
		})
	}
	e.startJumps = nil
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
	// The clock snapshot follows the log into the new epoch at once (restoreClock).
	if cerr := e.saveClock(e.st.LastSeq(), false); cerr != nil {
		e.log.Warn("clock snapshot save failed", "err", cerr)
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

// startupIntegrityEvents queues what the store found (§10.12 steps 4–7, §11.4):
// ledger_repaired, tamper_detected{state_mac} and the rollback correction. They are
// critical: the anchor keeps the pre-rollback position until they are committed
// (putAnchor waits for the critical batch), so a correction that fails to commit is found
// again at the next start instead of being laundered.
func (e *Engine) startupIntegrityEvents(si *startInfo) {
	rep := si.rep
	anchor := rep.Anchor
	if r := rep.Repair; r != nil {
		corr := int64(0)
		if anchor != nil {
			corr = min(0, anchor.Balance-e.state.Ledger.Balance)
		}
		d := LedgerRepairedData{DroppedFromSeq: r.DroppedFromSeq, DroppedCount: r.DroppedCount, ArchivedAs: r.ArchivedAs, BalanceCorrection: corr}
		e.addCritical("ledger_repaired", func(b *batch) { b.add(EvLedgerRepaired, d) })
	}
	if rep.StateMACInvalid {
		e.addCritical("tamper_detected{state_mac}", func(b *batch) {
			b.add(EvTamperDetected, TamperDetectedData{Kind: "state_mac"})
		})
	}
	switch rep.AnchorCheck {
	case store.AnchorRollback:
		if anchor != nil && rep.NeedEpoch == "" {
			if rep.Repair == nil {
				if corr := min(0, anchor.Balance-e.state.Ledger.Balance); corr < 0 {
					e.addCritical("tamper_detected{ledger_rollback}", func(b *batch) {
						b.add(EvTamperDetected, TamperDetectedData{Kind: "ledger_rollback", BalanceCorrection: corr})
					})
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
		e.putAnchor() // deferred to the critical batch when a correction is queued
	case store.AnchorPreviousEpoch, store.AnchorAbsent, store.AnchorInvalid:
		e.putAnchor()
	}
}

// snapshotMaxAge is how old the last trace of a running guardian can be when it
// crashes: state.json and run/clock.json are written at least every saveEvery, checked
// on every tick.
const snapshotMaxAge = saveEvery + tickInterval

// stoppedServiceCheck prices a stop that left commitments unenforced (§10.12 step 9):
// tamper_detected{service_stopped, −emergencyPenalty(balance + allowanceValue),
// voidStreak} when a block or punishment was active at the stop, or an enabled
// schedule's window overlapped it, and the stop was not a planned one:
//
//   - same boot: the stop lasted more than 60 s. After a crash (no clean-shutdown
//     marker, and no clean stop sealed in run/clock.json) the previous run may have
//     lived up to snapshotMaxAge after its last trace, so that much is not counted:
//     crash restarts stay under the threshold.
//   - the stop could not be measured (restoreClock: snapshot removed or replaced). No
//     marker exempts it.
//   - a reboot after a clean stop that was not an OS shutdown, where the service manager
//     reports shutdowns (shutdownNoticed: Windows SERVICE_CONTROL_SHUTDOWN, systemd):
//     the guardian then writes the planned-stop marker «shutdown» when the OS shuts
//     down, so a clean stop without it was a manual stop before the reboot. A
//     «shutdown» marker counts at any age across a reboot (the machine may stay off for
//     days). Service managers that send the same signal for both (macOS launchd, SysV,
//     OpenRC, upstart) are exempt: no marker is ever written there.
//
// An «update» or «install» marker (written by the installer, the updaters and
// `centrate-guardian prepare-update`) exempts a stop only when an update really
// happened: the binary that starts differs from the one that stopped (plannedUpdate).
// In the same boot the marker must also still be valid, i.e. the restart came within
// store.PlannedStopTTL of writing it: the assisted NSIS wizard stops the service in
// .onInit, before the user clicks through its pages, so a shorter cap would price
// slow updates, and the binary-change check already stops `prepare-update` + stop
// loops. A valid «shutdown» marker exempts a same-boot stop as before.
//
// Otherwise, in the same boot, a section found different from the last one written
// while blocks were active costs the same once (hosts_changed_while_stopped): no
// planned-stop marker exempts it, since neither updaters nor OS shutdowns touch the
// section. Safe mode is no exemption: the penalty is written by the guardian, not
// through the API.
//
// It is decided at startup before anything is committed and queued as critical
// evidence (critical.go), so it is retried until it is logged.
func (e *Engine) stoppedServiceCheck(si *startInfo) {
	kind := e.stopPenaltyKind(si)
	if kind == "" {
		return
	}
	e.addCritical("tamper_detected{"+kind+"}", func(b *batch) {
		pen := points.EmergencyPenalty(b.balance()+e.allowanceValue(e.now), points.DefaultPointRules())
		b.add(EvTamperDetected, TamperDetectedData{Kind: kind, BalanceCorrection: -pen, VoidStreak: true})
	})
}

// stopPenaltyKind is the tamper kind the stop costs, or "".
func (e *Engine) stopPenaltyKind(si *startInfo) string {
	ps := si.rep.PlannedStop
	if ps.Present {
		e.log.Info("planned-stop marker found", "reason", ps.Reason, "valid", ps.Valid, "problem", ps.Problem,
			"binaryChanged", si.prevBinary != "" && si.prevBinary != e.binaryID())
	}
	if !si.restored {
		return ""
	}
	update := e.plannedUpdate(si)
	switch {
	case si.unverified:
		if e.stopCommitments(si) {
			return "service_stopped"
		}
		return ""
	case si.sameBoot:
		down := si.downtime
		if !si.cleanStop {
			down -= snapshotMaxAge.Milliseconds()
		}
		planned := (ps.Valid && ps.Reason == plannedShutdown) || (ps.Valid && update)
		if !planned && down > stopPenaltyThreshold.Milliseconds() && e.stopCommitments(si) {
			return "service_stopped"
		}
	case si.rebooted:
		// The TTL only makes sense within one boot: the machine may stay off for days.
		osShutdown := ps.Present && ps.Reason == plannedShutdown && (ps.Valid || strings.HasPrefix(ps.Problem, "expired"))
		if si.cleanStop && !osShutdown && !update && e.shutdownNoticed() && e.stopCommitments(si) {
			return "service_stopped"
		}
		return ""
	}
	if si.sameBoot && len(si.activeAtStop) > 0 && e.state.HostsHash != "" && si.hostsReadable {
		if h := hashDomains(si.hostsAtStart); h != e.state.HostsHash && h != e.state.HostsPendingHash {
			return "hosts_changed_while_stopped"
		}
	}
	return ""
}

// Planned-stop reasons (store.PlannedStop.Reason) the engine distinguishes.
const (
	plannedShutdown = "shutdown"
	plannedUpdate   = "update"
	plannedInstall  = "install"
)

// plannedUpdate reports whether an «update» or «install» marker (valid, or expired
// across a reboot) goes with a real update: the binary identity sealed in run/clock.json
// by the stopped run is known and differs from this one.
func (e *Engine) plannedUpdate(si *startInfo) bool {
	ps := si.rep.PlannedStop
	if !ps.Present || (ps.Reason != plannedUpdate && ps.Reason != plannedInstall) {
		return false
	}
	if !ps.Valid && !(si.rebooted && strings.HasPrefix(ps.Problem, "expired")) {
		return false
	}
	return si.prevBinary != "" && si.prevBinary != e.binaryID()
}

// shutdownNoticed reports whether the service manager tells an OS shutdown apart from a
// plain stop, so the guardian writes the «shutdown» marker (§13): the Windows service
// control manager and systemd. launchd (macOS), SysV init, OpenRC, upstart and an
// interactive run send the same signal for both.
//
// The named manager decides on its own: it is what delivers (or not) the notice. Only an
// unnamed manager (tests, embedding) falls back to the catalog platform, and counts as
// noticing unless the platform is macOS, whose only manager is launchd. The platform
// used to be checked first, so a manager named explicitly was overruled by the platform
// (which defaults to the host's): "linux-systemd" counted as launchd on a Mac.
func (e *Engine) shutdownNoticed() bool {
	switch e.o.ServiceManager {
	case "windows-service", "linux-systemd":
		return true
	case "":
		return e.platform != catalog.PlatformMac
	}
	return false
}

// stopCommitments reports whether the stop left something unenforced: a block or
// punishment active at savedT, or an occurrence of an enabled schedule, not materialized
// before the stop, whose window overlaps the time from savedT to now (an occurrence
// still in progress is materialized late by the next step for its remaining time).
func (e *Engine) stopCommitments(si *startInfo) bool {
	return len(si.activeAtStop) > 0 || e.scheduleDuring(si.savedT, e.now)
}

// scheduleDuring reports whether an enabled schedule has an occurrence that was not
// materialized and whose window overlaps (from, to).
func (e *Engine) scheduleDuring(from, to int64) bool {
	if to <= from {
		return false
	}
	days := int(min((to-from)/(24*60*msPerMinute)+1, schHorizonDays))
	for _, s := range e.state.Schedules.List {
		if !s.Enabled {
			continue
		}
		loc, ok := loadLocation(s.Timezone)
		if !ok {
			continue
		}
		for _, occ := range schOccurrences(s, loc, from, -1, days) {
			if occ.Start >= to || occ.End <= from {
				continue
			}
			if _, done := e.state.Schedules.Materialized[occ.Key]; !done {
				return true
			}
		}
	}
	return false
}
