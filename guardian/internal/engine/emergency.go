package engine

// OWNER: emergency teammate (docs/ARCHITECTURE.md §5.6, §10.6, §8.8 «Emergency»).
//
// An emergency unlock lists active normal/strict blocks (punishment blocks included:
// they are strict). Its countdown runs on the boot clock (readyAtBoot = bootNow +
// countdown), so neither a wall-clock change nor the trusted clock's corrections move it,
// and suspend counts. Once ready it must be confirmed within the confirm window. The
// states are:
//
//	none ──request──▶ counting ──bootNow ≥ readyAtBoot──▶ ready ──confirm──▶ confirmed
//	                     │                                  └── window passed ──▶ expired
//	                     └── cancel(user) / reboot / every listed block ended ──▶ cancelled
//
// counting → ready is not an event: it is derived from the boot clock on every read.
// Every other transition is an event (emergency_requested, emergency_cancelled{user,
// blocks_ended, reboot, expired}, emergency_confirmed + block_cancelled… +
// punishment_ended{emergency}…), applied by the reducers at the end of this file.

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
	"github.com/imdlodoem23/centrate/guardian/internal/clock"
	"github.com/imdlodoem23/centrate/guardian/internal/points"
)

// Emergency cancel reasons (EMERGENCY_CANCEL_REASONS) and statuses (EMERGENCY_STATUSES).
const (
	emgReasonUser        = "user"
	emgReasonExpired     = "expired"
	emgReasonBlocksEnded = "blocks_ended"
	emgReasonReboot      = "reboot"

	emgStatusCounting  = "counting"
	emgStatusReady     = "ready"
	emgStatusConfirmed = "confirmed"
	emgStatusCancelled = "cancelled"
	emgStatusExpired   = "expired"
)

// emergencyState is the persisted emergency state (state.json "engine.emergency").
type emergencyState struct {
	// Pending is the counting or ready unlock; at most one exists (§5.6).
	Pending *emergencyRec `json:"pending"`
	// Last is the most recently resolved unlock: the cancel and confirm answers are built
	// from it, and it tells a late confirm apart (emergency_moot, emergency_expired).
	Last *emergencyRec `json:"last"`
}

// emergencyRec is an EmergencyUnlock in trusted Unix ms plus its boot-clock readings.
type emergencyRec struct {
	ID               string   `json:"id"`
	BlockIDs         []string `json:"blockIds"`
	CountdownMinutes int64    `json:"countdownMinutes"`
	RequestedAt      int64    `json:"requestedAt"`
	// ReadyAt is the trusted readyAt announced at the request; the countdown itself runs
	// on ReadyAtBoot.
	ReadyAt int64 `json:"readyAt"`
	// BootID, RequestedAtBoot and ReadyAtBoot (boot-clock ms) belong to the boot the
	// unlock was requested in (§10.6: a reboot cancels it).
	BootID          string `json:"bootId"`
	RequestedAtBoot int64  `json:"requestedAtBoot"`
	ReadyAtBoot     int64  `json:"readyAtBoot"`

	// Resolution (Last only).
	Status           string  `json:"status,omitempty"`
	ResolvedAt       *int64  `json:"resolvedAt,omitempty"`
	CancelReason     *string `json:"cancelReason,omitempty"`
	ConfirmBy        *int64  `json:"confirmBy,omitempty"`
	PenaltyPreview   int64   `json:"penaltyPreview,omitempty"`
	StreakDaysAtRisk int64   `json:"streakDaysAtRisk,omitempty"`
}

// EmergencyPhrasesWire is EmergencyPreviewResponse.phrases.
type EmergencyPhrasesWire struct {
	ES string `json:"es"`
	EN string `json:"en"`
}

// EmergencyPreviewResponse mirrors EmergencyPreviewResponse.
type EmergencyPreviewResponse struct {
	Eligible         bool                 `json:"eligible"`
	Reason           *string              `json:"reason"`
	BlockIDs         []string             `json:"blockIds"`
	ExcludedBlockIDs []string             `json:"excludedBlockIds"`
	CountdownMinutes *int64               `json:"countdownMinutes"`
	PenaltyPoints    int64                `json:"penaltyPoints"`
	Balance          int64                `json:"balance"`
	AllowanceValue   int64                `json:"allowanceValue"`
	StreakDays       int64                `json:"streakDays"`
	Phrases          EmergencyPhrasesWire `json:"phrases"`
}

