package points

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
)

// Event is the part of a logged event (EventEnvelopeBase plus type and data, as
// /v1/events serves it and the log stores it) that the ledger reads. Unknown JSON fields
// are ignored when decoding into it. Every timestamp (At and the ones inside Data) is
// trusted time: WallOffsetMs is never applied.
type Event struct {
	Seq  int64  `json:"seq"`
	At   string `json:"at"`
	Day  string `json:"day"`
	Type string `json:"type"`
	// Points and XP are the deltas recorded at emission (authoritative for history).
	Points int64           `json:"points"`
	XP     int64           `json:"xp"`
	Data   json.RawMessage `json:"data"`
	// Malformed is set (non-empty) on a MalformedGuardianEvent: a known type whose data
	// failed validation. Such an event is treated as unknown (recorded deltas only).
	Malformed json.RawMessage `json:"malformed,omitempty"`
}

// ErrMalformedEvent wraps every error of LedgerInputFromEvent.
var ErrMalformedEvent = errors.New("points: malformed event")

// Enumerations this package reads from event data (domain.ts).
var (
	blockKinds    = []string{"manual", "schedule", "punishment", "recovered", "limit"}
	studyOutcomes = []string{"completed", "ended_early", "abandoned", "punished", "interrupted"}
	rewardReasons = []string{"expired", "revoked"}
)

// ledgerEventTypes are the logged event types with a ledger input.
var ledgerEventTypes = []string{
	"attempt", "block_completed", "block_reactivated", "focus_minutes", "strike", "study_ended",
	"punishment_started", "emergency_confirmed", "reward_redeemed", "reward_ended", "day_closed",
	"tamper_detected", "ledger_repaired", "epoch_started",
}

func malformed(e Event, format string, args ...any) error {
	return fmt.Errorf("%w: seq %d (%s): %s", ErrMalformedEvent, e.Seq, e.Type, fmt.Sprintf(format, args...))
}

// decodeData decodes e.Data, which must be a JSON object, into v.
func decodeData(e Event, v any) error {
	data := bytes.TrimSpace(e.Data)
	if len(data) == 0 || data[0] != '{' {
		return malformed(e, "data is not an object")
	}
	if err := json.Unmarshal(data, v); err != nil {
		return malformed(e, "%v", err)
	}
	return nil
}

// field names a data field and whether it was present.
type field struct {
	name    string
	present bool
}

// required checks that every field was present in the data.
func required(e Event, fields ...field) error {
	for _, f := range fields {
		if !f.present {
			return malformed(e, "missing data.%s", f.name)
		}
	}
	return nil
}

// oneOf checks that an enum field has a known value.
func oneOf(e Event, name, value string, allowed []string) error {
	if !slices.Contains(allowed, value) {
		return malformed(e, "data.%s: unknown value %q", name, value)
	}
	return nil
}

