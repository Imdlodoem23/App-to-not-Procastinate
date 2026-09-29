package engine

// OWNER: Study Mode (docs/ARCHITECTURE.md §5.4, §10.4, §10.5, §8.8 «Study Mode»,
// «POST /v1/nuclear/heartbeat»).
//
// Sessions, phases and eligible time, heartbeats (the only source of focused minutes
// besides the final interval of …/end), pauses, strikes, the end of a session (planned
// end with its final-heartbeat grace, early end, abandonment, third strike,
// interruption), summaries kept 7 days, and the Nuclear supervisor.
//
// State split. What events carry (the session snapshot, pauses, strikes, logged focus
// minutes, the end and its summary, the outcome) is rebuilt by the reducers at the end
// of this file, live and on replay. The time-driven and heartbeat bookkeeping (active,
// work, unclaimed and accepted milliseconds, silence, grace, warnings, the last seq)
// has no event of its own: it lives in studyRec and reaches state.json like a block's
// creditedMs (§10.9), so a crash loses at most the last few seconds of it and never a
// point (points only move with events). Awake-clock readings (the last strike, pause
// starts) are only meaningful in the boot that took them; a reboot ends the session
// (interrupted) before they are read again.

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/points"
)

// Values of domain.ts used by Study Mode.
const (
	studyStatusActive = "active"
	studyStatusPaused = "paused"

	outcomeCompleted   = "completed"
	outcomeEndedEarly  = "ended_early"
	outcomeAbandoned   = "abandoned"
	outcomePunished    = "punished"
	outcomeInterrupted = "interrupted"

	phaseWork   = "work"
	phaseBreak  = "break"
	phasePaused = "paused"
	phaseEnded  = "ended"

	punishCauseThreeStrikes = "three_strikes"
	punishCauseAbandoned    = "abandoned"
	punishLevelNuclear      = "nuclear"

	strikeReasonCooldown  = "cooldown"
	strikeReasonNotInWork = "not_in_work_phase"
)

// Closed sets and bounds of the request validators in guardian-api.ts that the embedded
// data does not carry (HEARTBEAT_STATES, STRIKE_CAUSES, ACHIEVED_VALUES, `seq: int(1,
// I32)`, `displays: int(1, 16)`, `focusScore: int(0, 100)`).
var (
	heartbeatStates  = []string{"focused", "doubt", "away", "break", "paused"}
	strikeCauses     = []string{"doubt_timeout", "no_face", "phone", "distraction_app"}
	achievedValues   = []string{"yes", "partial", "no"}
	punishmentLevels = []string{"distractions", "whitelist", punishLevelNuclear}
)

const (
	heartbeatSeqMax    = 2_147_483_647
	focusScoreMax      = 100
	nuclearDisplaysMin = 1
	nuclearDisplaysMax = 16
	endReasonUser      = "user"
)

// Implementation choices of this file (not contract values).
const (
	// estimateSlackMs: a display estimate (plannedEndsAt, phaseEndsAt, cooldownUntil,
	// nextPauseAvailableAt: now + remaining awake time) keeps its previous value while
	// the fresh one is within this distance, so trusted-clock slew never moves it by a
	// few milliseconds per tick (stateVersion changes only with visible changes, §8.5).
	estimateSlackMs = int64(1000)
	// nuclearRelaunchTimeout bounds one relaunch through the NuclearRelauncher.
	nuclearRelaunchTimeout = 10 * time.Second
)

// studyRules is the embedded STUDY_RULES.
func studyRules() *embedded.StudyRules { return &embedded.Rules().Study }

// studyState is the persisted Study Mode state (state.json "engine.study").
type studyState struct {
	// Sessions are the open session (at most one: active or paused) and the sessions
	// that ended within studyHistoryMs, in start order.
	Sessions []*studyRec `json:"sessions"`

	// nuc is the Nuclear supervisor's memory (boot clock, never persisted: a restart
	// starts it over with a fresh liveness window).
	nuc nuclearMemo
}

// studyRec is a study session in trusted time plus the guardian's bookkeeping.
type studyRec struct {
	// From study_started.
	ID             string           `json:"id"`
	Task           string           `json:"task"`
	PlannedMinutes int64            `json:"plannedMinutes"`
	Pomodoro       *PomodoroSpec    `json:"pomodoro"`
	Camera         bool             `json:"camera"`
	StartedAt      int64            `json:"startedAt"`
	Policy         PunishmentPolicy `json:"policy"`

	// From the other study events.
	Status        string        `json:"status"`
	PauseEndsAt   *int64        `json:"pauseEndsAt"`
	Strikes       int64         `json:"strikes"`
	Attempts      int64         `json:"attempts"`
	LoggedMinutes int64         `json:"loggedMinutes"`
	Points        int64         `json:"points"`
	EndedAt       *int64        `json:"endedAt"`
	Summary       *StudySummary `json:"summary"`
	Achieved      *string       `json:"achieved"`

	// Time-driven and heartbeat bookkeeping (§10.4), in milliseconds.
	//
	// ActiveMs is activeAwakeMs: awake time outside pauses, breaks included, capped at
	// the planned time. WorkMs is its part in work phases. UnclaimedMs is work-phase
	// awake time no heartbeat has claimed yet (capped); AcceptedMs the focus accepted so
	// far. SilentMs is awake time, while the guardian runs, since the last signal (a
	// heartbeat, or a guardian start in the same boot): lastSignalAwake as a counter.
	// GraceMs is awake time since the planned end.
	ActiveMs    int64 `json:"activeMs"`
	WorkMs      int64 `json:"workMs"`
	UnclaimedMs int64 `json:"unclaimedMs"`
	AcceptedMs  int64 `json:"acceptedMs"`
	SilentMs    int64 `json:"silentMs"`
	GraceMs     int64 `json:"graceMs"`
	Warnings    int64 `json:"warnings"`
	// LastSeq and LastHeartbeatAt (trusted) describe the last accepted heartbeat.
	LastSeq         int64  `json:"lastSeq"`
	LastHeartbeatAt *int64 `json:"lastHeartbeatAt"`
	// LastStrikeAwakeMs is the awake-clock reading of the last counted strike (the
	// cooldown runs on awake time) and PauseStartsAwakeMs those of the pauses started
	// within the last pauseWindowMs of awake time.
	LastStrikeAwakeMs  *int64  `json:"lastStrikeAwakeMs"`
	PauseStartsAwakeMs []int64 `json:"pauseStartsAwakeMs"`
	// PlannedEndsAt is the plannedEndsAt estimate (trusted); the planned end itself once
	// reached.
	PlannedEndsAt int64 `json:"plannedEndsAt"`
	// PendingEnd is the outcome of a time-driven end whose batch is not committed yet
	// (abandoned, completed, interrupted): retried every step, never re-decided.
	PendingEnd string `json:"pendingEnd,omitempty"`

	est studyEstimates
}

// studyEstimates are the last display estimates served (see estimateSlackMs).
type studyEstimates struct {
	phaseEnd  int64
	cooldown  int64
	nextPause int64
}

// StartStudyRequest mirrors StartStudyRequest.
type StartStudyRequest struct {
	Task           string        `json:"task"`
	PlannedMinutes int64         `json:"plannedMinutes"`
	Pomodoro       *PomodoroSpec `json:"pomodoro"`
	Camera         bool          `json:"camera"`
}

// StudySessionResponse mirrors StudySessionResponse.
type StudySessionResponse struct {
	Session StudySession `json:"session"`
}

// CurrentStudyResponse mirrors CurrentStudyResponse.
type CurrentStudyResponse struct {
	Session *StudySession `json:"session"`
}

// HeartbeatRequest mirrors HeartbeatRequest.
type HeartbeatRequest struct {
	Seq                int64  `json:"seq"`
	State              string `json:"state"`
	FocusScore         *int64 `json:"focusScore"`
	FocusedMsSinceLast int64  `json:"focusedMsSinceLast"`
	WarningsSinceLast  int64  `json:"warningsSinceLast"`
	CameraOn           bool   `json:"cameraOn"`
}