// EmergencyRequest mirrors EmergencyRequest.
type EmergencyRequest struct {
	BlockIDs []string `json:"blockIds"`
	Phrase   string   `json:"phrase"`
}

// EmergencyResponse mirrors EmergencyResponse.
type EmergencyResponse struct {
	Emergency EmergencyUnlock `json:"emergency"`
}

// ConfirmEmergencyRequest mirrors ConfirmEmergencyRequest.
type ConfirmEmergencyRequest struct {
	Acknowledge bool `json:"acknowledge"`
}

// ConfirmEmergencyResponse mirrors ConfirmEmergencyResponse.
type ConfirmEmergencyResponse struct {
	Emergency         EmergencyUnlock `json:"emergency"`
	PenaltyApplied    int64           `json:"penaltyApplied"`
	BalanceAfter      int64           `json:"balanceAfter"`
	CancelledBlockIDs []string        `json:"cancelledBlockIds"`
	StreakDaysLost    int64           `json:"streakDaysLost"`
}

// ---------------------------------------------------------------------------------------
// Rules and small helpers
// ---------------------------------------------------------------------------------------

// emergencyConfirmWindowMs is EMERGENCY_RULES.confirmWindowMinutes in ms.
func emergencyConfirmWindowMs() int64 {
	return int64(points.DefaultEmergencyRules().ConfirmWindowMinutes) * msPerMinute
}

// bootDisplayTolerance: a boot-derived deadline is reported as the trusted value
// announced at the request while the two agree within this tolerance, so the trusted
// clock's slewing does not change /v1/state (and stateVersion) on every tick.
const bootDisplayTolerance = int64(time.Second / time.Millisecond)

// emergencyWellFormedID reports whether v is `<prefix>_` + 16–40 [0-9A-Za-z] (isIdOf).
func emergencyWellFormedID(prefix, v string) bool {
	body, ok := strings.CutPrefix(v, prefix+"_")
	if !ok || len(body) < 16 || len(body) > 40 {
		return false
	}
	for i := 0; i < len(body); i++ {
		c := body[i]
		if (c < '0' || c > '9') && (c < 'A' || c > 'Z') && (c < 'a' || c > 'z') {
			return false
		}
	}
	return true
}

// bootMs is the boot clock of this turn in ms.
func (e *Engine) bootMs() int64 { return e.bootNow.Milliseconds() }

// emergencySameBoot reports whether the boot clock of this turn is comparable with the
// readings of the unlock (§10.2: the core's reboot hook cancels it at startup; this is
// the defence for a start without a clock snapshot). With both boot ids known it is
// clock.SameBoot; otherwise boot-clock continuity alone decides.
func (e *Engine) emergencySameBoot(p *emergencyRec) bool {
	if p.BootID != "" && e.bootID != "" {
		prev := clock.Snapshot{Trusted: time.UnixMilli(p.RequestedAt), Boot: msDuration(p.RequestedAtBoot), BootID: p.BootID}
		cur := clock.Snapshot{Trusted: time.UnixMilli(e.now), Boot: e.bootNow, BootID: e.bootID}
		return clock.SameBoot(prev, cur)
	}
	return e.bootMs() >= p.RequestedAtBoot
}

// emergencyReady reports whether the countdown of p is over (boot clock).
func (e *Engine) emergencyReady(p *emergencyRec) bool { return e.bootMs() >= p.ReadyAtBoot }

// bootAnchored is the trusted time of a boot-clock deadline, now + (atBoot − bootNow)
// (§10.6), reported as announced (trusted) while both agree within a second.
func (e *Engine) bootAnchored(trusted, atBoot int64) int64 {
	computed := e.now + (atBoot - e.bootMs())
	if d := computed - trusted; d > -bootDisplayTolerance && d < bootDisplayTolerance {
		return trusted
	}
	return computed
}

