package engine

import (
	"encoding/json"
	"fmt"

	"github.com/imdlodoem23/centrate/guardian/internal/points"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// Event types (EVENT_TYPES in domain.ts).
const (
	EvGuardianStarted    = "guardian_started"
	EvEpochStarted       = "epoch_started"
	EvClockJump          = "clock_jump"
	EvDayClosed          = "day_closed"
	EvBlockCreated       = "block_created"
	EvBlockExtended      = "block_extended"
	EvBlockCompleted     = "block_completed"
	EvBlockCancelled     = "block_cancelled"
	EvBlockReactivated   = "block_reactivated"
	EvAttempt            = "attempt"
	EvProcessClosed      = "process_closed"
	EvStudyStarted       = "study_started"
	EvStudyPaused        = "study_paused"
	EvStudyResumed       = "study_resumed"
	EvFocusMinutes       = "focus_minutes"
	EvStrike             = "strike"
	EvStudyEnded         = "study_ended"
	EvStudyOutcome       = "study_outcome"
	EvPunishmentStarted  = "punishment_started"
	EvPunishmentEnded    = "punishment_ended"
	EvEmergencyRequested = "emergency_requested"
	EvEmergencyCancelled = "emergency_cancelled"
	EvEmergencyConfirmed = "emergency_confirmed"
	EvRewardRedeemed     = "reward_redeemed"
	EvRewardEnded        = "reward_ended"
	EvScheduleCreated    = "schedule_created"
	EvScheduleUpdated    = "schedule_updated"
	EvScheduleDeleted    = "schedule_deleted"
	EvLimitCreated       = "limit_created"
	EvLimitUpdated       = "limit_updated"
	EvLimitDeleted       = "limit_deleted"
	EvLimitWarning       = "limit_warning"
	EvLimitReached       = "limit_reached"
	EvLimitDayClosed     = "limit_day_closed"
	EvSettingsChanged    = "settings_changed"
	EvExtensionPaired    = "extension_paired"
	EvExtensionRevoked   = "extension_revoked"
	EvTamperDetected     = "tamper_detected"
	EvLedgerRepaired     = "ledger_repaired"
)

// Data of every event type (EventDataMap in domain.ts). Every timestamp inside is
// trusted time (§4, §7.1).

// GuardianStartedData is guardian_started.
type GuardianStartedData struct {
	Version         string `json:"version"`
	SchemaVersion   int    `json:"schemaVersion"`
	CatalogVersion  int    `json:"catalogVersion"`
	RulesVersion    int    `json:"rulesVersion"`
	Mode            string `json:"mode"`
	SameBoot        bool   `json:"sameBoot"`
	DowntimeMs      *int64 `json:"downtimeMs"`
	UncleanShutdown bool   `json:"uncleanShutdown"`
	Recovery        string `json:"recovery"`
}

// EpochStartedData is epoch_started.
type EpochStartedData struct {
	Reason           string          `json:"reason"`
	PreviousEpoch    *string         `json:"previousEpoch"`
	CarryOverBalance int64           `json:"carryOverBalance"`
	Escalation       EscalationState `json:"escalation"`
	Kept             EpochKeptState  `json:"kept"`
}

// ClockJumpData is clock_jump.
type ClockJumpData struct {
	Source              string   `json:"source"`
	DeltaMs             int64    `json:"deltaMs"`
	WallOffsetMs        int64    `json:"wallOffsetMs"`
	Trust               string   `json:"trust"`
	ReactivatedBlockIDs []string `json:"reactivatedBlockIds"`
	ShiftedBlockIDs     []string `json:"shiftedBlockIds"`
	ShiftedAllowanceIDs []string `json:"shiftedAllowanceIds"`
}

// DayClosedData is day_closed.
type DayClosedData struct {
	Day         string `json:"day"`
	GoalMinutes int64  `json:"goalMinutes"`
}

// BlockCreatedData is block_created.
type BlockCreatedData struct {
	Block  Block  `json:"block"`
	Source string `json:"source"`
}

// BlockExtendedData is block_extended.
type BlockExtendedData struct {
	BlockID    string `json:"blockId"`
	AddMinutes int64  `json:"addMinutes"`
	EndsAt     string `json:"endsAt"`
}

// BlockCompletedData is block_completed.
type BlockCompletedData struct {
	BlockID         string `json:"blockId"`
	Kind            string `json:"kind"`
	Mode            string `json:"mode"`
	CreditedMinutes int64  `json:"creditedMinutes"`
	AttemptsCounted int64  `json:"attemptsCounted"`
	DowntimeMs      int64  `json:"downtimeMs"`
	ClockTrust      string `json:"clockTrust"`
}

// BlockCancelledData is block_cancelled.
type BlockCancelledData struct {
	BlockID          string `json:"blockId"`
	EmergencyID      string `json:"emergencyId"`
	ForfeitedMinutes int64  `json:"forfeitedMinutes"`
}

// BlockReactivatedData is block_reactivated.
type BlockReactivatedData struct {
	BlockID      string `json:"blockId"`
	RevertsSeq   int64  `json:"revertsSeq"`
	RevertPoints int64  `json:"revertPoints"`
	EndsAt       string `json:"endsAt"`
	Reason       string `json:"reason"`
}

// AttemptData is attempt.
type AttemptData struct {
	AttemptID       string   `json:"attemptId"`
	Layer           string   `json:"layer"`
	TargetKey       string   `json:"targetKey"`
	TargetType      string   `json:"targetType"`
	ServiceID       *string  `json:"serviceId"`
	BlockIDs        []string `json:"blockIds"`
	Browser         *string  `json:"browser"`
	Incognito       bool     `json:"incognito"`
	EscalationIndex int64    `json:"escalationIndex"`
	Penalized       bool     `json:"penalized"`
}

// ProcessClosedData is process_closed.
type ProcessClosedData struct {
	Reason    string   `json:"reason"`
	ServiceID *string  `json:"serviceId"`
	AppID     *string  `json:"appId"`
	Browser   *string  `json:"browser"`
	BlockIDs  []string `json:"blockIds"`
}

// StudyStartedData is study_started.
type StudyStartedData struct {
	Session StudySession `json:"session"`
}

// StudyPausedData is study_paused.
type StudyPausedData struct {
	SessionID   string `json:"sessionId"`
	PauseEndsAt string `json:"pauseEndsAt"`
}

// StudyResumedData is study_resumed.
type StudyResumedData struct {
	SessionID string `json:"sessionId"`
	Auto      bool   `json:"auto"`
}

// FocusMinutesData is focus_minutes.
type FocusMinutesData struct {
	SessionID string `json:"sessionId"`
	Minutes   int64  `json:"minutes"`
}

// StrikeData is strike.
type StrikeData struct {
	SessionID    string `json:"sessionId"`
	StrikeNumber int64  `json:"strikeNumber"`
	Cause        string `json:"cause"`
}

// StudyEndedData is study_ended.
type StudyEndedData struct {
	SessionID      string `json:"sessionId"`
	Outcome        string `json:"outcome"`
	PlannedMinutes int64  `json:"plannedMinutes"`
	ActiveMinutes  int64  `json:"activeMinutes"`
	WorkMinutes    int64  `json:"workMinutes"`
	FocusedMinutes int64  `json:"focusedMinutes"`
	FocusPct       int64  `json:"focusPct"`
	Strikes        int64  `json:"strikes"`
	Warnings       int64  `json:"warnings"`
	Attempts       int64  `json:"attempts"`
	PointsTotal    int64  `json:"pointsTotal"`
	CleanBonus     int64  `json:"cleanBonus"`
}

// StudyOutcomeData is study_outcome.
type StudyOutcomeData struct {
	SessionID string `json:"sessionId"`
	Achieved  string `json:"achieved"`
}

// PunishmentStartedData is punishment_started.
type PunishmentStartedData struct {
	Punishment Punishment `json:"punishment"`
}

// PunishmentEndedData is punishment_ended.
type PunishmentEndedData struct {
	PunishmentID string `json:"punishmentId"`
	BlockID      string `json:"blockId"`
	Outcome      string `json:"outcome"`
}

// EmergencyRequestedData is emergency_requested.
type EmergencyRequestedData struct {
	Emergency EmergencyUnlock `json:"emergency"`
}

// EmergencyCancelledData is emergency_cancelled.
type EmergencyCancelledData struct {
	EmergencyID string `json:"emergencyId"`
	Reason      string `json:"reason"`
}

// EmergencyConfirmedData is emergency_confirmed.
type EmergencyConfirmedData struct {
	EmergencyID    string   `json:"emergencyId"`
	BlockIDs       []string `json:"blockIds"`
	BalanceBefore  int64    `json:"balanceBefore"`
	AllowanceValue int64    `json:"allowanceValue"`
	Penalty        int64    `json:"penalty"`
	StreakDaysLost int64    `json:"streakDaysLost"`
	GoalMinutes    int64    `json:"goalMinutes"`
}

// RewardRedeemedData is reward_redeemed.
type RewardRedeemedData struct {
	AllowanceID      string `json:"allowanceId"`
	OfferID          string `json:"offerId"`
	ServiceID        string `json:"serviceId"`
	OfferMinutes     int64  `json:"offerMinutes"`
	OfferCost        int64  `json:"offerCost"`
	AllowanceMinutes int64  `json:"allowanceMinutes"`
	AllowanceCost    int64  `json:"allowanceCost"`
	EndsAt           string `json:"endsAt"`
	ExtendedExisting bool   `json:"extendedExisting"`
}

// RewardEndedData is reward_ended.
type RewardEndedData struct {
	AllowanceID      string  `json:"allowanceId"`
	ServiceID        string  `json:"serviceId"`
	Reason           string  `json:"reason"`
	RevokedByBlockID *string `json:"revokedByBlockId"`
	Cost             int64   `json:"cost"`
	TotalMs          int64   `json:"totalMs"`
	RemainingMs      int64   `json:"remainingMs"`
	Refund           int64   `json:"refund"`
}

// ScheduleData is schedule_created and schedule_updated.
type ScheduleData struct {
	Schedule Schedule `json:"schedule"`
}

// ScheduleDeletedData is schedule_deleted.
type ScheduleDeletedData struct {
	ScheduleID string `json:"scheduleId"`
}

// LimitCreatedData is limit_created.
type LimitCreatedData struct {
	Limit DailyLimit `json:"limit"`
}

// LimitUpdatedData is limit_updated (cause "user" or "pending_applied").
type LimitUpdatedData struct {
	Limit DailyLimit `json:"limit"`
	Cause string     `json:"cause"`
}

// LimitDeletedData is limit_deleted.
type LimitDeletedData struct {
	LimitID string `json:"limitId"`
	Name    string `json:"name"`
}

// LimitWarningData is limit_warning.
type LimitWarningData struct {
	LimitID          string `json:"limitId"`
	Name             string `json:"name"`
	Day              string `json:"day"`
	DailyMinutes     int64  `json:"dailyMinutes"`
	UsedSeconds      int64  `json:"usedSeconds"`
	RemainingSeconds int64  `json:"remainingSeconds"`
}

// LimitReachedData is limit_reached.
type LimitReachedData struct {
	LimitID      string  `json:"limitId"`
	Name         string  `json:"name"`
	Day          string  `json:"day"`
	DailyMinutes int64   `json:"dailyMinutes"`
	UsedSeconds  int64   `json:"usedSeconds"`
	BlockID      *string `json:"blockId"`
}

// LimitDayClosedData is limit_day_closed.
type LimitDayClosedData struct {
	LimitID      string `json:"limitId"`
	Name         string `json:"name"`
	Day          string `json:"day"`
	DailyMinutes int64  `json:"dailyMinutes"`
	UsedSeconds  int64  `json:"usedSeconds"`
	Applied      bool   `json:"applied"`
	Reached      bool   `json:"reached"`
}

// SettingsChangedData is settings_changed.
type SettingsChangedData struct {
	Settings GuardianSettings       `json:"settings"`
	Pending  []PendingSettingChange `json:"pending"`
}

// ExtensionPairedData is extension_paired.
type ExtensionPairedData struct {
	ExtensionID string  `json:"extensionId"`
	Browser     string  `json:"browser"`
	BoundOrigin *string `json:"boundOrigin"`
}

// ExtensionRevokedData is extension_revoked.
type ExtensionRevokedData struct {
	ExtensionID string `json:"extensionId"`
}

// TamperDetectedData is tamper_detected.
type TamperDetectedData struct {
	Kind              string `json:"kind"`
	BalanceCorrection int64  `json:"balanceCorrection"`
	VoidStreak        bool   `json:"voidStreak"`
}

// LedgerRepairedData is ledger_repaired.
type LedgerRepairedData struct {
	DroppedFromSeq    int64  `json:"droppedFromSeq"`
	DroppedCount      int64  `json:"droppedCount"`
	ArchivedAs        string `json:"archivedAs"`
	BalanceCorrection int64  `json:"balanceCorrection"`
}

// ---------------------------------------------------------------------------------------
// Batches (§11.3 step 2)
// ---------------------------------------------------------------------------------------

// batch is one atomic group of events being built by a mutation. Every event gets the
// same envelope time, day, wall offset and idempotency fingerprint; its recorded
// balance and XP deltas are derived at emission with the Go ledger port (§6), threading
// a scratch copy of the ledger through the batch so later events see earlier ones.
// Nothing is applied until Engine.commit appends the batch.
type batch struct {
	at     int64 // trusted Unix ms
	day    string
	wallMs int64
	req    *string
	ledger points.LedgerState
	events []store.Event
	// anchorNow: the batch needs the rollback anchor updated before the response (§11.3
	// step 6): a negative delta, an emergency, a punishment or a streak change.
	anchorNow bool
}

// newBatch starts a batch stamped with the current trusted time, local day and wall
// offset; events carry the fingerprint of the idempotent request being served, if any.
func (e *Engine) newBatch() *batch {
	return &batch{
		at:     e.now,
		day:    e.localDay(e.now),
		wallMs: e.wallOffsetMs(),
		req:    e.curReq,
		ledger: e.state.Ledger.Clone(),
	}
}

// add appends one event whose data is v (marshalled to JSON) and returns its recorded
// balance delta. It panics if v cannot be encoded: every data type is a plain struct.
func (b *batch) add(typ string, v any) int64 {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("engine: encode %s data: %v", typ, err))
	}
	ev := store.Event{
		At:           fmtMs(b.at),
		WallOffsetMs: b.wallMs,
		Day:          b.day,
		Type:         typ,
		Req:          b.req,
		Data:         raw,
	}
	in, ok, _ := points.LedgerInputFromEvent(points.Event{At: ev.At, Day: ev.Day, Type: typ, Data: raw})
	if ok && in.Type != points.InputEpochStarted {
		before := b.ledger
		step := points.ApplyLedgerInput(before, in, points.DefaultPointRules())
		ev.Points, ev.XP = step.Points, step.XP
		b.ledger = step.State
		if step.Points < 0 || before.Streak != step.State.Streak || !sameDay(before.VoidedDay, step.State.VoidedDay) {
			b.anchorNow = true
		}
	}
	switch typ {
	case EvEmergencyConfirmed, EvPunishmentStarted, EvTamperDetected, EvLedgerRepaired:
		b.anchorNow = true
	}
	b.events = append(b.events, ev)
	return ev.Points
}

// empty reports whether nothing was added.
func (b *batch) empty() bool { return len(b.events) == 0 }

// balance is the scratch balance after the events added so far.
func (b *batch) balance() int64 { return b.ledger.Balance }

func sameDay(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