// HeartbeatResponse mirrors HeartbeatResponse.
type HeartbeatResponse struct {
	Duplicate           bool         `json:"duplicate"`
	AcceptedFocusMs     int64        `json:"acceptedFocusMs"`
	Session             StudySession `json:"session"`
	ServerNow           string       `json:"serverNow"`
	HeartbeatDeadlineMs int64        `json:"heartbeatDeadlineMs"`
}

// StrikeRequest mirrors StrikeRequest.
type StrikeRequest struct {
	Cause string `json:"cause"`
}

// StrikeResponse mirrors StrikeResponse.
type StrikeResponse struct {
	Counted               bool         `json:"counted"`
	Reason                *string      `json:"reason"`
	StrikeNumber          int64        `json:"strikeNumber"`
	PointsDelta           int64        `json:"pointsDelta"`
	PunishmentPointsDelta int64        `json:"punishmentPointsDelta"`
	CooldownUntil         *string      `json:"cooldownUntil"`
	Punishment            *Punishment  `json:"punishment"`
	Session               StudySession `json:"session"`
}

// EndStudyRequest mirrors EndStudyRequest.
type EndStudyRequest struct {
	Reason             string `json:"reason"`
	FocusedMsSinceLast int64  `json:"focusedMsSinceLast"`
	WarningsSinceLast  int64  `json:"warningsSinceLast"`
}

// EndStudyResponse mirrors EndStudyResponse.
type EndStudyResponse struct {
	Session StudySession `json:"session"`
	Summary StudySummary `json:"summary"`
}

// StudyOutcomeRequest mirrors StudyOutcomeRequest.
type StudyOutcomeRequest struct {
	Achieved string `json:"achieved"`
}

// NuclearHeartbeatRequest mirrors NuclearHeartbeatRequest.
type NuclearHeartbeatRequest struct {
	OverlayShown bool  `json:"overlayShown"`
	Displays     int64 `json:"displays"`
}

// NuclearHeartbeatResponse mirrors NuclearHeartbeatResponse.
type NuclearHeartbeatResponse struct {
	NuclearActive bool    `json:"nuclearActive"`
	EndsAt        *string `json:"endsAt"`
	ServerNow     string  `json:"serverNow"`
}

// ---------------------------------------------------------------------------------------
// Commands (exact signatures the API layer calls)
// ---------------------------------------------------------------------------------------

// StartStudy is POST /v1/study/sessions (idempotent, 201).
func (e *Engine) StartStudy(ctx context.Context, r Request, req StartStudyRequest) (StudySessionResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem, status: 201}, func() (StudySessionResponse, error) {
		return e.startStudy(req)
	})
}

// startStudy validates the request, refuses a second open session (409
// study_already_active) and logs study_started with the punishment policy in force
// snapshotted (§8.8). Allowed during punishments and exam blocks.
func (e *Engine) startStudy(req StartStudyRequest) (StudySessionResponse, error) {
	if err := validateStartStudy(req); err != nil {
		return StudySessionResponse{}, err
	}
	if s := e.openStudy(); s != nil {
		return StudySessionResponse{}, apiErr("study_already_active", "a study session is already running",
			map[string]any{"sessionId": s.ID})
	}
	planned := req.PlannedMinutes * msPerMinute
	firstPhase := planned
	if p := req.Pomodoro; p != nil {
		firstPhase = min(planned, p.WorkMinutes*msPerMinute)
	}
	snap := StudySession{
		ID:             newID("stu"),
		Task:           req.Task,
		PlannedMinutes: req.PlannedMinutes,
		Pomodoro:       clonePomodoro(req.Pomodoro),
		Camera:         req.Camera,
		Status:         studyStatusActive,
		Phase:          phaseWork,
		PhaseEndsAt:    ptr(fmtMs(e.now + firstPhase)),
		StartedAt:      fmtMs(e.now),
		PlannedEndsAt:  fmtMs(e.now + planned),
		PausesLeft:     int64(studyRules().MaxPausesPerWindow),
		Policy:         e.studyPolicy(),
	}
	b := e.newBatch()
	b.add(EvStudyStarted, StudyStartedData{Session: snap})
	if err := e.commit(b); err != nil {
		return StudySessionResponse{}, err
	}
	s := e.studySession(snap.ID)
	if s == nil {
		return StudySessionResponse{}, apiErr("internal", "the study session was not recorded", nil)
	}
	return StudySessionResponse{Session: e.studySessionWire(s, e.wallOffsetMs())}, nil
}

// CurrentStudy is GET /v1/study/sessions/current.
func (e *Engine) CurrentStudy(ctx context.Context) (CurrentStudyResponse, error) {
	return run(e, ctx, cmdOpts{}, func() (CurrentStudyResponse, error) { return e.currentStudy() })
}

func (e *Engine) currentStudy() (CurrentStudyResponse, error) {
	return CurrentStudyResponse{Session: e.studyWire(e.wallOffsetMs())}, nil
}

// GetStudySession is GET /v1/study/sessions/{id}.
func (e *Engine) GetStudySession(ctx context.Context, id string) (StudySessionDetail, error) {
	return run(e, ctx, cmdOpts{}, func() (StudySessionDetail, error) { return e.getStudySession(id) })
}

// getStudySession serves the open session or one that ended within studyHistoryMs
// (404 otherwise); summary is null while it is open.
func (e *Engine) getStudySession(id string) (StudySessionDetail, error) {
	s := e.studyVisible(id)
	if s == nil {
		return StudySessionDetail{}, notFound("study session")
	}
	return e.studyDetail(s, e.wallOffsetMs()), nil
}

// StudyHeartbeat is POST /v1/study/sessions/{id}/heartbeat.
func (e *Engine) StudyHeartbeat(ctx context.Context, r Request, id string, req HeartbeatRequest) (HeartbeatResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem}, func() (HeartbeatResponse, error) {
		return e.studyHeartbeat(id, req)
	})
}

// studyHeartbeat accepts min(focusedMsSinceLast, unclaimed work-phase awake time) and
// subtracts it from the unclaimed time, adds the warnings, resets the silence and
// flushes focus_minutes once focusFlushMinutes whole minutes are pending (§10.4). A seq
// that is not above the last one is a no-op (duplicate). During the final-heartbeat
// grace the heartbeat is the last one: the session completes in the same batch.
func (e *Engine) studyHeartbeat(id string, req HeartbeatRequest) (HeartbeatResponse, error) {
	if err := validateHeartbeat(req); err != nil {
		return HeartbeatResponse{}, err
	}
	s, err := e.mutableSession(id)
	if err != nil {
		return HeartbeatResponse{}, err
	}
	res := HeartbeatResponse{
		ServerNow:           e.serverNow(),
		HeartbeatDeadlineMs: int64(studyRules().HeartbeatTimeoutMs),
	}
	if req.Seq <= s.LastSeq {
		res.Duplicate = true
		res.Session = e.studySessionWire(s, e.wallOffsetMs())
		return res, nil
	}
	accepted := min(req.FocusedMsSinceLast, s.UnclaimedMs)
	acceptedTotal := s.AcceptedMs + accepted
	warnings := s.Warnings + req.WarningsSinceLast
	b := e.newBatch()
	if s.inGrace() {
		e.refreshPlannedEnd(s)
		e.addStudyEnd(b, s, studyEnd{outcome: outcomeCompleted, acceptedMs: acceptedTotal, warnings: warnings, strikes: s.Strikes})
	} else if pending := acceptedTotal/msPerMinute - s.LoggedMinutes; pending >= int64(studyRules().FocusFlushMinutes) {
		b.add(EvFocusMinutes, FocusMinutesData{SessionID: s.ID, Minutes: pending})
	}
	if err := e.commit(b); err != nil {
		// The app is alive even though the store refused the flush: a full disk must never
		// turn into abandonment. The focus stays unclaimed for the next heartbeat.
		s.SilentMs = 0
		return HeartbeatResponse{}, err
	}
	s.UnclaimedMs -= accepted
	s.AcceptedMs = acceptedTotal
	s.Warnings = warnings
	s.LastSeq = req.Seq
	s.LastHeartbeatAt = ptr(e.now)
	s.SilentMs = 0
	e.markDirty(false)
	res.AcceptedFocusMs = accepted
	res.Session = e.studySessionWire(s, e.wallOffsetMs())
	return res, nil
}