// emergencyPenaltyNow is the penalty of a confirm now: on balance + allowanceValue.
func (e *Engine) emergencyPenaltyNow() int64 {
	return points.EmergencyPenalty(e.state.Ledger.Balance+e.allowanceValue(e.now), points.DefaultPointRules())
}

// streakAtRisk is the displayed streak an emergency would wipe now (the ledger's
// streakDaysLost of an emergency_confirmed emitted now).
func (e *Engine) streakAtRisk() int64 {
	return points.StreakAsOf(e.state.Ledger, e.localDay(e.now), e.goalMinutes())
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

// EmergencyPreview is GET /v1/emergency/preview?blockIds=… (nil: every eligible block).
func (e *Engine) EmergencyPreview(ctx context.Context, blockIDs []string) (EmergencyPreviewResponse, error) {
	return run(e, ctx, cmdOpts{}, func() (EmergencyPreviewResponse, error) { return e.emergencyPreview(blockIDs) })
}

// emergencyPreview powers «Perderás 620 puntos y tu racha de 5 días». Without blockIDs
// it covers every active normal/strict block; with them, the listed active ones that
// are eligible (unknown and ended ids are ignored). Hardcore and exam blocks are never
// covered and are reported in excludedBlockIds.
func (e *Engine) emergencyPreview(blockIDs []string) (EmergencyPreviewResponse, error) {
	if len(blockIDs) > limits().EmergencyMaxBlocks {
		return EmergencyPreviewResponse{}, badQuery("too many blockIds")
	}
	for _, id := range blockIDs {
		if !emergencyWellFormedID("blk", id) {
			return EmergencyPreviewResponse{}, badQuery("invalid blockIds")
		}
	}
	rules := points.DefaultEmergencyRules()
	balance := e.state.Ledger.Balance
	av := e.allowanceValue(e.now)
	res := EmergencyPreviewResponse{
		BlockIDs:         []string{},
		ExcludedBlockIDs: []string{},
		PenaltyPoints:    points.EmergencyPenalty(balance+av, points.DefaultPointRules()),
		Balance:          balance,
		AllowanceValue:   av,
		StreakDays:       e.streakAtRisk(),
		Phrases:          EmergencyPhrasesWire{ES: rules.Phrases.ES, EN: rules.Phrases.EN},
	}
	active := e.activeBlocks()
	for _, b := range active {
		if !points.IsEmergencyEligibleMode(b.Mode) {
			res.ExcludedBlockIDs = append(res.ExcludedBlockIDs, b.ID)
		}
	}
	if e.state.Emergency.Pending != nil {
		res.Reason = ptr("emergency_in_progress")
		return res, nil
	}
	wanted := active
	if len(blockIDs) > 0 {
		wanted = slices.DeleteFunc(slices.Clone(active), func(b *blockRec) bool { return !slices.Contains(blockIDs, b.ID) })
	}
	var modes []string
	hardcore, exam := false, false
	for _, b := range wanted {
		switch {
		case points.IsEmergencyEligibleMode(b.Mode):
			res.BlockIDs = append(res.BlockIDs, b.ID)
			modes = append(modes, b.Mode)
		case b.Mode == ModeExam:
			exam = true
		default:
			hardcore = true
		}
	}
	if cd, ok := points.EmergencyCountdownMinutes(modes, rules); ok {
		res.Eligible = true
		res.CountdownMinutes = &cd
		return res, nil
	}
	switch {
	case exam:
		res.Reason = ptr(ModeExam)
	case hardcore:
		res.Reason = ptr(ModeHardcore)
	default:
		res.Reason = ptr("no_active_blocks")
	}
	return res, nil
}

// RequestEmergency is POST /v1/emergency (idempotent, 201).
func (e *Engine) RequestEmergency(ctx context.Context, r Request, req EmergencyRequest) (EmergencyResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem, status: 201}, func() (EmergencyResponse, error) {
		return e.requestEmergency(req)
	})
}

