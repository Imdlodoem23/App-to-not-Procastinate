package points

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

const testDay = "2026-09-27"

// t0 is 2026-09-27T10:00:00.000Z.
const t0 = int64(1790503200000)

func busyState(t *testing.T) LedgerState {
	t.Helper()
	r := DefaultPointRules()
	s, _ := ComputeLedger([]LedgerInput{
		{Type: InputFocusMinutes, AtMs: t0, Day: "2026-09-26", Minutes: 90},
		{Type: InputDayClosed, AtMs: t0 + 1, Day: testDay, ClosedDay: "2026-09-26", GoalMinutes: 60},
		{Type: InputFocusMinutes, AtMs: t0 + 2, Day: testDay, Minutes: 30},
		{Type: InputAttemptDetected, AtMs: t0 + 3, Day: testDay, Key: "svc:youtube", Penalized: true},
		{Type: InputEmergencyConfirmed, AtMs: t0 + 4, Day: testDay, GoalMinutes: 60},
	}, r, InitialLedgerState())
	return s
}

func TestInitialStateJSONMatchesTypeScript(t *testing.T) {
	// JSON.stringify(initialLedgerState()) in points.ts.
	const want = `{"balance":0,"xp":0,"streak":0,"bestStreak":0,"lastClosedDay":null,"openDays":{},"voidedDay":null,"escalation":{"lastCountedAtMs":null,"index":0},"dedupe":{}}`
	got, err := json.Marshal(InitialLedgerState())
	if err != nil || string(got) != want {
		t.Fatalf("initial state JSON = %s, %v\nwant %s", got, err, want)
	}
	var back LedgerState
	if err := json.Unmarshal(got, &back); err != nil || !reflect.DeepEqual(back, InitialLedgerState()) {
		t.Fatalf("round trip = %+v, %v", back, err)
	}
	busy := busyState(t)
	raw, _ := json.Marshal(busy)
	var back2 LedgerState
	if err := json.Unmarshal(raw, &back2); err != nil || !reflect.DeepEqual(back2, busy) {
		t.Fatalf("busy round trip = %+v, %v", back2, err)
	}
}

func TestApplyNeverModifiesOrAliasesItsInput(t *testing.T) {
	r := DefaultPointRules()
	base := busyState(t)
	before, _ := json.Marshal(base)
	inputs := []LedgerInput{
		{Type: InputAttemptDetected, AtMs: t0 + 10, Day: testDay, Key: "svc:youtube", Penalized: true},
		{Type: InputAttemptDetected, AtMs: t0 + 10, Day: testDay, Key: "svc:tiktok", Penalized: true},
		{Type: InputAttempt, AtMs: t0 + 10, Day: testDay, Key: "svc:youtube", Penalized: true},
		{Type: InputFocusMinutes, AtMs: t0 + 10, Day: testDay, Minutes: 5},
		{Type: InputDayClosed, AtMs: t0 + 10, Day: "2026-09-28", ClosedDay: testDay, GoalMinutes: 60},
		{Type: InputEmergencyConfirmed, AtMs: t0 + 10, Day: testDay, GoalMinutes: 60},
		{Type: InputBalanceCorrection, AtMs: t0 + 10, Day: testDay, Amount: -5, VoidStreak: true},
		{Type: InputEpochStarted, AtMs: t0 + 10, Day: testDay, CarryOverBalance: -5, Escalation: base.Escalation},
	}
	for _, in := range inputs {
		step := ApplyLedgerInput(base, in, r)
		// Mutate everything the result holds: the input must not see it.
		step.State.OpenDays["2026-01-01"] = 999
		step.State.Dedupe["x"] = 1
		if step.State.Escalation.LastCountedAtMs != nil {
			*step.State.Escalation.LastCountedAtMs = 42
		}
		if step.State.VoidedDay != nil {
			*step.State.VoidedDay = "mutated"
		}
		if step.State.LastClosedDay != nil {
			*step.State.LastClosedDay = "mutated"
		}
		if after, _ := json.Marshal(base); string(after) != string(before) {
			t.Fatalf("%s changed its input state:\n%s\n%s", in.Type, before, after)
		}
	}
	if SummarizeLedger(base, SummaryOptions{Today: testDay, GoalMinutes: 60, PendingFocusMinutes: 40}, r).PendingFocusMinutes != 40 {
		t.Fatal("pending minutes")
	}
	if after, _ := json.Marshal(base); string(after) != string(before) {
		t.Fatal("SummarizeLedger changed its input state")
	}
	res := ReplayEvents(nil, r, base)
	res.State.OpenDays["zzz"] = 1
	if after, _ := json.Marshal(base); string(after) != string(before) {
		t.Fatal("ReplayEvents aliases its initial state")
	}
}