// StudyStrike is POST /v1/study/sessions/{id}/strike (idempotent).
func (e *Engine) StudyStrike(ctx context.Context, r Request, id string, req StrikeRequest) (StrikeResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem, status: 200}, func() (StrikeResponse, error) {
		return e.studyStrike(id, req)
	})
}

// studyStrike counts a strike the app reports (§10.5): never outside a work phase
// (breaks, pauses, the final grace), never within strikeCooldownMs of awake time after
// the previous counted one. The maxStrikes-th ends the session punished and starts its
// punishment in the same batch.
func (e *Engine) studyStrike(id string, req StrikeRequest) (StrikeResponse, error) {
	if !slices.Contains(strikeCauses, req.Cause) {
		return StrikeResponse{}, issueErr("cause", "enum", "unknown strike cause")
	}
	s, err := e.mutableSession(id)
	if err != nil {
		return StrikeResponse{}, err
	}
	W := e.wallOffsetMs()
	notCounted := func(reason string) (StrikeResponse, error) {
		sess := e.studySessionWire(s, W)
		return StrikeResponse{Reason: &reason, StrikeNumber: s.Strikes, CooldownUntil: sess.CooldownUntil, Session: sess}, nil
	}
	if s.phase() != phaseWork {
		return notCounted(strikeReasonNotInWork)
	}
	if e.studyCooldownLeft(s) > 0 {
		return notCounted(strikeReasonCooldown)
	}
	n := s.Strikes + 1
	b := e.newBatch()
	strikePts := b.add(EvStrike, StrikeData{SessionID: s.ID, StrikeNumber: n, Cause: req.Cause})
	punishing := n >= int64(studyRules().MaxStrikes)
	if punishing {
		e.refreshPlannedEnd(s)
		e.addStudyEnd(b, s, studyEnd{outcome: outcomePunished, acceptedMs: s.AcceptedMs, warnings: s.Warnings, strikes: n, batchPts: strikePts})
	}
	punPts := batchPoints(b, EvPunishmentStarted)
	if err := e.commit(b); err != nil {
		return StrikeResponse{}, err
	}
	sess := e.studySessionWire(s, W)
	res := StrikeResponse{
		Counted:               true,
		StrikeNumber:          n,
		PointsDelta:           strikePts + punPts,
		PunishmentPointsDelta: punPts,
		CooldownUntil:         sess.CooldownUntil,
		Session:               sess,
	}
	if punishing {
		if p := e.studyPunishment(s.ID); p != nil {
			w := punishmentWire(p, W)
			res.Punishment = &w
		}
	}
	return res, nil
}

// PauseStudy is POST /v1/study/sessions/{id}/pause.
func (e *Engine) PauseStudy(ctx context.Context, r Request, id string) (StudySessionResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem}, func() (StudySessionResponse, error) { return e.pauseStudy(id) })
}

// pauseStudy starts a pause of pauseMs (auto-resumed by the step): not while paused
// (409 already_paused), not after the planned end, and at most maxPausesPerWindow
// starts within the last pauseWindowMs of awake time (409 pause_quota_exhausted with
// details.nextPauseAt).
func (e *Engine) pauseStudy(id string) (StudySessionResponse, error) {
	s, err := e.mutableSession(id)
	if err != nil {
		return StudySessionResponse{}, err
	}
	if s.Status == studyStatusPaused {
		return StudySessionResponse{}, apiErr("already_paused", "the session is already paused", nil)
	}
	if s.inGrace() {
		return StudySessionResponse{}, apiErr("study_not_active", "the planned time of the session is over",
			map[string]any{"status": s.Status, "phase": phaseEnded})
	}
	if left, next := e.studyPauseQuota(s); left <= 0 && next != nil {
		return StudySessionResponse{}, apiErr("pause_quota_exhausted", "no pause left in this window",
			map[string]any{"nextPauseAt": e.display(*next)})
	}
	b := e.newBatch()
	b.add(EvStudyPaused, StudyPausedData{SessionID: s.ID, PauseEndsAt: fmtMs(e.now + int64(studyRules().PauseMs))})
	if err := e.commit(b); err != nil {
		return StudySessionResponse{}, err
	}
	return StudySessionResponse{Session: e.studySessionWire(s, e.wallOffsetMs())}, nil
}

// ResumeStudy is POST /v1/study/sessions/{id}/resume.
func (e *Engine) ResumeStudy(ctx context.Context, r Request, id string) (StudySessionResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem}, func() (StudySessionResponse, error) { return e.resumeStudy(id) })
}

// resumeStudy ends the open pause (409 not_paused otherwise).
func (e *Engine) resumeStudy(id string) (StudySessionResponse, error) {
	s, err := e.mutableSession(id)
	if err != nil {
		return StudySessionResponse{}, err
	}
	if s.Status != studyStatusPaused {
		return StudySessionResponse{}, apiErr("not_paused", "the session is not paused", nil)
	}
	b := e.newBatch()
	b.add(EvStudyResumed, StudyResumedData{SessionID: s.ID, Auto: false})
	if err := e.commit(b); err != nil {
		return StudySessionResponse{}, err
	}
	return StudySessionResponse{Session: e.studySessionWire(s, e.wallOffsetMs())}, nil
}

// EndStudy is POST /v1/study/sessions/{id}/end (idempotent; idempotent by state too).
func (e *Engine) EndStudy(ctx context.Context, r Request, id string, req EndStudyRequest) (EndStudyResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem, status: 200}, func() (EndStudyResponse, error) {
		return e.endStudy(id, req)
	})
}

// endStudy closes the last interval like a heartbeat (against eligible time up to now)
// and decides the outcome: completed when at most completionGraceMs of planned active
// time remained, else ended_early; no penalty (§10.4). On a session that already ended
// (whoever ended it) it returns the stored summary.
func (e *Engine) endStudy(id string, req EndStudyRequest) (EndStudyResponse, error) {
	if err := validateEndStudy(req); err != nil {
		return EndStudyResponse{}, err
	}
	s := e.studyVisible(id)
	if s == nil {
		return EndStudyResponse{}, notFound("study session")
	}
	W := e.wallOffsetMs()
	if s.open() && s.PendingEnd != "" {
		// A time-driven end is waiting for the store: it wins over this request.
		e.refreshPlannedEnd(s)
		b := e.newBatch()
		e.addStudyEnd(b, s, studyEnd{outcome: s.PendingEnd, acceptedMs: s.AcceptedMs, warnings: s.Warnings, strikes: s.Strikes})
		if err := e.commit(b); err != nil {
			return EndStudyResponse{}, err
		}
	}
	if !s.open() {
		return EndStudyResponse{Session: e.studySessionWire(s, W), Summary: s.summaryOrZero()}, nil
	}
	accepted := min(req.FocusedMsSinceLast, s.UnclaimedMs)
	acceptedTotal := s.AcceptedMs + accepted
	warnings := s.Warnings + req.WarningsSinceLast
	outcome := outcomeEndedEarly
	if s.plannedMs()-min(s.ActiveMs, s.plannedMs()) <= int64(studyRules().CompletionGraceMs) {
		outcome = outcomeCompleted
	}
	e.refreshPlannedEnd(s)
	b := e.newBatch()
	e.addStudyEnd(b, s, studyEnd{outcome: outcome, acceptedMs: acceptedTotal, warnings: warnings, strikes: s.Strikes})
	if err := e.commit(b); err != nil {
		return EndStudyResponse{}, err
	}
	s.UnclaimedMs -= accepted
	s.AcceptedMs = acceptedTotal
	s.Warnings = warnings
	e.markDirty(false)
	return EndStudyResponse{Session: e.studySessionWire(s, W), Summary: s.summaryOrZero()}, nil
}