// validateEmergencyRequest checks the shape like emergencyRequestSchema.
func validateEmergencyRequest(req EmergencyRequest) *APIError {
	l := limits()
	if len(req.BlockIDs) < 1 || len(req.BlockIDs) > l.EmergencyMaxBlocks {
		return issueErr("blockIds", "length", fmt.Sprintf("between 1 and %d items", l.EmergencyMaxBlocks))
	}
	for i, id := range req.BlockIDs {
		p := fmt.Sprintf("blockIds[%d]", i)
		if !emergencyWellFormedID("blk", id) {
			return issueErr(p, "pattern", "blk_ id")
		}
		if slices.Index(req.BlockIDs, id) != i {
			return issueErr(p, "duplicate", "duplicate")
		}
	}
	if n := catalog.UTF16Len(req.Phrase); n < 1 || n > l.PhraseMaxLength {
		return issueErr("phrase", "length", fmt.Sprintf("length in [1, %d]", l.PhraseMaxLength))
	}
	return nil
}

// requestEmergency starts the countdown (§10.6): the phrase in either language, no
// other pending unlock, every listed block active and normal/strict.
func (e *Engine) requestEmergency(req EmergencyRequest) (EmergencyResponse, error) {
	if err := validateEmergencyRequest(req); err != nil {
		return EmergencyResponse{}, err
	}
	rules := points.DefaultEmergencyRules()
	if !points.EmergencyPhraseMatches(req.Phrase, rules) {
		return EmergencyResponse{}, apiErr("phrase_mismatch", "the commitment phrase does not match", nil)
	}
	if p := e.state.Emergency.Pending; p != nil {
		return EmergencyResponse{}, apiErr("emergency_in_progress", "an emergency unlock is already pending",
			map[string]any{"emergencyId": p.ID})
	}
	var modes []string
	bad := map[string][]string{}
	for _, id := range req.BlockIDs {
		rec := e.block(id)
		switch {
		case rec == nil || rec.Status != StatusActive:
			bad["not_active"] = append(bad["not_active"], id)
		case rec.Mode == ModeExam || rec.Mode == ModeHardcore:
			bad[rec.Mode] = append(bad[rec.Mode], id)
		default:
			modes = append(modes, rec.Mode)
		}
	}
	for _, reason := range []string{ModeExam, ModeHardcore, "not_active"} {
		if ids := bad[reason]; len(ids) > 0 {
			return EmergencyResponse{}, apiErr("emergency_not_available", "a listed block cannot be unlocked",
				map[string]any{"reason": reason, "blockIds": ids})
		}
	}
	cd, ok := points.EmergencyCountdownMinutes(modes, rules)
	if !ok {
		return EmergencyResponse{}, apiErr("emergency_not_available", "no block can be unlocked",
			map[string]any{"reason": "not_active", "blockIds": slices.Clone(req.BlockIDs)})
	}
	b := e.newBatch()
	b.add(EvEmergencyRequested, EmergencyRequestedData{Emergency: EmergencyUnlock{
		ID:               newID("emg"),
		BlockIDs:         slices.Clone(req.BlockIDs),
		Status:           emgStatusCounting,
		CountdownMinutes: cd,
		RequestedAt:      fmtMs(b.at),
		ReadyAt:          fmtMs(b.at + cd*msPerMinute),
		PenaltyPreview:   e.emergencyPenaltyNow(),
		StreakDaysAtRisk: e.streakAtRisk(),
	}})
	if err := e.commit(b); err != nil {
		return EmergencyResponse{}, err
	}
	w := e.emergencyWire(e.wallOffsetMs())
	if w == nil {
		return EmergencyResponse{}, apiErr("internal", "the emergency was not recorded", nil)
	}
	return EmergencyResponse{Emergency: *w}, nil
}

// CancelEmergency is POST /v1/emergency/{id}/cancel.
func (e *Engine) CancelEmergency(ctx context.Context, r Request, id string) (EmergencyResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem}, func() (EmergencyResponse, error) { return e.cancelEmergency(id) })
}

// cancelEmergency cancels a counting or ready unlock for free (reason user).
func (e *Engine) cancelEmergency(id string) (EmergencyResponse, error) {
	p := e.state.Emergency.Pending
	if p == nil || p.ID != id {
		return EmergencyResponse{}, e.emergencyGone(id, false)
	}
	b := e.newBatch()
	b.add(EvEmergencyCancelled, EmergencyCancelledData{EmergencyID: p.ID, Reason: emgReasonUser})
	if err := e.commit(b); err != nil {
		return EmergencyResponse{}, err
	}
	return EmergencyResponse{Emergency: e.lastEmergencyWire(e.wallOffsetMs())}, nil
}