// LedgerInputFromEvent is the ledger input of a logged event (ledgerInputFromEvent in
// points.ts). ok is false for events without points or streak effect, unknown types and
// malformed events (Malformed set). Every time is trusted time (At and data timestamps),
// never display time. It returns an ErrMalformedEvent error when At or Day is invalid or
// the data of a ledger event lacks a field the ledger reads (or has the wrong JSON type or
// an unknown enum value); it does not validate fields the ledger does not read.
func LedgerInputFromEvent(e Event) (in LedgerInput, ok bool, err error) {
	if len(e.Malformed) > 0 && !bytes.Equal(bytes.TrimSpace(e.Malformed), []byte("null")) {
		return LedgerInput{}, false, nil
	}
	if !slices.Contains(ledgerEventTypes, e.Type) {
		return LedgerInput{}, false, nil
	}
	atMs, okAt := ParseWireTime(e.At)
	if !okAt {
		return LedgerInput{}, false, malformed(e, "invalid at %q", e.At)
	}
	if !IsLocalDay(e.Day) {
		return LedgerInput{}, false, malformed(e, "invalid day %q", e.Day)
	}
	in = LedgerInput{AtMs: atMs, Day: e.Day}

	switch e.Type {
	case "attempt":
		var d struct {
			TargetKey *string `json:"targetKey"`
			Penalized *bool   `json:"penalized"`
		}
		if err := decodeData(e, &d); err != nil {
			return LedgerInput{}, false, err
		}
		if err := required(e, field{"targetKey", d.TargetKey != nil}, field{"penalized", d.Penalized != nil}); err != nil {
			return LedgerInput{}, false, err
		}
		in.Type, in.Key, in.Penalized = InputAttempt, *d.TargetKey, *d.Penalized
	case "block_completed":
		var d struct {
			Kind            *string `json:"kind"`
			CreditedMinutes *int64  `json:"creditedMinutes"`
			AttemptsCounted *int64  `json:"attemptsCounted"`
		}
		if err := decodeData(e, &d); err != nil {
			return LedgerInput{}, false, err
		}
		if err := required(e, field{"kind", d.Kind != nil}, field{"creditedMinutes", d.CreditedMinutes != nil}, field{"attemptsCounted", d.AttemptsCounted != nil}); err != nil {
			return LedgerInput{}, false, err
		}
		if err := oneOf(e, "kind", *d.Kind, blockKinds); err != nil {
			return LedgerInput{}, false, err
		}
		in.Type, in.Kind, in.CreditedMinutes, in.AttemptsCounted = InputBlockCompleted, *d.Kind, *d.CreditedMinutes, *d.AttemptsCounted
	case "block_reactivated":
		var d struct {
			RevertPoints *int64 `json:"revertPoints"`
		}
		if err := decodeData(e, &d); err != nil {
			return LedgerInput{}, false, err
		}
		if err := required(e, field{"revertPoints", d.RevertPoints != nil}); err != nil {
			return LedgerInput{}, false, err
		}
		in.Type, in.RevertPoints = InputBlockReactivated, *d.RevertPoints
	case "focus_minutes":
		var d struct {
			Minutes *int64 `json:"minutes"`
		}
		if err := decodeData(e, &d); err != nil {
			return LedgerInput{}, false, err
		}
		if err := required(e, field{"minutes", d.Minutes != nil}); err != nil {
			return LedgerInput{}, false, err
		}
		in.Type, in.Minutes = InputFocusMinutes, *d.Minutes
	case "strike", "punishment_started":
		var d struct{}
		if err := decodeData(e, &d); err != nil {
			return LedgerInput{}, false, err
		}
		in.Type = InputType(e.Type)
	case "study_ended":
		var d struct {
			Outcome        *string `json:"outcome"`
			Strikes        *int64  `json:"strikes"`
			Attempts       *int64  `json:"attempts"`
			PlannedMinutes *int64  `json:"plannedMinutes"`
		}
		if err := decodeData(e, &d); err != nil {
			return LedgerInput{}, false, err
		}
		if err := required(e, field{"outcome", d.Outcome != nil}, field{"strikes", d.Strikes != nil}, field{"attempts", d.Attempts != nil}, field{"plannedMinutes", d.PlannedMinutes != nil}); err != nil {
			return LedgerInput{}, false, err
		}
		if err := oneOf(e, "outcome", *d.Outcome, studyOutcomes); err != nil {
			return LedgerInput{}, false, err
		}
		in.Type = InputStudyEnded
		in.Outcome, in.Strikes, in.Attempts, in.PlannedMinutes = *d.Outcome, *d.Strikes, *d.Attempts, *d.PlannedMinutes
	case "emergency_confirmed":
		var d struct {
			GoalMinutes    *int64 `json:"goalMinutes"`
			AllowanceValue *int64 `json:"allowanceValue"`
		}
		if err := decodeData(e, &d); err != nil {
			return LedgerInput{}, false, err
		}
		if err := required(e, field{"goalMinutes", d.GoalMinutes != nil}, field{"allowanceValue", d.AllowanceValue != nil}); err != nil {
			return LedgerInput{}, false, err
		}
		in.Type, in.GoalMinutes, in.AllowanceValue = InputEmergencyConfirmed, *d.GoalMinutes, *d.AllowanceValue
	case "reward_redeemed":
		var d struct {
			OfferCost *int64 `json:"offerCost"`
		}
		if err := decodeData(e, &d); err != nil {
			return LedgerInput{}, false, err
		}
		if err := required(e, field{"offerCost", d.OfferCost != nil}); err != nil {
			return LedgerInput{}, false, err
		}
		in.Type, in.Cost = InputRewardRedeemed, *d.OfferCost
	case "reward_ended":
		var d struct {
			Reason      *string `json:"reason"`
			Cost        *int64  `json:"cost"`
			TotalMs     *int64  `json:"totalMs"`
			RemainingMs *int64  `json:"remainingMs"`
		}
		if err := decodeData(e, &d); err != nil {
			return LedgerInput{}, false, err
		}
		if err := required(e, field{"reason", d.Reason != nil}, field{"cost", d.Cost != nil}, field{"totalMs", d.TotalMs != nil}, field{"remainingMs", d.RemainingMs != nil}); err != nil {
			return LedgerInput{}, false, err
		}
		if err := oneOf(e, "reason", *d.Reason, rewardReasons); err != nil {
			return LedgerInput{}, false, err
		}
		in.Type = InputRewardEnded
		in.Reason, in.Cost, in.TotalMs, in.RemainingMs = *d.Reason, *d.Cost, *d.TotalMs, *d.RemainingMs
	case "day_closed":
		var d struct {
			Day         *string `json:"day"`
			GoalMinutes *int64  `json:"goalMinutes"`
		}
		if err := decodeData(e, &d); err != nil {
			return LedgerInput{}, false, err
		}
		if err := required(e, field{"day", d.Day != nil}, field{"goalMinutes", d.GoalMinutes != nil}); err != nil {
			return LedgerInput{}, false, err
		}
		if !IsLocalDay(*d.Day) {
			return LedgerInput{}, false, malformed(e, "invalid data.day %q", *d.Day)
		}
		in.Type, in.ClosedDay, in.GoalMinutes = InputDayClosed, *d.Day, *d.GoalMinutes
	case "tamper_detected":
		var d struct {
			BalanceCorrection *int64 `json:"balanceCorrection"`
			VoidStreak        *bool  `json:"voidStreak"`
		}
		if err := decodeData(e, &d); err != nil {
			return LedgerInput{}, false, err
		}
		if err := required(e, field{"balanceCorrection", d.BalanceCorrection != nil}, field{"voidStreak", d.VoidStreak != nil}); err != nil {
			return LedgerInput{}, false, err
		}
		in.Type, in.Amount, in.VoidStreak = InputBalanceCorrection, *d.BalanceCorrection, *d.VoidStreak
	case "ledger_repaired":
		var d struct {
			BalanceCorrection *int64 `json:"balanceCorrection"`
		}
		if err := decodeData(e, &d); err != nil {
			return LedgerInput{}, false, err
		}
		if err := required(e, field{"balanceCorrection", d.BalanceCorrection != nil}); err != nil {
			return LedgerInput{}, false, err
		}
		in.Type, in.Amount, in.VoidStreak = InputBalanceCorrection, *d.BalanceCorrection, false
	case "epoch_started":
		var d struct {
			CarryOverBalance *int64 `json:"carryOverBalance"`
			Escalation       *struct {
				// Raw so that a missing field and null can be told apart.
				LastCountedAt json.RawMessage `json:"lastCountedAt"`
				Index         *int64          `json:"index"`
			} `json:"escalation"`
		}
		if err := decodeData(e, &d); err != nil {
			return LedgerInput{}, false, err
		}
		if err := required(e, field{"carryOverBalance", d.CarryOverBalance != nil}, field{"escalation", d.Escalation != nil}); err != nil {
			return LedgerInput{}, false, err
		}
		if err := required(e, field{"escalation.lastCountedAt", d.Escalation.LastCountedAt != nil}, field{"escalation.index", d.Escalation.Index != nil}); err != nil {
			return LedgerInput{}, false, err
		}
		esc := Escalation{Index: *d.Escalation.Index}
		if raw := bytes.TrimSpace(d.Escalation.LastCountedAt); !bytes.Equal(raw, []byte("null")) {
			var s string
			if err := json.Unmarshal(raw, &s); err != nil {
				return LedgerInput{}, false, malformed(e, "data.escalation.lastCountedAt: %v", err)
			}
			// Trusted time like every timestamp inside an event: never add wallOffsetMs.
			ms, ok := ParseWireTime(s)
			if !ok {
				return LedgerInput{}, false, malformed(e, "invalid data.escalation.lastCountedAt %q", s)
			}
			esc.LastCountedAtMs = ptr(ms)
		}
		in.Type, in.CarryOverBalance, in.Escalation = InputEpochStarted, *d.CarryOverBalance, esc
	}
	return in, true, nil
}