// SetStudyOutcome is POST /v1/study/sessions/{id}/outcome.
func (e *Engine) SetStudyOutcome(ctx context.Context, r Request, id string, req StudyOutcomeRequest) (StudySessionResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem}, func() (StudySessionResponse, error) {
		return e.setStudyOutcome(id, req)
	})
}

// setStudyOutcome records «¿Lo has conseguido?» once, within outcomeWindowMs of the end
// (409 outcome_already_set, 409 outcome_window_closed; 404 after studyHistoryMs). An
// open session has no window yet (outcome_window_closed, details.reason not_ended).
func (e *Engine) setStudyOutcome(id string, req StudyOutcomeRequest) (StudySessionResponse, error) {
	if !slices.Contains(achievedValues, req.Achieved) {
		return StudySessionResponse{}, issueErr("achieved", "enum", "yes, partial or no")
	}
	s := e.studyVisible(id)
	if s == nil {
		return StudySessionResponse{}, notFound("study session")
	}
	if s.open() || s.EndedAt == nil {
		return StudySessionResponse{}, apiErr("outcome_window_closed", "the session has not ended yet",
			map[string]any{"reason": "not_ended"})
	}
	if s.Achieved != nil {
		return StudySessionResponse{}, apiErr("outcome_already_set", "the outcome was already recorded", nil)
	}
	if e.now-*s.EndedAt > int64(studyRules().OutcomeWindowMs) {
		return StudySessionResponse{}, apiErr("outcome_window_closed", "the outcome window is over",
			map[string]any{"reason": "expired"})
	}
	b := e.newBatch()
	b.add(EvStudyOutcome, StudyOutcomeData{SessionID: s.ID, Achieved: req.Achieved})
	if err := e.commit(b); err != nil {
		return StudySessionResponse{}, err
	}
	return StudySessionResponse{Session: e.studySessionWire(s, e.wallOffsetMs())}, nil
}

// NuclearHeartbeat is POST /v1/nuclear/heartbeat (the API layer checked the peer is the
// app at appPath in the console session, §10.5).
func (e *Engine) NuclearHeartbeat(ctx context.Context, r Request, req NuclearHeartbeatRequest) (NuclearHeartbeatResponse, error) {
	return run(e, ctx, cmdOpts{}, func() (NuclearHeartbeatResponse, error) { return e.nuclearHeartbeat(req) })
}

// nuclearHeartbeat records the overlay's liveness signal (only overlayShown: true while
// Nuclear is active counts) and answers with the latest Nuclear end. It changes no block
// or punishment.
func (e *Engine) nuclearHeartbeat(req NuclearHeartbeatRequest) (NuclearHeartbeatResponse, error) {
	if req.Displays < nuclearDisplaysMin || req.Displays > nuclearDisplaysMax {
		return NuclearHeartbeatResponse{}, issueErr("displays", "range",
			fmt.Sprintf("integer in [%d, %d]", nuclearDisplaysMin, nuclearDisplaysMax))
	}
	n, active := e.nuclearSync()
	if active && req.OverlayShown {
		n.heartbeat, n.hasHeartbeat = e.bootNow, true
	}
	res := NuclearHeartbeatResponse{NuclearActive: active, ServerNow: e.serverNow()}
	var end *int64
	for _, p := range e.state.Punishments {
		if p.Status == StatusActive && p.Level == punishLevelNuclear && (end == nil || p.EndsAt > *end) {
			end = ptr(p.EndsAt)
		}
	}
	res.EndsAt = e.displayPtr(end)
	return res, nil
}

// ReportLogoff tells the engine that the console session logged off
// (WTS_SESSION_LOGOFF, logind session removal): an open study session ends interrupted,
// with its pending focus flushed and no penalty or bonus (§10.4). The OS layer calls it;
// a batch the store refuses is retried by the step.
func (e *Engine) ReportLogoff(ctx context.Context) error {
	return e.exec(ctx, func() {
		if !e.opened {
			return
		}
		e.timeStep()
		if s := e.openStudy(); s != nil {
			if s.PendingEnd == "" {
				s.PendingEnd = outcomeInterrupted
			}
			e.endStudyNow(s)
		}
		e.afterTurn()
	})
}

// ---------------------------------------------------------------------------------------
// Validation (defence in depth after the API layer's strict decoding, §8.1)
// ---------------------------------------------------------------------------------------

func rangeIssue(path string, v, lo, hi int64) *APIError {
	if v < lo || v > hi {
		return issueErr(path, "range", fmt.Sprintf("integer in [%d, %d]", lo, hi))
	}
	return nil
}

func validateStartStudy(req StartStudyRequest) *APIError {
	r := studyRules()
	if issue := catalog.TextFieldIssue(catalog.FieldTask, req.Task); issue != "" {
		return issueErr("task", issue, "invalid task")
	}
	if err := rangeIssue("plannedMinutes", req.PlannedMinutes, int64(r.PlannedMinutes.Min), int64(r.PlannedMinutes.Max)); err != nil {
		return err
	}
	if p := req.Pomodoro; p != nil {
		if err := rangeIssue("pomodoro.workMinutes", p.WorkMinutes, int64(r.PomodoroWorkMinutes.Min), int64(r.PomodoroWorkMinutes.Max)); err != nil {
			return err
		}
		if err := rangeIssue("pomodoro.breakMinutes", p.BreakMinutes, int64(r.PomodoroBreakMinutes.Min), int64(r.PomodoroBreakMinutes.Max)); err != nil {
			return err
		}
	}
	return nil
}

func validateHeartbeat(req HeartbeatRequest) *APIError {
	l := limits()
	if err := rangeIssue("seq", req.Seq, 1, heartbeatSeqMax); err != nil {
		return err
	}
	if !slices.Contains(heartbeatStates, req.State) {
		return issueErr("state", "enum", "unknown heartbeat state")
	}
	if req.FocusScore != nil {
		if err := rangeIssue("focusScore", *req.FocusScore, 0, focusScoreMax); err != nil {
			return err
		}
	}
	if err := rangeIssue("focusedMsSinceLast", req.FocusedMsSinceLast, 0, int64(l.HeartbeatMaxFocusMs)); err != nil {
		return err
	}
	return rangeIssue("warningsSinceLast", req.WarningsSinceLast, 0, int64(l.HeartbeatMaxWarnings))
}

func validateEndStudy(req EndStudyRequest) *APIError {
	l := limits()
	if req.Reason != endReasonUser {
		return issueErr("reason", "enum", `expected "user"`)
	}
	if err := rangeIssue("focusedMsSinceLast", req.FocusedMsSinceLast, 0, int64(l.HeartbeatMaxFocusMs)); err != nil {
		return err
	}
	return rangeIssue("warningsSinceLast", req.WarningsSinceLast, 0, int64(l.HeartbeatMaxWarnings))
}

// ---------------------------------------------------------------------------------------
// Sessions: lookup, phases, estimates, wire
// ---------------------------------------------------------------------------------------

// studyPolicy is settings.punishment as a valid snapshot (§5.4): a level or a number of
// minutes outside the contract (a state written by another version) falls back to the
// embedded default, so a punishment always has a known level and a valid length.
func (e *Engine) studyPolicy() PunishmentPolicy {
	p := e.state.Settings.Punishment
	r := studyRules()
	if !slices.Contains(punishmentLevels, p.Level) {
		p.Level = r.DefaultPunishmentLevel
	}
	if p.Minutes < r.PunishmentMinutes.Min || p.Minutes > r.PunishmentMinutes.Max {
		p.Minutes = r.PunishmentMinutes.Default
	}
	return p
}