// ConfirmEmergency is POST /v1/emergency/{id}/confirm (idempotent).
func (e *Engine) ConfirmEmergency(ctx context.Context, r Request, id string, req ConfirmEmergencyRequest) (ConfirmEmergencyResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem, status: 200}, func() (ConfirmEmergencyResponse, error) {
		return e.confirmEmergency(id, req)
	})
}

// confirmEmergency charges the penalty (computed now on balance + allowanceValue), wipes
// the streak and cancels every listed block that is still active (§10.6).
func (e *Engine) confirmEmergency(id string, req ConfirmEmergencyRequest) (ConfirmEmergencyResponse, error) {
	if !req.Acknowledge {
		return ConfirmEmergencyResponse{}, issueErr("acknowledge", "enum", "expected true")
	}
	p := e.state.Emergency.Pending
	if p == nil || p.ID != id {
		return ConfirmEmergencyResponse{}, e.emergencyGone(id, true)
	}
	if !e.emergencyReady(p) {
		readyAt := e.display(e.bootAnchored(p.ReadyAt, p.ReadyAtBoot))
		return ConfirmEmergencyResponse{}, apiErr("emergency_not_ready", "the countdown has not finished",
			map[string]any{"readyAt": readyAt})
	}
	if e.bootMs() >= p.ReadyAtBoot+emergencyConfirmWindowMs() {
		// The time step expires it first; this only guards the invariant.
		e.cancelPendingEmergency(emgReasonExpired)
		return ConfirmEmergencyResponse{}, apiErr("emergency_expired", "the confirm window has passed",
			map[string]any{"status": emgStatusExpired, "cancelReason": emgReasonExpired})
	}
	var live []*blockRec
	for _, bid := range p.BlockIDs {
		if rec := e.block(bid); rec != nil && rec.Status == StatusActive {
			live = append(live, rec)
		}
	}
	if len(live) == 0 {
		// The time step cancels a moot unlock first; this only guards the invariant.
		e.cancelPendingEmergency(emgReasonBlocksEnded)
		return ConfirmEmergencyResponse{}, apiErr("emergency_moot", "every listed block already ended", nil)
	}
	b := e.newBatch()
	balance := e.state.Ledger.Balance
	av := e.allowanceValue(b.at)
	streak := points.StreakAsOf(e.state.Ledger, b.day, e.goalMinutes())
	ids := make([]string, 0, len(live))
	for _, rec := range live {
		ids = append(ids, rec.ID)
	}
	pts := b.add(EvEmergencyConfirmed, EmergencyConfirmedData{
		EmergencyID:    p.ID,
		BlockIDs:       ids,
		BalanceBefore:  balance,
		AllowanceValue: av,
		Penalty:        points.EmergencyPenalty(balance+av, points.DefaultPointRules()),
		StreakDaysLost: streak,
		GoalMinutes:    e.goalMinutes(),
	})
	for _, rec := range live {
		e.addBlockCancelled(b, rec, p.ID)
	}
	if err := e.commit(b); err != nil {
		return ConfirmEmergencyResponse{}, err
	}
	return ConfirmEmergencyResponse{
		Emergency:         e.lastEmergencyWire(e.wallOffsetMs()),
		PenaltyApplied:    -pts,
		BalanceAfter:      e.state.Ledger.Balance,
		CancelledBlockIDs: ids,
		StreakDaysLost:    streak,
	}, nil
}

// emergencyGone is the error for an id that is not the pending unlock: 404 for a
// malformed id; emergency_moot for a confirm of an unlock the step cancelled because
// every listed block ended; emergency_expired otherwise (expired, cancelled, already
// confirmed or unknown: it is not pending).
func (e *Engine) emergencyGone(id string, confirming bool) error {
	if !emergencyWellFormedID("emg", id) {
		return notFound("emergency")
	}
	if l := e.state.Emergency.Last; l != nil && l.ID == id {
		if confirming && l.CancelReason != nil && *l.CancelReason == emgReasonBlocksEnded {
			return apiErr("emergency_moot", "every listed block already ended", nil)
		}
		details := map[string]any{"status": l.Status}
		if l.CancelReason != nil {
			details["cancelReason"] = *l.CancelReason
		}
		return apiErr("emergency_expired", "the emergency unlock is no longer pending", details)
	}
	return apiErr("emergency_expired", "no pending emergency unlock with that id", nil)
}

