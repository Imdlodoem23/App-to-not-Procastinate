package points

import (
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"testing"
)

func ev(seq int64, typ string, points, xp int64, data string) Event {
	e := Event{Seq: seq, At: "2026-09-27T10:00:00.000Z", Day: testDay, Type: typ, Points: points, XP: xp}
	if data != "" {
		e.Data = json.RawMessage(data)
	}
	return e
}

func TestLedgerInputFromEventMapping(t *testing.T) {
	cases := []struct {
		e    Event
		want LedgerInput
	}{
		{ev(1, "attempt", -10, 0, `{"targetKey":"svc:youtube","penalized":true,"escalationIndex":0}`),
			LedgerInput{Type: InputAttempt, Key: "svc:youtube", Penalized: true}},
		{ev(1, "block_completed", 80, 0, `{"kind":"manual","creditedMinutes":60,"attemptsCounted":0}`),
			LedgerInput{Type: InputBlockCompleted, Kind: "manual", CreditedMinutes: 60}},
		{ev(1, "block_reactivated", -80, 0, `{"revertPoints":80}`),
			LedgerInput{Type: InputBlockReactivated, RevertPoints: 80}},
		{ev(1, "focus_minutes", 10, 5, `{"sessionId":"stu_x","minutes":5}`),
			LedgerInput{Type: InputFocusMinutes, Minutes: 5}},
		{ev(1, "strike", -15, 0, `{"sessionId":"stu_x"}`), LedgerInput{Type: InputStrike}},
		{ev(1, "punishment_started", -100, 0, `{"punishment":{}}`), LedgerInput{Type: InputPunishmentStarted}},
		{ev(1, "study_ended", 20, 0, `{"outcome":"completed","strikes":0,"attempts":0,"plannedMinutes":50}`),
			LedgerInput{Type: InputStudyEnded, Outcome: "completed", PlannedMinutes: 50}},
		{ev(1, "emergency_confirmed", -200, 0, `{"goalMinutes":60,"allowanceValue":30}`),
			LedgerInput{Type: InputEmergencyConfirmed, GoalMinutes: 60, AllowanceValue: 30}},
		{ev(1, "reward_redeemed", -150, 0, `{"offerCost":150,"allowanceCost":300}`),
			LedgerInput{Type: InputRewardRedeemed, Cost: 150}},
		{ev(1, "reward_ended", 50, 0, `{"reason":"revoked","cost":150,"totalMs":900000,"remainingMs":300000}`),
			LedgerInput{Type: InputRewardEnded, Reason: "revoked", Cost: 150, TotalMs: 900000, RemainingMs: 300000}},
		{ev(1, "day_closed", 0, 0, `{"day":"2026-09-26","goalMinutes":60}`),
			LedgerInput{Type: InputDayClosed, ClosedDay: "2026-09-26", GoalMinutes: 60}},
		{ev(1, "tamper_detected", -200, 0, `{"kind":"service_stopped","balanceCorrection":-200,"voidStreak":true}`),
			LedgerInput{Type: InputBalanceCorrection, Amount: -200, VoidStreak: true}},
		{ev(1, "ledger_repaired", -5, 0, `{"balanceCorrection":-5}`),
			LedgerInput{Type: InputBalanceCorrection, Amount: -5}},
		{ev(1, "epoch_started", -40, 0, `{"carryOverBalance":-40,"escalation":{"lastCountedAt":"2026-09-27T09:58:00.000Z","index":2}}`),
			LedgerInput{Type: InputEpochStarted, CarryOverBalance: -40, Escalation: Escalation{LastCountedAtMs: ptr(t0 - 120_000), Index: 2}}},
		{ev(1, "epoch_started", 0, 0, `{"carryOverBalance":0,"escalation":{"lastCountedAt":null,"index":0}}`),
			LedgerInput{Type: InputEpochStarted}},
	}
	for _, c := range cases {
		c.want.AtMs, c.want.Day = t0, testDay
		got, ok, err := LedgerInputFromEvent(c.e)
		if err != nil || !ok || !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %+v, %v, %v\nwant %+v", c.e.Type, got, ok, err, c.want)
		}
	}
}

func TestLedgerInputFromEventWithoutLedgerEffect(t *testing.T) {
	for _, e := range []Event{
		ev(1, "guardian_started", 0, 0, `{}`),
		ev(1, "block_created", 0, 0, `{"block":{}}`),
		ev(1, "some_future_type", -3, 1, `{"x":1}`),
		ev(1, "", 0, 0, ``),
		// A MalformedGuardianEvent is treated as unknown, whatever its data.
		{Seq: 1, At: "bad", Day: "bad", Type: "strike", Points: -15, Data: json.RawMessage(`5`), Malformed: json.RawMessage(`{"path":"data"}`)},
	} {
		if in, ok, err := LedgerInputFromEvent(e); ok || err != nil {
			t.Errorf("%q: got %+v, %v, %v; want no input", e.Type, in, ok, err)
		}
	}
	// "malformed": null is not a malformed event.
	e := ev(1, "strike", -15, 0, `{}`)
	e.Malformed = json.RawMessage(`null`)
	if _, ok, err := LedgerInputFromEvent(e); !ok || err != nil {
		t.Errorf("malformed: null = %v, %v", ok, err)
	}
}