// studySession returns the session with that id (any status), or nil.
func (e *Engine) studySession(id string) *studyRec {
	for _, s := range e.state.Study.Sessions {
		if s.ID == id {
			return s
		}
	}
	return nil
}

// openStudy returns the active or paused session, or nil.
func (e *Engine) openStudy() *studyRec {
	for _, s := range e.state.Study.Sessions {
		if s.open() {
			return s
		}
	}
	return nil
}

// studyVisible returns the session if it is open or ended within studyHistoryMs.
func (e *Engine) studyVisible(id string) *studyRec {
	s := e.studySession(id)
	if s == nil || (!s.open() && s.EndedAt != nil && *s.EndedAt < e.now-int64(limits().StudyHistoryMs)) {
		return nil
	}
	return s
}

// mutableSession is the target of a heartbeat, strike, pause or resume: 404 when
// unknown, 409 study_not_active (details.status) when it ended or its end is pending.
func (e *Engine) mutableSession(id string) (*studyRec, error) {
	s := e.studyVisible(id)
	if s == nil {
		return nil, notFound("study session")
	}
	if !s.open() {
		return nil, apiErr("study_not_active", "the study session has ended", map[string]any{"status": s.Status})
	}
	if s.PendingEnd != "" {
		return nil, apiErr("study_not_active", "the study session is ending", map[string]any{"status": s.PendingEnd})
	}
	return s, nil
}

// studyPunishment returns the latest punishment of a session, or nil.
func (e *Engine) studyPunishment(sessionID string) *punishmentRec {
	var out *punishmentRec
	for _, p := range e.state.Punishments {
		if p.SessionID != nil && *p.SessionID == sessionID {
			out = p
		}
	}
	return out
}

func (s *studyRec) open() bool { return s.Status == studyStatusActive || s.Status == studyStatusPaused }

func (s *studyRec) plannedMs() int64 { return s.PlannedMinutes * msPerMinute }

// inGrace: the planned active time is over and the final heartbeat is awaited.
func (s *studyRec) inGrace() bool {
	return s.Status == studyStatusActive && s.ActiveMs >= s.plannedMs()
}

// pomodoroMs returns the work length and the cycle length (work + break) in ms.
func (s *studyRec) pomodoroMs() (work, cycle int64, ok bool) {
	if s.Pomodoro == nil {
		return 0, 0, false
	}
	work = s.Pomodoro.WorkMinutes * msPerMinute
	cycle = work + s.Pomodoro.BreakMinutes*msPerMinute
	return work, cycle, work > 0 && cycle > 0
}

// workUpTo is the work-phase part of the first x ms of active time: without Pomodoro
// all of it; with Pomodoro the part where activeAwakeMs mod (work+break) < work.
func (s *studyRec) workUpTo(x int64) int64 {
	w, c, ok := s.pomodoroMs()
	if !ok {
		return x
	}
	return (x/c)*w + min(x%c, w)
}

// phase is the guardian-computed phase (§10.4).
func (s *studyRec) phase() string {
	switch {
	case !s.open() || s.inGrace():
		return phaseEnded
	case s.Status == studyStatusPaused:
		return phasePaused
	}
	if w, c, ok := s.pomodoroMs(); ok && s.ActiveMs%c >= w {
		return phaseBreak
	}
	return phaseWork
}

// phaseLeftMs is the active time until the next phase change of a running session.
func (s *studyRec) phaseLeftMs() int64 {
	left := s.plannedMs() - s.ActiveMs
	if w, c, ok := s.pomodoroMs(); ok {
		if pos := s.ActiveMs % c; pos < w {
			left = min(left, w-pos)
		} else {
			left = min(left, c-pos)
		}
	}
	return left
}

func (s *studyRec) summaryOrZero() StudySummary {
	if s.Summary == nil {
		return StudySummary{Outcome: s.Status}
	}
	return *s.Summary
}

// stableEstimate keeps *prev while fresh is within estimateSlackMs of it.
func stableEstimate(prev *int64, fresh int64) int64 {
	if d := fresh - *prev; *prev != 0 && d > -estimateSlackMs && d < estimateSlackMs {
		return *prev
	}
	*prev = fresh
	return fresh
}

// studyPlannedEnd is the plannedEndsAt estimate: now (or the pause end) plus the
// remaining active time; the planned end itself once reached; frozen at the end.
func (e *Engine) studyPlannedEnd(s *studyRec) int64 {
	switch {
	case !s.open() || s.inGrace():
		return s.PlannedEndsAt
	case s.Status == studyStatusPaused && s.PauseEndsAt != nil:
		return stableEstimate(&s.PlannedEndsAt, max(*s.PauseEndsAt, e.now)+s.plannedMs()-s.ActiveMs)
	}
	return stableEstimate(&s.PlannedEndsAt, e.now+s.plannedMs()-s.ActiveMs)
}

// refreshPlannedEnd brings the stored estimate up to date before the session ends.
func (e *Engine) refreshPlannedEnd(s *studyRec) { _ = e.studyPlannedEnd(s) }

// studyPhaseEnd is the phaseEndsAt estimate (the pause end while paused).
func (e *Engine) studyPhaseEnd(s *studyRec) *int64 {
	switch s.phase() {
	case phasePaused:
		if s.PauseEndsAt != nil {
			return ptr(*s.PauseEndsAt)
		}
		return nil
	case phaseWork, phaseBreak:
		left := s.phaseLeftMs()
		if left == s.plannedMs()-s.ActiveMs {
			return ptr(e.studyPlannedEnd(s))
		}
		return ptr(stableEstimate(&s.est.phaseEnd, e.now+left))
	}
	return nil
}

// studyCooldownLeft is the awake time until a new strike may count (0: none).
func (e *Engine) studyCooldownLeft(s *studyRec) int64 {
	if !s.open() || s.LastStrikeAwakeMs == nil {
		return 0
	}
	since := e.awakeNow.Milliseconds() - *s.LastStrikeAwakeMs
	if since < 0 {
		return 0 // a reading of another boot
	}
	return max(0, int64(studyRules().StrikeCooldownMs)-since)
}

// studyPausesInWindow are the pause starts within the last pauseWindowMs of awake time,
// oldest first.
func (e *Engine) studyPausesInWindow(s *studyRec) []int64 {
	now := e.awakeNow.Milliseconds()
	win := int64(studyRules().PauseWindowMs)
	out := []int64{}
	for _, at := range s.PauseStartsAwakeMs {
		if d := now - at; d >= 0 && d < win {
			out = append(out, at)
		}
	}
	slices.Sort(out)
	return out
}

// studyPauseQuota returns the pauses left and, when none is, when the next one becomes
// available (trusted estimate).
func (e *Engine) studyPauseQuota(s *studyRec) (int64, *int64) {
	in := e.studyPausesInWindow(s)
	maxP := studyRules().MaxPausesPerWindow
	if len(in) < maxP {
		s.est.nextPause = 0
		return int64(maxP - len(in)), nil
	}
	// The pause whose start leaves the window first frees one.
	freed := in[len(in)-maxP]
	next := e.now + freed + int64(studyRules().PauseWindowMs) - e.awakeNow.Milliseconds()
	return 0, ptr(stableEstimate(&s.est.nextPause, next))
}