// ReplayResult is the result of ReplayEvents.
type ReplayResult struct {
	State LedgerState
	// Mismatches lists the Seq of ledger events whose derived delta differs from the
	// recorded one (expected only across RULES_VERSIONs).
	Mismatches []int64
	// Malformed lists the Seq of events LedgerInputFromEvent rejected; like unknown
	// events, only their recorded deltas were applied. (Go only: points.ts relies on the
	// client-side validator for this.)
	Malformed []int64
}

// ReplayEvents replays logged events from initial (use InitialLedgerState() for a fresh
// ledger; it is not modified). Recorded envelope deltas are authoritative for the balance
// and XP; the derivation rebuilds everything else (escalation, dedupe, streak). Events
// without ledger effect, unknown types and malformed events apply their recorded deltas
// only.
func ReplayEvents(events []Event, r PointRules, initial LedgerState) ReplayResult {
	state := initial.Clone()
	res := ReplayResult{Mismatches: []int64{}, Malformed: []int64{}}
	for _, e := range events {
		in, ok, err := LedgerInputFromEvent(e)
		if err != nil {
			res.Malformed = append(res.Malformed, e.Seq)
		}
		if !ok {
			state.Balance += e.Points
			state.XP += e.XP
			continue
		}
		before := state
		step := ApplyLedgerInput(before, in, r)
		if step.Points != e.Points || step.XP != e.XP {
			res.Mismatches = append(res.Mismatches, e.Seq)
		}
		state = step.State
		if in.Type == InputEpochStarted {
			state.Balance = e.Points
			state.XP = e.XP
		} else {
			state.Balance = before.Balance + e.Points
			state.XP = before.XP + e.XP
		}
	}
	res.State = state
	return res
}