func TestCloneOfZeroValueHasMaps(t *testing.T) {
	c := LedgerState{}.Clone()
	if c.OpenDays == nil || c.Dedupe == nil {
		t.Fatal("Clone must allocate maps")
	}
	// A zero LedgerState (e.g. decoded from an old file) is usable as input.
	step := ApplyLedgerInput(LedgerState{}, LedgerInput{Type: InputAttemptDetected, AtMs: t0, Day: testDay, Key: "k", Penalized: true}, DefaultPointRules())
	if step.Outcome.Counted == nil || !*step.Outcome.Counted {
		t.Fatal("attempt on a zero state was not counted")
	}
}

func TestUnknownInputTypeChangesNothing(t *testing.T) {
	base := busyState(t)
	step := ApplyLedgerInput(base, LedgerInput{Type: "future_input", AtMs: t0, Day: testDay, Amount: -500, Minutes: 30}, DefaultPointRules())
	if step.Points != 0 || step.XP != 0 || !reflect.DeepEqual(step.State, base) || step.Outcome != (LedgerOutcome{}) {
		t.Fatalf("unknown input = %+v", step)
	}
}

func TestDedupeWindowSlidesAndPrunes(t *testing.T) {
	r := DefaultPointRules()
	w := int64(r.AttemptDedupeWindowMs)
	detect := func(at int64, key string) LedgerInput {
		return LedgerInput{Type: InputAttemptDetected, AtMs: at, Day: testDay, Key: key, Penalized: true}
	}
	// Merges at w−1 after each previous detection keep sliding the window; exactly w after
	// the last one is a new attempt.
	s, steps := ComputeLedger([]LedgerInput{
		detect(t0, "k"),
		detect(t0+w-1, "k"),
		detect(t0+2*(w-1), "k"),
		detect(t0+2*(w-1)+w, "k"),
	}, r, InitialLedgerState())
	merged := []bool{false, true, true, false}
	for i, st := range steps {
		if *st.Outcome.Merged != merged[i] {
			t.Errorf("step %d merged = %v, want %v", i, *st.Outcome.Merged, merged[i])
		}
		if merged[i] && (st.Points != 0 || st.Outcome.EscalationIndex != nil || *st.Outcome.Penalty != 0) {
			t.Errorf("merged step %d = %+v", i, st)
		}
	}
	if len(s.Dedupe) != 1 {
		t.Errorf("dedupe = %v", s.Dedupe)
	}
	// Entries ahead of atMs (trusted time stepped back) are pruned: the detection counts.
	s2, st2 := ComputeLedger([]LedgerInput{detect(t0, "k"), detect(t0-1, "k")}, r, InitialLedgerState())
	if !*st2[1].Outcome.Counted || s2.Dedupe["k"] != t0-1 {
		t.Errorf("backwards detection = %+v, dedupe %v", st2[1], s2.Dedupe)
	}
	// Old entries of other keys are pruned on every detection.
	s3, _ := ComputeLedger([]LedgerInput{detect(t0, "a"), detect(t0+w, "b")}, r, InitialLedgerState())
	if _, ok := s3.Dedupe["a"]; ok || len(s3.Dedupe) != 1 {
		t.Errorf("dedupe after pruning = %v", s3.Dedupe)
	}
}

func TestZeroDeltasNeverEncodeAsNegativeZero(t *testing.T) {
	r := DefaultPointRules()
	steps := []LedgerInput{
		{Type: InputAttemptDetected, AtMs: t0, Day: testDay, Key: "k", Penalized: false},
		{Type: InputBlockReactivated, AtMs: t0, Day: testDay, RevertPoints: 0},
		{Type: InputRewardRedeemed, AtMs: t0, Day: testDay, Cost: 0},
		{Type: InputBalanceCorrection, AtMs: t0, Day: testDay, Amount: 0},
		{Type: InputEpochStarted, AtMs: t0, Day: testDay, CarryOverBalance: 50},
	}
	for _, in := range steps {
		step := ApplyLedgerInput(InitialLedgerState(), in, r)
		raw, _ := json.Marshal(struct {
			P int64
			S LedgerState
			O LedgerOutcome
		}{step.Points, step.State, step.Outcome})
		if strings.Contains(string(raw), "-0") || step.Points != 0 {
			t.Errorf("%s: %s", in.Type, raw)
		}
	}
}

