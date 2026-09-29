package points

import "maps"

// Escalation is the global attempt escalation: the time of the last counted attempt
// (nil before the first one) and its index.
type Escalation struct {
	LastCountedAtMs *int64 `json:"lastCountedAtMs"`
	Index           int64  `json:"index"`
}

func (e Escalation) clone() Escalation {
	if e.LastCountedAtMs != nil {
		v := *e.LastCountedAtMs
		e.LastCountedAtMs = &v
	}
	return e
}

// LedgerState is everything the ledger needs to derive the next delta (LedgerState in
// points.ts, same JSON shape). The guardian persists it in state.json; it is rebuildable
// from the log.
type LedgerState struct {
	Balance int64 `json:"balance"`
	XP      int64 `json:"xp"`
	// Streak is the number of consecutive met days up to and including LastClosedDay.
	Streak        int64   `json:"streak"`
	BestStreak    int64   `json:"bestStreak"`
	LastClosedDay *string `json:"lastClosedDay"`
	// OpenDays holds the focused minutes of days not closed yet (normally just today).
	OpenDays map[string]int64 `json:"openDays"`
	// VoidedDay is the day an emergency unlock (or a streak-voiding correction) voided.
	VoidedDay  *string    `json:"voidedDay"`
	Escalation Escalation `json:"escalation"`
	// Dedupe is the last detection time per target key, pruned to the dedupe window.
	Dedupe map[string]int64 `json:"dedupe"`
}

// InitialLedgerState is an empty ledger.
func InitialLedgerState() LedgerState {
	return LedgerState{OpenDays: map[string]int64{}, Dedupe: map[string]int64{}}
}

// Clone is a deep copy (maps and pointers included).
func (s LedgerState) Clone() LedgerState {
	out := s
	out.LastClosedDay = cloneString(s.LastClosedDay)
	out.VoidedDay = cloneString(s.VoidedDay)
	out.OpenDays = maps.Clone(s.OpenDays)
	if out.OpenDays == nil {
		out.OpenDays = map[string]int64{}
	}
	out.Dedupe = maps.Clone(s.Dedupe)
	if out.Dedupe == nil {
		out.Dedupe = map[string]int64{}
	}
	out.Escalation = s.Escalation.clone()
	return out
}