// cancelPendingEmergency commits emergency_cancelled{reason} for the pending unlock.
func (e *Engine) cancelPendingEmergency(reason string) {
	p := e.state.Emergency.Pending
	if p == nil {
		return
	}
	b := e.newBatch()
	b.add(EvEmergencyCancelled, EmergencyCancelledData{EmergencyID: p.ID, Reason: reason})
	e.commitNow(b, "emergency_cancelled{"+reason+"}")
}

// ---------------------------------------------------------------------------------------
// Hooks the core calls
// ---------------------------------------------------------------------------------------

// emergencyStep is the time-driven part (§10.6): an unlock whose boot clock is gone is
// cancelled (reboot), one whose listed blocks all ended is cancelled for free
// (blocks_ended), and a ready one past its confirm window expires (expired). counting →
// ready needs no event: it is read from the boot clock.
func (e *Engine) emergencyStep() {
	p := e.state.Emergency.Pending
	if p == nil {
		return
	}
	switch {
	case !e.emergencySameBoot(p):
		e.cancelPendingEmergency(emgReasonReboot)
	case !slices.ContainsFunc(p.BlockIDs, func(id string) bool {
		rec := e.block(id)
		return rec != nil && rec.Status == StatusActive
	}):
		e.cancelPendingEmergency(emgReasonBlocksEnded)
	case e.bootMs() >= p.ReadyAtBoot+emergencyConfirmWindowMs():
		e.cancelPendingEmergency(emgReasonExpired)
	}
}

// emergencyWire is /v1/state.emergency: a counting or ready unlock, or nil. readyAt and
// confirmBy come from the boot clock (now + (atBoot − bootNow)); penaltyPreview and
// streakDaysAtRisk are what a confirm would cost now.
func (e *Engine) emergencyWire(offsetMs int64) *EmergencyUnlock {
	p := e.state.Emergency.Pending
	if p == nil {
		return nil
	}
	w := EmergencyUnlock{
		ID:               p.ID,
		BlockIDs:         slices.Clone(p.BlockIDs),
		Status:           emgStatusCounting,
		CountdownMinutes: p.CountdownMinutes,
		RequestedAt:      fmtMs(p.RequestedAt + offsetMs),
		ReadyAt:          fmtMs(e.bootAnchored(p.ReadyAt, p.ReadyAtBoot) + offsetMs),
		PenaltyPreview:   e.emergencyPenaltyNow(),
		StreakDaysAtRisk: e.streakAtRisk(),
	}
	if e.emergencyReady(p) {
		win := emergencyConfirmWindowMs()
		w.Status = emgStatusReady
		w.ConfirmBy = ptr(fmtMs(e.bootAnchored(p.ReadyAt+win, p.ReadyAtBoot+win) + offsetMs))
	}
	return &w
}

// lastEmergencyWire is the most recently resolved unlock (cancel and confirm answers).
func (e *Engine) lastEmergencyWire(offsetMs int64) EmergencyUnlock {
	l := e.state.Emergency.Last
	if l == nil {
		return EmergencyUnlock{BlockIDs: []string{}}
	}
	at := func(ms *int64) *string {
		if ms == nil {
			return nil
		}
		return ptr(fmtMs(*ms + offsetMs))
	}
	return EmergencyUnlock{
		ID:               l.ID,
		BlockIDs:         slices.Clone(l.BlockIDs),
		Status:           l.Status,
		CountdownMinutes: l.CountdownMinutes,
		RequestedAt:      fmtMs(l.RequestedAt + offsetMs),
		ReadyAt:          fmtMs(l.ReadyAt + offsetMs),
		ConfirmBy:        at(l.ConfirmBy),
		PenaltyPreview:   l.PenaltyPreview,
		StreakDaysAtRisk: l.StreakDaysAtRisk,
		ResolvedAt:       at(l.ResolvedAt),
		CancelReason:     l.CancelReason,
	}
}