func TestEmergencyVoidsTodayAndDayCloseClearsIt(t *testing.T) {
	r := DefaultPointRules()
	s, steps := ComputeLedger([]LedgerInput{
		{Type: InputFocusMinutes, AtMs: t0, Day: testDay, Minutes: 60},
		{Type: InputEmergencyConfirmed, AtMs: t0 + 1, Day: testDay, GoalMinutes: 60, AllowanceValue: -30},
		{Type: InputFocusMinutes, AtMs: t0 + 2, Day: testDay, Minutes: 60},
	}, r, InitialLedgerState())
	if *steps[1].Outcome.StreakDaysLost != 1 || steps[1].Points != -int64(r.EmergencyMinPenalty) {
		t.Fatalf("emergency step = %+v (a negative allowance value counts as 0)", steps[1])
	}
	sum := SummarizeLedger(s, SummaryOptions{Today: testDay, GoalMinutes: 60}, r)
	if sum.StreakDays != 0 || sum.Today.GoalMet || sum.Today.FocusMinutes != 120 {
		t.Fatalf("summary after an emergency = %+v", sum)
	}
	s, _ = ComputeLedger([]LedgerInput{{Type: InputDayClosed, AtMs: t0 + 3, Day: "2026-09-28", ClosedDay: testDay, GoalMinutes: 60}}, r, s)
	if s.VoidedDay != nil || s.Streak != 0 || len(s.OpenDays) != 0 {
		t.Fatalf("after closing the voided day = %+v", s)
	}
}

func TestSummaryPendingFocus(t *testing.T) {
	r := DefaultPointRules()
	s := InitialLedgerState()
	for _, pending := range []int64{-7, 0} {
		sum := SummarizeLedger(s, SummaryOptions{Today: testDay, GoalMinutes: 60, PendingFocusMinutes: pending}, r)
		if sum.PendingFocusMinutes != 0 || sum.Balance != 0 || sum.Today.FocusMinutes != 0 {
			t.Errorf("pending %d = %+v", pending, sum)
		}
	}
	sum := SummarizeLedger(s, SummaryOptions{Today: testDay, GoalMinutes: 60, PendingFocusMinutes: 60}, r)
	if !sum.Today.GoalMet || sum.StreakDays != 1 || sum.BestStreakDays != 1 || sum.XP != 60*int64(r.XPPerFocusMinute) ||
		sum.Balance != 60*int64(r.StudyPointsPerFocusMinute) || sum.Level != LevelForXP(sum.XP, r) ||
		sum.LevelFloorXP != XPForLevel(sum.Level, r) || sum.NextLevelXP != XPForLevel(sum.Level+1, r) {
		t.Errorf("summary with 60 pending minutes = %+v", sum)
	}
	raw, _ := json.Marshal(sum)
	for _, key := range []string{`"levelFloorXp"`, `"nextLevelXp"`, `"today":{"day":"2026-09-27","focusMinutes":60,"goalMinutes":60,"goalMet":true}`, `"pendingFocusMinutes":60`} {
		if !strings.Contains(string(raw), key) {
			t.Errorf("summary JSON %s lacks %s", raw, key)
		}
	}
}

func TestStreakAsOfWithInvalidDays(t *testing.T) {
	r := DefaultPointRules()
	s, _ := ComputeLedger([]LedgerInput{
		{Type: InputFocusMinutes, AtMs: t0, Day: "2026-09-26", Minutes: 60},
		{Type: InputDayClosed, AtMs: t0, Day: testDay, ClosedDay: "2026-09-26", GoalMinutes: 60},
	}, r, InitialLedgerState())
	if got := StreakAsOf(s, testDay, 60); got != 1 {
		t.Fatalf("streak = %d", got)
	}
	// Like NaN in points.ts: an invalid day is never open and never near the closed day.
	if got := StreakAsOf(s, "bogus", 60); got != 0 {
		t.Errorf("streak on an invalid day = %d", got)
	}
	step := ApplyLedgerInput(s, LedgerInput{Type: InputDayClosed, AtMs: t0, Day: testDay, ClosedDay: "bogus", GoalMinutes: 60}, r)
	if step.Outcome.Met != nil || !reflect.DeepEqual(step.State, s) {
		t.Errorf("closing an invalid day = %+v", step)
	}
}