func cloneString(p *string) *string {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func ptr[T any](v T) *T { return &v }

// InputType is the kind of a LedgerInput (LedgerInputType in points.ts).
type InputType string

// Ledger input types. All but InputAttemptDetected map 1:1 to logged events (see
// LedgerInputFromEvent).
const (
	// InputAttemptDetected is a raw detection from any layer: the guardian feeds every
	// detection through it and logs an attempt event only when the outcome is counted.
	InputAttemptDetected    InputType = "attempt_detected"
	InputAttempt            InputType = "attempt"
	InputBlockCompleted     InputType = "block_completed"
	InputBlockReactivated   InputType = "block_reactivated"
	InputFocusMinutes       InputType = "focus_minutes"
	InputStrike             InputType = "strike"
	InputStudyEnded         InputType = "study_ended"
	InputPunishmentStarted  InputType = "punishment_started"
	InputEmergencyConfirmed InputType = "emergency_confirmed"
	InputRewardRedeemed     InputType = "reward_redeemed"
	InputRewardEnded        InputType = "reward_ended"
	InputDayClosed          InputType = "day_closed"
	InputBalanceCorrection  InputType = "balance_correction"
	InputEpochStarted       InputType = "epoch_started"
)

// LedgerInput is one fact the ledger understands (the LedgerInput union of points.ts
// flattened). Type, AtMs (trusted time, epoch ms) and Day (the envelope's local day) are
// always used; the other fields only by the types named in their comments.
type LedgerInput struct {
	Type InputType
	AtMs int64
	Day  string

	// attempt_detected, attempt: dedupe target key and settings.attemptPenalties.
	Key       string
	Penalized bool

	// block_completed.
	Kind            string
	CreditedMinutes int64
	AttemptsCounted int64

	// block_reactivated.
	RevertPoints int64

	// focus_minutes.
	Minutes int64

	// study_ended: Outcome is a StudyOutcome.
	Outcome        string
	Strikes        int64
	Attempts       int64
	PlannedMinutes int64

	// emergency_confirmed and day_closed: the daily goal in force.
	GoalMinutes int64
	// emergency_confirmed: AllowanceValue of the active allowances at confirm (≥ 0).
	AllowanceValue int64

	// reward_redeemed: what this redemption charged. reward_ended: the allowance's total
	// cost (refund input).
	Cost int64

	// reward_ended: Reason is "expired" or "revoked".
	Reason      string
	TotalMs     int64
	RemainingMs int64

	// day_closed: the local day that ended.
	ClosedDay string

	// balance_correction: Amount (≤ 0 in practice) and whether it also sets the streak to
	// 0 and voids Day, like an emergency unlock.
	Amount     int64
	VoidStreak bool

	// epoch_started: the carried balance (only a negative one survives) and escalation.
	CarryOverBalance int64
	Escalation       Escalation
}

// LedgerOutcome is side information about what an input did. Only the fields relevant to
// the input are set; nil means absent (or null in points.ts, such as EscalationIndex of a
// merged detection and Met of an already-closed day).
type LedgerOutcome struct {
	// Counted: attempts counted as a new attempt.
	Counted *bool `json:"counted,omitempty"`
	// Merged: attempts merged into the previous detection of the same key (no points).
	Merged          *bool  `json:"merged,omitempty"`
	EscalationIndex *int64 `json:"escalationIndex,omitempty"`
	// Penalty: the (positive) penalty charged by attempts, strikes, punishments and
	// emergencies.
	Penalty    *int64 `json:"penalty,omitempty"`
	CleanBonus *int64 `json:"cleanBonus,omitempty"`
	// Met: day_closed, whether the goal was met.
	Met            *bool  `json:"met,omitempty"`
	StreakDaysLost *int64 `json:"streakDaysLost,omitempty"`
	Refund         *int64 `json:"refund,omitempty"`
}

// LedgerStep is the result of ApplyLedgerInput.
type LedgerStep struct {
	State LedgerState
	// Points is the balance delta.
	Points int64
	// XP is the XP delta.
	XP      int64
	Outcome LedgerOutcome
}

// StepDelta is a LedgerStep without its state (ComputeLedger).
type StepDelta struct {
	Points  int64
	XP      int64
	Outcome LedgerOutcome
}

// pruneDedupe drops entries outside [atMs − window, atMs], including ones ahead of atMs.
func pruneDedupe(s *LedgerState, atMs int64, r PointRules) {
	for key, last := range s.Dedupe {
		elapsed := atMs - last
		if elapsed < 0 || elapsed >= int64(r.AttemptDedupeWindowMs) {
			delete(s.Dedupe, key)
		}
	}
}

func isDayOpen(s *LedgerState, day string) bool {
	return s.LastClosedDay == nil || dayNum(day) > dayNum(*s.LastClosedDay)
}

func isVoided(s *LedgerState, day string) bool {
	return s.VoidedDay != nil && *s.VoidedDay == day
}

func todayMet(s *LedgerState, today string, goalMinutes int64) bool {
	return isDayOpen(s, today) && !isVoided(s, today) && s.OpenDays[today] >= goalMinutes
}

// StreakAsOf is the streak as shown on today: the closed streak if it reaches yesterday
// (or today), plus one when today's goal is already met.
func StreakAsOf(s LedgerState, today string, goalMinutes int64) int64 {
	var closed int64
	if s.LastClosedDay != nil && dayNum(today)-dayNum(*s.LastClosedDay) <= 1 {
		closed = s.Streak
	}
	if todayMet(&s, today, goalMinutes) {
		closed++
	}
	return closed
}

// ApplyLedgerInput applies one input and returns the new state (the input state is not
// modified), the balance and XP deltas and what happened. An unknown Type changes
// nothing.
func ApplyLedgerInput(state LedgerState, in LedgerInput, r PointRules) LedgerStep {
	next := state.Clone()
	var outcome LedgerOutcome
	var points, xp int64

	countAttempt := func(key string, penalized bool) {
		index := NextEscalationIndex(next.Escalation, in.AtMs, r)
		var penalty int64
		if penalized {
			penalty = AttemptPenalty(index, r)
		}
		next.Escalation = Escalation{LastCountedAtMs: ptr(in.AtMs), Index: index}
		next.Dedupe[key] = in.AtMs
		points = -penalty
		outcome.Counted = ptr(true)
		outcome.Merged = ptr(false)
		outcome.EscalationIndex = ptr(index)
		outcome.Penalty = ptr(penalty)
	}

	switch in.Type {
	case InputAttemptDetected:
		pruneDedupe(&next, in.AtMs, r)
		// After pruning, a remaining entry is within [atMs − window, atMs].
		if _, seen := next.Dedupe[in.Key]; seen {
			next.Dedupe[in.Key] = in.AtMs
			outcome.Counted = ptr(false)
			outcome.Merged = ptr(true)
			outcome.EscalationIndex = nil
			outcome.Penalty = ptr(int64(0))
		} else {
			countAttempt(in.Key, in.Penalized)
		}
	case InputAttempt:
		pruneDedupe(&next, in.AtMs, r)
		countAttempt(in.Key, in.Penalized)
	case InputBlockCompleted:
		bp := BlockCompletionPoints(in.Kind, in.CreditedMinutes, in.AttemptsCounted, r)
		points = bp.Total
		outcome.CleanBonus = ptr(bp.CleanBonus)
	case InputBlockReactivated:
		points = -max(0, in.RevertPoints)
	case InputFocusMinutes:
		minutes := max(0, in.Minutes)
		points = minutes * int64(r.StudyPointsPerFocusMinute)
		xp = minutes * int64(r.XPPerFocusMinute)
		if isDayOpen(&next, in.Day) {
			next.OpenDays[in.Day] += minutes
		}
	case InputStrike:
		points = -int64(r.StrikePenalty)
		outcome.Penalty = ptr(int64(r.StrikePenalty))
	case InputStudyEnded:
		bonus := StudyEndBonus(in.Outcome, in.Strikes, in.Attempts, in.PlannedMinutes, r)
		points = bonus
		outcome.CleanBonus = ptr(bonus)
	case InputPunishmentStarted:
		points = -int64(r.PunishmentPenalty)
		outcome.Penalty = ptr(int64(r.PunishmentPenalty))
	case InputEmergencyConfirmed:
		penalty := EmergencyPenalty(next.Balance+max(0, in.AllowanceValue), r)
		outcome.Penalty = ptr(penalty)
		outcome.StreakDaysLost = ptr(StreakAsOf(next, in.Day, in.GoalMinutes))
		points = -penalty
		next.Streak = 0
		next.VoidedDay = ptr(in.Day)
	case InputRewardRedeemed:
		points = -max(0, in.Cost)
	case InputRewardEnded:
		var refund int64
		if in.Reason == "revoked" {
			refund = AllowanceRefund(in.Cost, in.TotalMs, in.RemainingMs)
		}
		points = refund
		outcome.Refund = ptr(refund)
	case InputDayClosed:
		if !isDayOpen(&next, in.ClosedDay) {
			outcome.Met = nil
			break
		}
		closedNumber := dayNum(in.ClosedDay)
		consecutive := next.LastClosedDay == nil || closedNumber == dayNum(*next.LastClosedDay)+1
		met := !isVoided(&next, in.ClosedDay) && next.OpenDays[in.ClosedDay] >= in.GoalMinutes
		switch {
		case !met:
			next.Streak = 0
		case consecutive:
			next.Streak++
		default:
			next.Streak = 1
		}
		next.BestStreak = max(next.BestStreak, next.Streak)
		next.LastClosedDay = ptr(in.ClosedDay)
		for day := range next.OpenDays {
			if dayNum(day) <= closedNumber {
				delete(next.OpenDays, day)
			}
		}
		if next.VoidedDay != nil && dayNum(*next.VoidedDay) <= closedNumber {
			next.VoidedDay = nil
		}
		outcome.Met = ptr(met)
	case InputBalanceCorrection:
		points = in.Amount
		if in.VoidStreak {
			next.Streak = 0
			next.VoidedDay = ptr(in.Day)
		}
	case InputEpochStarted:
		// Starts a new epoch: the ledger resets and only a negative balance and the attempt
		// escalation carry over. Its delta is relative to an empty epoch.
		fresh := InitialLedgerState()
		fresh.Balance = min(0, in.CarryOverBalance)
		fresh.Escalation = in.Escalation.clone()
		return LedgerStep{State: fresh, Points: fresh.Balance, XP: 0, Outcome: outcome}
	}

	next.Balance += points
	next.XP += xp
	return LedgerStep{State: next, Points: points, XP: xp, Outcome: outcome}
}

// ComputeLedger folds inputs from initial (use InitialLedgerState() for a fresh ledger),
// keeping every step's deltas. initial is not modified.
func ComputeLedger(inputs []LedgerInput, r PointRules, initial LedgerState) (LedgerState, []StepDelta) {
	state := initial.Clone()
	steps := make([]StepDelta, 0, len(inputs))
	for _, in := range inputs {
		step := ApplyLedgerInput(state, in, r)
		state = step.State
		steps = append(steps, StepDelta{Points: step.Points, XP: step.XP, Outcome: step.Outcome})
	}
	return state, steps
}

// TodaySummary is PointsSummary.today.
type TodaySummary struct {
	Day          string `json:"day"`
	FocusMinutes int64  `json:"focusMinutes"`
	GoalMinutes  int64  `json:"goalMinutes"`
	GoalMet      bool   `json:"goalMet"`
}

// PointsSummary is what the Progress section shows (PointsSummary in domain.ts, same
// JSON shape).
type PointsSummary struct {
	// Balance can be negative («números rojos»).
	Balance int64 `json:"balance"`
	// XP only goes up (focused minutes).
	XP    int64 `json:"xp"`
	Level int64 `json:"level"`
	// LevelFloorXP is the XP at which the current level started.
	LevelFloorXP int64 `json:"levelFloorXp"`
	// NextLevelXP is the XP needed for the next level.
	NextLevelXP    int64        `json:"nextLevelXp"`
	StreakDays     int64        `json:"streakDays"`
	BestStreakDays int64        `json:"bestStreakDays"`
	Today          TodaySummary `json:"today"`
	// PendingFocusMinutes are the accepted focus minutes of the active study session not
	// logged yet (display only); every other field already includes them.
	PendingFocusMinutes int64 `json:"pendingFocusMinutes"`
}

// SummaryOptions are the inputs of SummarizeLedger besides the state.
type SummaryOptions struct {
	Today       string
	GoalMinutes int64
	// PendingFocusMinutes (≥ 0; negative counts as 0) are the active session's accepted
	// whole minutes not logged yet, counted as a provisional focus_minutes on Today.
	PendingFocusMinutes int64
}

// SummarizeLedger is the Progress summary on o.Today with the daily goal currently in
// force. The pending focus minutes are applied as a provisional focus_minutes input
// (display only), so «Hoy: 42 de 60 min», the balance and the streak never lag behind the
// session. state is not modified.
func SummarizeLedger(state LedgerState, o SummaryOptions, r PointRules) PointsSummary {
	pending := max(0, o.PendingFocusMinutes)
	s := state
	if pending > 0 {
		s = ApplyLedgerInput(state, LedgerInput{
			Type:    InputFocusMinutes,
			AtMs:    0,
			Day:     o.Today,
			Minutes: pending,
		}, r).State
	}
	level := LevelForXP(s.XP, r)
	streakDays := StreakAsOf(s, o.Today, o.GoalMinutes)
	var focusMinutes int64
	if isDayOpen(&s, o.Today) {
		focusMinutes = s.OpenDays[o.Today]
	}
	return PointsSummary{
		Balance:        s.Balance,
		XP:             s.XP,
		Level:          level,
		LevelFloorXP:   XPForLevel(level, r),
		NextLevelXP:    XPForLevel(level+1, r),
		StreakDays:     streakDays,
		BestStreakDays: max(s.BestStreak, streakDays),
		Today: TodaySummary{
			Day:          o.Today,
			FocusMinutes: focusMinutes,
			GoalMinutes:  o.GoalMinutes,
			GoalMet:      todayMet(&s, o.Today, o.GoalMinutes),
		},
		PendingFocusMinutes: pending,
	}
}