// emergencyPending reports a counting or ready unlock (rewards lock, data deletion).
func (e *Engine) emergencyPending() bool { return e.state.Emergency.Pending != nil }

// blockInPendingEmergency reports whether a pending unlock lists the block
// (Block.emergencyEligible is false then).
func (e *Engine) blockInPendingEmergency(blockID string) bool {
	p := e.state.Emergency.Pending
	return p != nil && slices.Contains(p.BlockIDs, blockID)
}

// emergencyOnReboot cancels a pending unlock after a reboot (reason reboot, §10.2): its
// countdown ran on the old boot clock.
func (e *Engine) emergencyOnReboot() { e.cancelPendingEmergency(emgReasonReboot) }

// ---------------------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------------------

// applyEmergencyRequested records the pending unlock. Its boot-clock deadline is
// anchored to the boot clock of the turn that applies it: the request's own turn live;
// when the startup ladder replays an event state.json missed (a crash right after the
// append), the countdown restarts at the start in full, which only makes it longer.
func (e *Engine) applyEmergencyRequested(ev *storeEvent) error {
	d, err := decode[EmergencyRequestedData](ev)
	if err != nil {
		return err
	}
	em := d.Emergency
	req, ok1 := parseMs(em.RequestedAt)
	ready, ok2 := parseMs(em.ReadyAt)
	if !ok1 || !ok2 || ready < req {
		return fmt.Errorf("seq %d: emergency %s: invalid timestamps", ev.Seq, em.ID)
	}
	boot := e.bootMs()
	e.state.Emergency.Pending = &emergencyRec{
		ID:               em.ID,
		BlockIDs:         slices.Clone(em.BlockIDs),
		CountdownMinutes: em.CountdownMinutes,
		RequestedAt:      req,
		ReadyAt:          ready,
		BootID:           e.bootID,
		RequestedAtBoot:  boot,
		ReadyAtBoot:      boot + (ready - req),
	}
	return nil
}

// resolveEmergency moves the pending unlock to Last with its resolution.
func (e *Engine) resolveEmergency(ev *storeEvent, id string) (*emergencyRec, error) {
	p := e.state.Emergency.Pending
	if p == nil || p.ID != id {
		return nil, fmt.Errorf("seq %d (%s): emergency %s is not pending", ev.Seq, ev.Type, id)
	}
	l := *p
	l.BlockIDs = slices.Clone(p.BlockIDs)
	l.ResolvedAt = ptr(atMs(ev))
	e.state.Emergency.Pending = nil
	e.state.Emergency.Last = &l
	return &l, nil
}

func (e *Engine) applyEmergencyCancelled(ev *storeEvent) error {
	d, err := decode[EmergencyCancelledData](ev)
	if err != nil {
		return err
	}
	l, err := e.resolveEmergency(ev, d.EmergencyID)
	if err != nil {
		return err
	}
	at := *l.ResolvedAt
	l.Status = emgStatusCancelled
	if d.Reason == emgReasonExpired {
		l.Status = emgStatusExpired
	}
	l.CancelReason = ptr(d.Reason)
	if l.Status == emgStatusExpired || (d.Reason != emgReasonReboot && at >= l.ReadyAt) {
		l.ConfirmBy = ptr(l.ReadyAt + emergencyConfirmWindowMs())
	}
	l.PenaltyPreview = points.EmergencyPenalty(e.state.Ledger.Balance+e.allowanceValue(at), points.DefaultPointRules())
	l.StreakDaysAtRisk = points.StreakAsOf(e.state.Ledger, ev.Day, e.goalMinutes())
	return nil
}

func (e *Engine) applyEmergencyConfirmed(ev *storeEvent) error {
	d, err := decode[EmergencyConfirmedData](ev)
	if err != nil {
		return err
	}
	l, err := e.resolveEmergency(ev, d.EmergencyID)
	if err != nil {
		return err
	}
	l.Status = emgStatusConfirmed
	l.CancelReason = nil
	l.ConfirmBy = ptr(l.ReadyAt + emergencyConfirmWindowMs())
	l.PenaltyPreview = d.Penalty
	l.StreakDaysAtRisk = d.StreakDaysLost
	return nil
}