// studySessionWire converts a session to its wire form (offsetMs as in blockWire).
// Per-tick counters are whole minutes (§8.5).
func (e *Engine) studySessionWire(s *studyRec, off int64) StudySession {
	at := func(ms int64) string { return fmtMs(ms + off) }
	atp := func(ms *int64) *string {
		if ms == nil {
			return nil
		}
		return ptr(at(*ms))
	}
	w := StudySession{
		ID:               s.ID,
		Task:             s.Task,
		PlannedMinutes:   s.PlannedMinutes,
		Pomodoro:         clonePomodoro(s.Pomodoro),
		Camera:           s.Camera,
		Status:           s.Status,
		Phase:            s.phase(),
		StartedAt:        at(s.StartedAt),
		EndedAt:          atp(s.EndedAt),
		Strikes:          s.Strikes,
		Attempts:         s.Attempts,
		LastHeartbeatAt:  atp(s.LastHeartbeatAt),
		LastHeartbeatSeq: s.LastSeq,
		Warnings:         s.Warnings,
		Policy:           s.Policy,
	}
	if s.Achieved != nil {
		w.Achieved = ptr(*s.Achieved)
	}
	if !s.open() {
		w.PlannedEndsAt = at(s.PlannedEndsAt)
		if sum := s.Summary; sum != nil {
			w.ActiveMinutes, w.FocusedMinutes, w.Warnings = sum.ActiveMinutes, sum.FocusedMinutes, sum.Warnings
		}
		return w
	}
	w.PlannedEndsAt = at(e.studyPlannedEnd(s))
	w.PhaseEndsAt = atp(e.studyPhaseEnd(s))
	w.ActiveMinutes = min(s.ActiveMs, s.plannedMs()) / msPerMinute
	w.FocusedMinutes = max(s.LoggedMinutes, s.AcceptedMs/msPerMinute)
	if left := e.studyCooldownLeft(s); left > 0 {
		w.CooldownUntil = ptr(at(stableEstimate(&s.est.cooldown, e.now+left)))
	} else {
		s.est.cooldown = 0
	}
	left, next := e.studyPauseQuota(s)
	w.PausesLeft, w.NextPauseAvailableAt = left, atp(next)
	return w
}

// studyDetail is a StudySessionDetail (summary null while open).
func (e *Engine) studyDetail(s *studyRec, off int64) StudySessionDetail {
	d := StudySessionDetail{Session: e.studySessionWire(s, off)}
	if !s.open() && s.Summary != nil {
		sum := *s.Summary
		d.Summary = &sum
	}
	return d
}

func clonePomodoro(p *PomodoroSpec) *PomodoroSpec {
	if p == nil {
		return nil
	}
	c := *p
	return &c
}

// roundMinutes rounds milliseconds to the nearest whole minute, half a minute up.
func roundMinutes(ms int64) int64 { return (max(0, ms) + msPerMinute/2) / msPerMinute }

// batchPoints sums the recorded points of the events of one type in b.
func batchPoints(b *batch, typ string) int64 {
	var sum int64
	for _, ev := range b.events {
		if ev.Type == typ {
			sum += ev.Points
		}
	}
	return sum
}

// ---------------------------------------------------------------------------------------
// The end of a session
// ---------------------------------------------------------------------------------------

// studyEnd describes how a session ends.
type studyEnd struct {
	outcome string
	// acceptedMs is the total accepted focus (the interval a heartbeat or …/end closes
	// included: those counters are only written after the commit).
	acceptedMs int64
	warnings   int64
	strikes    int64
	// batchPts are the recorded points of session events already in the batch (the
	// punishing strike).
	batchPts int64
}

// addStudyEnd adds the end of a session to b (§7.2 batches): [focus_minutes] with the
// remaining accepted time rounded to the nearest minute, study_ended with the whole
// «Resumen» (and the clean bonus, derived by the ledger), then for abandoned and
// punished the punishment tail of §10.5 with the policy snapshotted at start. It
// returns the summary it logs.
func (e *Engine) addStudyEnd(b *batch, s *studyRec, in studyEnd) StudySummary {
	pr := points.DefaultPointRules()
	pts := in.batchPts
	final := max(0, roundMinutes(in.acceptedMs)-s.LoggedMinutes)
	if final > 0 {
		pts += b.add(EvFocusMinutes, FocusMinutesData{SessionID: s.ID, Minutes: final})
	}
	focused := s.LoggedMinutes + final
	work := roundMinutes(s.WorkMs)
	var pct int64
	if work > 0 {
		pct = min(100, (200*focused+work)/(2*work))
	}
	bonus := points.StudyEndBonus(in.outcome, in.strikes, s.Attempts, s.PlannedMinutes, pr)
	punish := in.outcome == outcomeAbandoned || in.outcome == outcomePunished
	var punPts int64
	if punish {
		punPts = -int64(pr.PunishmentPenalty)
	}
	sum := StudySummary{
		Outcome:        in.outcome,
		ActiveMinutes:  roundMinutes(min(s.ActiveMs, s.plannedMs())),
		WorkMinutes:    work,
		FocusedMinutes: focused,
		FocusPct:       pct,
		Strikes:        in.strikes,
		Warnings:       in.warnings,
		Attempts:       s.Attempts,
		PointsTotal:    s.Points + pts + bonus + punPts,
		CleanBonus:     bonus,
	}
	if got := b.add(EvStudyEnded, StudyEndedData{
		SessionID:      s.ID,
		Outcome:        sum.Outcome,
		PlannedMinutes: s.PlannedMinutes,
		ActiveMinutes:  sum.ActiveMinutes,
		WorkMinutes:    sum.WorkMinutes,
		FocusedMinutes: sum.FocusedMinutes,
		FocusPct:       sum.FocusPct,
		Strikes:        sum.Strikes,
		Warnings:       sum.Warnings,
		Attempts:       sum.Attempts,
		PointsTotal:    sum.PointsTotal,
		CleanBonus:     sum.CleanBonus,
	}); got != bonus {
		e.log.Error("study_ended bonus differs from the ledger", "want", bonus, "got", got)
	}
	if punish {
		cause := punishCauseThreeStrikes
		if in.outcome == outcomeAbandoned {
			cause = punishCauseAbandoned
		}
		id := s.ID
		e.addPunishmentEvents(b, &id, s.Task, cause, s.Policy)
		if got := batchPoints(b, EvPunishmentStarted); got != punPts {
			e.log.Error("punishment points differ from the ledger", "want", punPts, "got", got)
		}
	}
	return sum
}

// endStudyNow commits the time-driven end in s.PendingEnd (retried by the next step when
// the store refuses it).
func (e *Engine) endStudyNow(s *studyRec) {
	e.refreshPlannedEnd(s)
	b := e.newBatch()
	e.addStudyEnd(b, s, studyEnd{outcome: s.PendingEnd, acceptedMs: s.AcceptedMs, warnings: s.Warnings, strikes: s.Strikes})
	e.commitNow(b, "study end")
}

// ---------------------------------------------------------------------------------------
// Hooks the core calls
// ---------------------------------------------------------------------------------------

// studyStep is the time-driven part of Study Mode (§10.4): phases, eligible time,
// the planned end and its final-heartbeat grace, abandonment (→ punishment), pause
// auto-resume. dAwakeMs is the awake time of this tick (clamped 0–10 s).
func (e *Engine) studyStep(dAwakeMs, T int64) {
	e.pruneStudy(T)
	s := e.openStudy()
	if s == nil {
		return
	}
	if s.PendingEnd != "" {
		e.endStudyNow(s)
		return
	}
	e.prunePauseStarts(s)
	r := studyRules()
	// Silence only counts while the API can accept heartbeats (not in frozen or safe
	// mode, where every write answers 503).
	listening := e.writable() == nil
	outcome := ""
	switch s.Status {
	case studyStatusPaused:
		resume := s.PauseEndsAt != nil && T >= *s.PauseEndsAt
		var after int64
		if resume {
			after = min(dAwakeMs, max(0, T-*s.PauseEndsAt))
		}
		if listening {
			s.SilentMs += dAwakeMs - after
		}
		if s.SilentMs > int64(r.HeartbeatTimeoutMs) {
			outcome = outcomeAbandoned
			break
		}
		if !resume {
			return
		}
		b := e.newBatch()
		b.add(EvStudyResumed, StudyResumedData{SessionID: s.ID, Auto: true})
		if !e.commitNow(b, "study auto-resume") {
			return
		}
		outcome = e.studyAccrue(s, after, T, listening)
	case studyStatusActive:
		outcome = e.studyAccrue(s, dAwakeMs, T, listening)
	}
	if outcome != "" {
		s.PendingEnd = outcome
		e.endStudyNow(s)
	}
}