func TestLedgerInputFromEventRejectsMalformedData(t *testing.T) {
	bad := []Event{
		ev(1, "attempt", -10, 0, `{"penalized":true}`),
		ev(1, "attempt", -10, 0, `{"targetKey":5,"penalized":true}`),
		ev(1, "attempt", -10, 0, `null`),
		ev(1, "strike", -15, 0, ``),
		ev(1, "strike", -15, 0, `[]`),
		ev(1, "block_completed", 0, 0, `{"kind":"bogus","creditedMinutes":1,"attemptsCounted":0}`),
		ev(1, "block_completed", 0, 0, `{"kind":"manual","creditedMinutes":1.5,"attemptsCounted":0}`),
		ev(1, "study_ended", 0, 0, `{"outcome":"won","strikes":0,"attempts":0,"plannedMinutes":50}`),
		ev(1, "reward_ended", 0, 0, `{"reason":"lost","cost":1,"totalMs":1,"remainingMs":1}`),
		ev(1, "day_closed", 0, 0, `{"day":"2026-02-30","goalMinutes":60}`),
		ev(1, "tamper_detected", 0, 0, `{"balanceCorrection":0}`),
		ev(1, "epoch_started", 0, 0, `{"carryOverBalance":0,"escalation":{"index":0}}`),
		ev(1, "epoch_started", 0, 0, `{"carryOverBalance":0,"escalation":{"lastCountedAt":"yesterday","index":0}}`),
		{Seq: 1, At: "2026-09-27T10:00:00Z", Day: testDay, Type: "strike", Data: json.RawMessage(`{}`)},
		{Seq: 1, At: "2026-09-27T10:00:00.000Z", Day: "2026-9-27", Type: "strike", Data: json.RawMessage(`{}`)},
	}
	for _, e := range bad {
		if in, ok, err := LedgerInputFromEvent(e); ok || !errors.Is(err, ErrMalformedEvent) {
			t.Errorf("%s %s: got %+v, %v, %v; want ErrMalformedEvent", e.Type, e.Data, in, ok, err)
		}
	}
}

func TestReplayEvents(t *testing.T) {
	r := DefaultPointRules()
	events := []Event{
		ev(1, "epoch_started", -40, 0, `{"carryOverBalance":-40,"escalation":{"lastCountedAt":null,"index":0}}`),
		ev(2, "focus_minutes", 20, 10, `{"minutes":10}`),
		ev(3, "some_future_type", -3, 1, `{"x":1}`),
		// Recorded with other rules: the recorded delta wins and the seq is reported.
		ev(4, "strike", -25, 0, `{}`),
		// Malformed: recorded deltas apply and the seq is reported.
		ev(5, "attempt", -10, 0, `{"penalized":true}`),
		ev(6, "guardian_started", 0, 0, `{}`),
	}
	res := ReplayEvents(events, r, InitialLedgerState())
	if res.State.Balance != -40+20-3-25-10 || res.State.XP != 11 {
		t.Errorf("balance/xp = %d/%d", res.State.Balance, res.State.XP)
	}
	if !slices.Equal(res.Mismatches, []int64{4}) || !slices.Equal(res.Malformed, []int64{5}) {
		t.Errorf("mismatches %v malformed %v", res.Mismatches, res.Malformed)
	}
	if res.State.OpenDays[testDay] != 10 {
		t.Errorf("openDays = %v", res.State.OpenDays)
	}
	// A later epoch drops the XP and a positive balance.
	res2 := ReplayEvents(append(events, ev(7, "epoch_started", 0, 0, `{"carryOverBalance":0,"escalation":{"lastCountedAt":null,"index":0}}`)), r, InitialLedgerState())
	if res2.State.Balance != 0 || res2.State.XP != 0 || len(res2.State.OpenDays) != 0 {
		t.Errorf("after a new epoch = %+v", res2.State)
	}
	// Empty input: empty, non-nil lists.
	empty := ReplayEvents(nil, r, InitialLedgerState())
	if empty.Mismatches == nil || empty.Malformed == nil {
		t.Error("lists must be non-nil")
	}
}

func TestReplayMatchesComputeLedger(t *testing.T) {
	// Logging each step with its derived delta and replaying the log rebuilds the state.
	r := DefaultPointRules()
	inputs := []LedgerInput{
		{Type: InputFocusMinutes, AtMs: t0, Day: "2026-09-26", Minutes: 70},
		{Type: InputDayClosed, AtMs: t0 + 1000, Day: testDay, ClosedDay: "2026-09-26", GoalMinutes: 60},
		{Type: InputAttempt, AtMs: t0 + 2000, Day: testDay, Key: "svc:youtube", Penalized: true},
		{Type: InputAttempt, AtMs: t0 + 3000, Day: testDay, Key: "svc:tiktok", Penalized: true},
		{Type: InputBlockCompleted, AtMs: t0 + 4000, Day: testDay, Kind: "manual", CreditedMinutes: 30, AttemptsCounted: 2},
	}
	state, steps := ComputeLedger(inputs, r, InitialLedgerState())
	data := []string{
		`{"minutes":70}`,
		`{"day":"2026-09-26","goalMinutes":60}`,
		`{"targetKey":"svc:youtube","penalized":true}`,
		`{"targetKey":"svc:tiktok","penalized":true}`,
		`{"kind":"manual","creditedMinutes":30,"attemptsCounted":2}`,
	}
	events := make([]Event, len(inputs))
	for i, in := range inputs {
		events[i] = Event{Seq: int64(i + 1), At: formatWireTime(in.AtMs), Day: in.Day, Type: string(in.Type),
			Points: steps[i].Points, XP: steps[i].XP, Data: json.RawMessage(data[i])}
	}
	res := ReplayEvents(events, r, InitialLedgerState())
	if len(res.Mismatches) != 0 || len(res.Malformed) != 0 || !reflect.DeepEqual(res.State, state) {
		t.Fatalf("replay = %+v\nwant %+v", res, state)
	}
}