// studyAccrue adds d ms of awake time to an active session: active and work time,
// unclaimed eligible time (capped), silence (when listening), the planned end and its
// grace. It returns the outcome that ends the session now, or "". Abandonment is never
// decided after the planned end; completion waits finalHeartbeatGraceMs of awake time
// for the last heartbeat.
func (e *Engine) studyAccrue(s *studyRec, d, T int64, listening bool) string {
	r := studyRules()
	planned := s.plannedMs()
	if s.ActiveMs < planned {
		add := min(d, planned-s.ActiveMs)
		work := s.workUpTo(s.ActiveMs+add) - s.workUpTo(s.ActiveMs)
		s.ActiveMs += add
		s.WorkMs += work
		s.UnclaimedMs = min(int64(limits().HeartbeatMaxFocusMs), s.UnclaimedMs+work)
		if listening {
			s.SilentMs += add
		}
		if s.SilentMs > int64(r.HeartbeatTimeoutMs) {
			return outcomeAbandoned
		}
		if s.ActiveMs < planned {
			return ""
		}
		s.GraceMs = d - add
		s.PlannedEndsAt = T - s.GraceMs
	} else {
		s.GraceMs += d
	}
	if s.GraceMs >= int64(r.FinalHeartbeatGraceMs) {
		return outcomeCompleted
	}
	return ""
}

// pruneStudy forgets sessions that ended more than studyHistoryMs ago.
func (e *Engine) pruneStudy(T int64) {
	cut := T - int64(limits().StudyHistoryMs)
	st := &e.state.Study
	st.Sessions = slices.DeleteFunc(st.Sessions, func(s *studyRec) bool {
		return !s.open() && s.EndedAt != nil && *s.EndedAt < cut
	})
}

// prunePauseStarts drops pause starts outside the quota window (or of another boot).
func (e *Engine) prunePauseStarts(s *studyRec) {
	if len(s.PauseStartsAwakeMs) == 0 {
		return
	}
	in := e.studyPausesInWindow(s)
	if len(in) != len(s.PauseStartsAwakeMs) {
		s.PauseStartsAwakeMs = in
	}
}

// studyWire is /v1/state.study: the active session in display time (offsetMs = W), or
// nil. Keep per-tick counters at whole-minute granularity (the stateVersion rule).
func (e *Engine) studyWire(offsetMs int64) *StudySession {
	s := e.openStudy()
	if s == nil {
		return nil
	}
	w := e.studySessionWire(s, offsetMs)
	return &w
}

// studyRecentEnded is /v1/state.recent.endedStudy: the last session for 2 min after it
// ended, with its summary, or nil.
func (e *Engine) studyRecentEnded(offsetMs int64) *StudySessionDetail {
	var last *studyRec
	for _, s := range e.state.Study.Sessions {
		if !s.open() && s.EndedAt != nil && (last == nil || *s.EndedAt >= *last.EndedAt) {
			last = s
		}
	}
	if last == nil || *last.EndedAt < e.now-int64(limits().RecentEndedStudyMs) {
		return nil
	}
	d := e.studyDetail(last, offsetMs)
	return &d
}

// studyActive reports whether a session is active or paused (rewards lock «study»).
func (e *Engine) studyActive() bool { return e.openStudy() != nil }

// studyPendingFocusMinutes are the accepted whole minutes not logged yet (§5.9).
func (e *Engine) studyPendingFocusMinutes() int64 {
	s := e.openStudy()
	if s == nil {
		return 0
	}
	return max(0, s.AcceptedMs/msPerMinute-s.LoggedMinutes)
}

// studyFlushForDayClose adds the whole focus minutes of the day that ends to b (it is
// stamped with that day); the remainder carries to the new day (§10.4).
func (e *Engine) studyFlushForDayClose(b *batch) {
	s := e.openStudy()
	if s == nil {
		return
	}
	if pending := s.AcceptedMs/msPerMinute - s.LoggedMinutes; pending > 0 {
		b.add(EvFocusMinutes, FocusMinutesData{SessionID: s.ID, Minutes: pending})
	}
}

// studyOnStart runs at startup (§10.4, §10.12 step 8): after a reboot an open session
// ends interrupted; in the same boot lastSignalAwake becomes the start moment.
func (e *Engine) studyOnStart(sameBoot bool) {
	s := e.openStudy()
	if s == nil {
		return
	}
	if sameBoot {
		s.SilentMs = 0
		return
	}
	if s.PendingEnd == "" {
		s.PendingEnd = outcomeInterrupted
	}
	// The session ran before the reboot, in the last day the guardian kept open: like the
	// day_closed flush (days.go), its leftover minutes are stamped with that day, which
	// the startup catch-up closes right after. A retry by the step uses the current day.
	e.refreshPlannedEnd(s)
	b := e.newBatch()
	if open := e.state.OpenDay; open != "" && open < b.day {
		b.day = open
	}
	e.addStudyEnd(b, s, studyEnd{outcome: s.PendingEnd, acceptedMs: s.AcceptedMs, warnings: s.Warnings, strikes: s.Strikes})
	e.commitNow(b, "study end at startup")
}

// studyNoteAttempt is for the attempts reducer (applyAttempt, attempts.go): a counted
// attempt while a session is open increases its attempts (no clean bonus then) and its
// pointsTotal (§8.8). points is the attempt event's recorded delta.
func (e *Engine) studyNoteAttempt(points int64) {
	if s := e.openStudy(); s != nil {
		s.Attempts++
		s.Points += points
	}
}

// ---------------------------------------------------------------------------------------
// Nuclear supervisor (§10.5)
//
// The OS side is Options.Nuclear (NuclearRelauncher, deps.go; FakeRelauncher in
// fakes.go). What a real implementation must do (a later task, per OS):
//   - AppRunning: true only for a process in the active console session whose full image
//     path equals config.json appPath (admin-owned); never a match by name or bundle id.
//     It returns an error when it cannot tell (the supervisor then relies on the overlay
//     heartbeat alone).
//   - Relaunch: start appPath with the constant argument --centrate-nuclear as the console
//     user, never as root/SYSTEM (Windows: WTSGetActiveConsoleSessionId, WTSQueryUserToken,
//     CreateProcessAsUserW; macOS: launchctl kickstart gui/<uid>/<nuclear LaunchAgent>;
//     Linux: systemctl --user --machine=<uid>@.host start centrate-nuclear.service for the
//     seat0 user). Fixed argv only: nothing from requests or state ever reaches it (§9.7).
//     It must honour ctx (bounded by nuclearRelaunchTimeout) and return an error when no
//     console user is logged in; the supervisor retries at the next tick.
//
// Both are called off the engine goroutine while the loop runs.
// ---------------------------------------------------------------------------------------

// nuclearMemo is the supervisor's memory for the current Nuclear period (boot clock).
type nuclearMemo struct {
	active bool
	// since is when this Nuclear period started (or the guardian started during one):
	// the app gets nuclearLivenessMs from then to show the overlay by itself.
	since        time.Duration
	heartbeat    time.Duration
	hasHeartbeat bool
	relaunched   time.Duration
	hasRelaunch  bool
	inFlight     bool
	failing      bool
	relaunches   int
}

// nuclearSync follows e.nuclearActive(): a new period starts a fresh memory.
func (e *Engine) nuclearSync() (*nuclearMemo, bool) {
	n := &e.state.Study.nuc
	if !e.nuclearActive() {
		if n.active {
			*n = nuclearMemo{inFlight: n.inFlight, relaunches: n.relaunches}
		}
		return n, false
	}
	if !n.active {
		n.active, n.since = true, e.bootNow
	}
	return n, true
}

// nuclearNeedsRelaunch decides from one AppRunning answer: the app is alive only when
// its process runs from appPath in the console session AND an overlay heartbeat arrived
// within nuclearLivenessMs (silent is false). A failed process check falls back to the
// heartbeat alone.
func nuclearNeedsRelaunch(running bool, err error, silent bool) bool {
	if err == nil && !running {
		return true
	}
	return silent
}

// nuclearReconcile is the Nuclear supervisor (§10.5), every step: while
// e.nuclearActive(), relaunch the app through e.o.Nuclear when it is not alive.
//
// Every tick (2 s, within the contract's 3 s) it asks AppRunning; a process that is gone
// is relaunched at once, a process without an overlay heartbeat for nuclearLivenessMs
// (counted from the last heartbeat, the start of the period or the last relaunch) is
// relaunched too; at most one relaunch per nuclearHeartbeatIntervalMs. In the loop the
// OS calls run on their own goroutine and the result comes back as a command, so a slow
// relaunch never blocks the engine; inline (tests) they run synchronously.
func (e *Engine) nuclearReconcile() {
	n, active := e.nuclearSync()
	rl := e.o.Nuclear
	if !active || rl == nil || n.inFlight {
		return
	}
	l := limits()
	if n.hasRelaunch && e.bootNow-n.relaunched < embedded.Millis(l.NuclearHeartbeatIntervalMs) {
		return
	}
	last := n.since
	if n.hasHeartbeat {
		last = max(last, n.heartbeat)
	}
	if n.hasRelaunch {
		last = max(last, n.relaunched)
	}
	silent := e.bootNow-last > embedded.Millis(l.NuclearLivenessMs)
	check := func(parent context.Context) (bool, error, error) {
		running, err := rl.AppRunning()
		if !nuclearNeedsRelaunch(running, err, silent) {
			return false, err, nil
		}
		ctx, cancel := context.WithTimeout(parent, nuclearRelaunchTimeout)
		defer cancel()
		return true, err, rl.Relaunch(ctx)
	}
	if !e.loopMode {
		relaunched, cerr, rerr := check(context.Background())
		e.nuclearDone(relaunched, cerr, rerr)
		return
	}
	n.inFlight = true
	e.lifeMu.Lock()
	parent := e.loopCtx
	e.lifeMu.Unlock()
	if parent == nil {
		parent = context.Background()
	}
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		relaunched, cerr, rerr := check(parent)
		_ = e.exec(context.Background(), func() {
			if e.opened {
				e.nuclearDone(relaunched, cerr, rerr)
			}
		})
	}()
}

// nuclearDone records the outcome of one supervisor check (engine goroutine).
func (e *Engine) nuclearDone(relaunched bool, checkErr, relaunchErr error) {
	n := &e.state.Study.nuc
	n.inFlight = false
	if checkErr != nil {
		e.countError("nuclear_check")
	}
	if !relaunched {
		return
	}
	if relaunchErr != nil {
		e.countError("nuclear_relaunch")
		if !n.failing {
			e.log.Warn("nuclear relaunch failed; retrying", "err", relaunchErr)
		}
		n.failing = true
		return
	}
	if n.failing {
		e.log.Info("nuclear relaunch works again")
	}
	n.failing = false
	n.relaunches++
	if n.active {
		n.relaunched, n.hasRelaunch = e.o.Clock.Boot(), true
	}
}

// ---------------------------------------------------------------------------------------
// Reducers (applied live and on replay; never emit events)
// ---------------------------------------------------------------------------------------

func (e *Engine) applyStudyStarted(ev *storeEvent) error {
	d, err := decode[StudyStartedData](ev)
	if err != nil {
		return err
	}
	w := d.Session
	if e.studySession(w.ID) != nil {
		return fmt.Errorf("seq %d: study session %s exists", ev.Seq, w.ID)
	}
	started, ok1 := parseMs(w.StartedAt)
	plannedEnd, ok2 := parseMs(w.PlannedEndsAt)
	if !ok1 || !ok2 {
		return fmt.Errorf("seq %d: study session %s: invalid timestamp", ev.Seq, w.ID)
	}
	e.state.Study.Sessions = append(e.state.Study.Sessions, &studyRec{
		ID:             w.ID,
		Task:           w.Task,
		PlannedMinutes: w.PlannedMinutes,
		Pomodoro:       clonePomodoro(w.Pomodoro),
		Camera:         w.Camera,
		StartedAt:      started,
		Policy:         w.Policy,
		Status:         studyStatusActive,
		PlannedEndsAt:  plannedEnd,
	})
	return nil
}

func (e *Engine) studyOf(ev *storeEvent, id string) (*studyRec, error) {
	s := e.studySession(id)
	if s == nil {
		return nil, fmt.Errorf("seq %d (%s): unknown study session", ev.Seq, ev.Type)
	}
	return s, nil
}

func (e *Engine) applyStudyPaused(ev *storeEvent) error {
	d, err := decode[StudyPausedData](ev)
	if err != nil {
		return err
	}
	s, err := e.studyOf(ev, d.SessionID)
	if err != nil {
		return err
	}
	ends, ok := parseMs(d.PauseEndsAt)
	if !ok {
		return fmt.Errorf("seq %d: invalid pauseEndsAt", ev.Seq)
	}
	s.Status = studyStatusPaused
	s.PauseEndsAt = &ends
	// The awake clock of this turn (on replay: of the start, which only makes the quota
	// window last longer).
	s.PauseStartsAwakeMs = append(s.PauseStartsAwakeMs, e.awakeNow.Milliseconds())
	return nil
}

func (e *Engine) applyStudyResumed(ev *storeEvent) error {
	d, err := decode[StudyResumedData](ev)
	if err != nil {
		return err
	}
	s, err := e.studyOf(ev, d.SessionID)
	if err != nil {
		return err
	}
	s.Status = studyStatusActive
	s.PauseEndsAt = nil
	return nil
}

func (e *Engine) applyFocusMinutes(ev *storeEvent) error {
	d, err := decode[FocusMinutesData](ev)
	if err != nil {
		return err
	}
	s, err := e.studyOf(ev, d.SessionID)
	if err != nil {
		return err
	}
	s.LoggedMinutes += d.Minutes
	s.Points += ev.Points
	return nil
}

func (e *Engine) applyStrike(ev *storeEvent) error {
	d, err := decode[StrikeData](ev)
	if err != nil {
		return err
	}
	s, err := e.studyOf(ev, d.SessionID)
	if err != nil {
		return err
	}
	s.Strikes = d.StrikeNumber
	s.Points += ev.Points
	// The cooldown runs on awake time from this turn (on replay: from the start, which
	// only makes it last longer).
	s.LastStrikeAwakeMs = ptr(e.awakeNow.Milliseconds())
	s.est.cooldown = 0
	return nil
}

func (e *Engine) applyStudyEnded(ev *storeEvent) error {
	d, err := decode[StudyEndedData](ev)
	if err != nil {
		return err
	}
	s, err := e.studyOf(ev, d.SessionID)
	if err != nil {
		return err
	}
	s.Status = d.Outcome
	s.EndedAt = ptr(atMs(ev))
	s.PauseEndsAt = nil
	s.PendingEnd = ""
	s.PauseStartsAwakeMs = nil
	s.Strikes = d.Strikes
	s.Summary = &StudySummary{
		Outcome:        d.Outcome,
		ActiveMinutes:  d.ActiveMinutes,
		WorkMinutes:    d.WorkMinutes,
		FocusedMinutes: d.FocusedMinutes,
		FocusPct:       d.FocusPct,
		Strikes:        d.Strikes,
		Warnings:       d.Warnings,
		Attempts:       d.Attempts,
		PointsTotal:    d.PointsTotal,
		CleanBonus:     d.CleanBonus,
	}
	return nil
}

func (e *Engine) applyStudyOutcome(ev *storeEvent) error {
	d, err := decode[StudyOutcomeData](ev)
	if err != nil {
		return err
	}
	s, err := e.studyOf(ev, d.SessionID)
	if err != nil {
		return err
	}
	s.Achieved = ptr(d.Achieved)
	return nil
}
