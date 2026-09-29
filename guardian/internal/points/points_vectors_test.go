package points

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
	"time"
)

// vectorsPath is the shared parity file, read in place (ARCHITECTURE §6.4). vitest runs
// the same file in packages/shared/test/points.test.ts.
const vectorsPath = "../../../packages/shared/test/fixtures/points-vectors.json"

type vectorFile struct {
	Comment        []string        `json:"$comment"`
	FormatVersion  int             `json:"formatVersion"`
	RulesVersion   int             `json:"rulesVersion"`
	Functions      []functionCase  `json:"functions"`
	Sequences      []sequenceCase  `json:"sequences"`
	EventSequences []eventSequence `json:"eventSequences"`
}

type functionCase struct {
	Name   string            `json:"name"`
	Fn     string            `json:"fn"`
	Args   []json.RawMessage `json:"args"`
	Expect json.RawMessage   `json:"expect"`
}

type sequenceCase struct {
	Name  string `json:"name"`
	Steps []struct {
		Input  json.RawMessage            `json:"input"`
		Expect map[string]json.RawMessage `json:"expect"`
	} `json:"steps"`
	Summary struct {
		Today               string `json:"today"`
		GoalMinutes         int64  `json:"goalMinutes"`
		PendingFocusMinutes *int64 `json:"pendingFocusMinutes"`
	} `json:"summary"`
	ExpectFinal map[string]json.RawMessage `json:"expectFinal"`
}

type eventSequence struct {
	Name             string                     `json:"name"`
	Events           []json.RawMessage          `json:"events"`
	ExpectMismatches []int64                    `json:"expectMismatches"`
	ExpectFinal      map[string]json.RawMessage `json:"expectFinal"`
}

// vectorInput is a sequence step input: a LedgerInput with `at` as a wire timestamp
// (and escalation.lastCountedAt too).
type vectorInput struct {
	Type             string `json:"type"`
	At               string `json:"at"`
	Day              string `json:"day"`
	Key              string `json:"key"`
	Penalized        bool   `json:"penalized"`
	Kind             string `json:"kind"`
	CreditedMinutes  int64  `json:"creditedMinutes"`
	AttemptsCounted  int64  `json:"attemptsCounted"`
	RevertPoints     int64  `json:"revertPoints"`
	Minutes          int64  `json:"minutes"`
	Outcome          string `json:"outcome"`
	Strikes          int64  `json:"strikes"`
	Attempts         int64  `json:"attempts"`
	PlannedMinutes   int64  `json:"plannedMinutes"`
	GoalMinutes      int64  `json:"goalMinutes"`
	AllowanceValue   int64  `json:"allowanceValue"`
	Cost             int64  `json:"cost"`
	Reason           string `json:"reason"`
	TotalMs          int64  `json:"totalMs"`
	RemainingMs      int64  `json:"remainingMs"`
	ClosedDay        string `json:"closedDay"`
	Amount           int64  `json:"amount"`
	VoidStreak       bool   `json:"voidStreak"`
	CarryOverBalance int64  `json:"carryOverBalance"`
	Escalation       *struct {
		LastCountedAt *string `json:"lastCountedAt"`
		Index         int64   `json:"index"`
	} `json:"escalation"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(vectorsPath))
	if err != nil {
		t.Fatalf("read the shared points vectors in place: %v", err)
	}
	var v vectorFile
	strictDecode(t, raw, &v)
	if v.FormatVersion != 1 {
		t.Fatalf("formatVersion = %d, this runner understands 1", v.FormatVersion)
	}
	if v.RulesVersion != RulesVersion() {
		t.Fatalf("vectors are for rulesVersion %d, embedded rules are %d (regenerate guardian/internal/embedded)",
			v.RulesVersion, RulesVersion())
	}
	if len(v.Functions) == 0 || len(v.Sequences) == 0 || len(v.EventSequences) == 0 {
		t.Fatal("vectors file has an empty section")
	}
	return v
}

// strictDecode decodes JSON rejecting unknown fields, so a new vector field fails here
// instead of being silently ignored.
func strictDecode(t *testing.T, raw []byte, v any) {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		t.Fatalf("decode %T: %v", v, err)
	}
}

func arg[T any](t *testing.T, c functionCase, i int) T {
	t.Helper()
	var v T
	if i >= len(c.Args) {
		t.Fatalf("%s: missing argument %d", c.Name, i)
	}
	strictDecode(t, c.Args[i], &v)
	return v
}

// sameJSON compares a Go value with an expected JSON value by their JSON encodings
// (numbers compared as numbers, null as nil).
func sameJSON(t *testing.T, got any, want json.RawMessage) bool {
	t.Helper()
	gotRaw, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal %v: %v", got, err)
	}
	var g, w any
	if err := json.Unmarshal(gotRaw, &g); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatal(err)
	}
	return reflect.DeepEqual(g, w)
}

func formatWireTime(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

func callVectorFunction(t *testing.T, c functionCase) any {
	t.Helper()
	pr, er := DefaultPointRules(), DefaultEmergencyRules()
	switch c.Fn {
	case "attemptPenalty":
		return AttemptPenalty(arg[int64](t, c, 0), pr)
	case "maxEscalationIndex":
		return MaxEscalationIndex(pr)
	case "emergencyPenalty":
		return EmergencyPenalty(arg[int64](t, c, 0), pr)
	case "emergencyCountdownMinutes":
		if m, ok := EmergencyCountdownMinutes(arg[[]string](t, c, 0), er); ok {
			return m
		}
		return nil
	case "isEmergencyEligibleMode":
		return IsEmergencyEligibleMode(arg[string](t, c, 0))
	case "levelForXp":
		return LevelForXP(arg[int64](t, c, 0), pr)
	case "xpForLevel":
		return XPForLevel(arg[int64](t, c, 0), pr)
	case "allowanceRefund":
		return AllowanceRefund(arg[int64](t, c, 0), arg[int64](t, c, 1), arg[int64](t, c, 2))
	case "allowanceValue":
		return AllowanceValue(arg[[]AllowanceWorth](t, c, 0))
	case "blockCompletionPoints":
		// The vectors compare the total.
		return BlockCompletionPoints(arg[string](t, c, 0), arg[int64](t, c, 1), arg[int64](t, c, 2), pr).Total
	case "studyEndBonus":
		return StudyEndBonus(arg[string](t, c, 0), arg[int64](t, c, 1), arg[int64](t, c, 2), arg[int64](t, c, 3), pr)
	case "emergencyPhraseMatches":
		return EmergencyPhraseMatches(arg[string](t, c, 0), er)
	case "normalizePhrase":
		return NormalizePhrase(arg[string](t, c, 0))
	case "addDays":
		day, err := AddDays(arg[string](t, c, 0), arg[int64](t, c, 1))
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		return day
	case "isLocalDay":
		return IsLocalDay(arg[string](t, c, 0))
	case "dayNumber":
		if n, ok := DayNumber(arg[string](t, c, 0)); ok {
			return n
		}
		return nil
	case "pomodoroPlannedMinutes":
		p := arg[struct {
			WorkMinutes  int64 `json:"workMinutes"`
			BreakMinutes int64 `json:"breakMinutes"`
			Cycles       int64 `json:"cycles"`
		}](t, c, 0)
		return PomodoroPlannedMinutes(p.WorkMinutes, p.BreakMinutes, p.Cycles)
	}
	t.Fatalf("%s: the Go runner does not know fn %q (add it to callVectorFunction)", c.Name, c.Fn)
	return nil
}

func TestPointsVectorsFunctions(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.Functions {
		t.Run(c.Name, func(t *testing.T) {
			got := callVectorFunction(t, c)
			if !sameJSON(t, got, c.Expect) {
				t.Errorf("%s(%s) = %v, want %s", c.Fn, joinRaw(c.Args), got, c.Expect)
			}
		})
	}
}

func joinRaw(args []json.RawMessage) string {
	parts := make([][]byte, len(args))
	for i, a := range args {
		parts[i] = a
	}
	return string(bytes.Join(parts, []byte(", ")))
}

func toLedgerInput(t *testing.T, raw json.RawMessage) LedgerInput {
	t.Helper()
	var vi vectorInput
	strictDecode(t, raw, &vi)
	at, ok := ParseWireTime(vi.At)
	if !ok {
		t.Fatalf("invalid at %q", vi.At)
	}
	in := LedgerInput{
		Type:             InputType(vi.Type),
		AtMs:             at,
		Day:              vi.Day,
		Key:              vi.Key,
		Penalized:        vi.Penalized,
		Kind:             vi.Kind,
		CreditedMinutes:  vi.CreditedMinutes,
		AttemptsCounted:  vi.AttemptsCounted,
		RevertPoints:     vi.RevertPoints,
		Minutes:          vi.Minutes,
		Outcome:          vi.Outcome,
		Strikes:          vi.Strikes,
		Attempts:         vi.Attempts,
		PlannedMinutes:   vi.PlannedMinutes,
		GoalMinutes:      vi.GoalMinutes,
		AllowanceValue:   vi.AllowanceValue,
		Cost:             vi.Cost,
		Reason:           vi.Reason,
		TotalMs:          vi.TotalMs,
		RemainingMs:      vi.RemainingMs,
		ClosedDay:        vi.ClosedDay,
		Amount:           vi.Amount,
		VoidStreak:       vi.VoidStreak,
		CarryOverBalance: vi.CarryOverBalance,
	}
	if vi.Escalation != nil {
		in.Escalation.Index = vi.Escalation.Index
		if vi.Escalation.LastCountedAt != nil {
			ms, ok := ParseWireTime(*vi.Escalation.LastCountedAt)
			if !ok {
				t.Fatalf("invalid escalation.lastCountedAt %q", *vi.Escalation.LastCountedAt)
			}
			in.Escalation.LastCountedAtMs = &ms
		}
	}
	return in
}

// stepFields are the comparable fields of one step: the deltas, the balance after it and
// the outcome fields (nil pointers encode as null).
func stepFields(step LedgerStep) map[string]any {
	o := step.Outcome
	return map[string]any{
		"points":          step.Points,
		"xp":              step.XP,
		"balance":         step.State.Balance,
		"counted":         o.Counted,
		"merged":          o.Merged,
		"escalationIndex": o.EscalationIndex,
		"penalty":         o.Penalty,
		"cleanBonus":      o.CleanBonus,
		"met":             o.Met,
		"streakDaysLost":  o.StreakDaysLost,
		"refund":          o.Refund,
	}
}

func summaryFields(s PointsSummary) map[string]any {
	return map[string]any{
		"balance":             s.Balance,
		"xp":                  s.XP,
		"level":               s.Level,
		"levelFloorXp":        s.LevelFloorXP,
		"nextLevelXp":         s.NextLevelXP,
		"streakDays":          s.StreakDays,
		"bestStreakDays":      s.BestStreakDays,
		"todayFocusMinutes":   s.Today.FocusMinutes,
		"todayGoalMet":        s.Today.GoalMet,
		"todayGoalMinutes":    s.Today.GoalMinutes,
		"pendingFocusMinutes": s.PendingFocusMinutes,
	}
}

func compareFields(t *testing.T, what string, got map[string]any, want map[string]json.RawMessage) {
	t.Helper()
	keys := make([]string, 0, len(want))
	for k := range want {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		g, known := got[k]
		if !known {
			t.Errorf("%s: the Go runner does not know expect key %q", what, k)
			continue
		}
		if !sameJSON(t, g, want[k]) {
			gotJSON, _ := json.Marshal(g)
			t.Errorf("%s: %s = %s, want %s", what, k, gotJSON, want[k])
		}
	}
}

func TestPointsVectorsSequences(t *testing.T) {
	v := loadVectors(t)
	rules := DefaultPointRules()
	for _, c := range v.Sequences {
		t.Run(c.Name, func(t *testing.T) {
			state := InitialLedgerState()
			for i, s := range c.Steps {
				in := toLedgerInput(t, s.Input)
				before, _ := json.Marshal(state)
				step := ApplyLedgerInput(state, in, rules)
				if after, _ := json.Marshal(state); !bytes.Equal(before, after) {
					t.Fatalf("step %d (%s) modified its input state", i, in.Type)
				}
				compareFields(t, "step "+itoa(i)+" ("+string(in.Type)+")", stepFields(step), s.Expect)
				state = step.State
			}
			opts := SummaryOptions{Today: c.Summary.Today, GoalMinutes: c.Summary.GoalMinutes}
			if c.Summary.PendingFocusMinutes != nil {
				opts.PendingFocusMinutes = *c.Summary.PendingFocusMinutes
			}
			compareFields(t, "summary", summaryFields(SummarizeLedger(state, opts, rules)), c.ExpectFinal)

			// ComputeLedger folds the same inputs to the same state and deltas.
			inputs := make([]LedgerInput, len(c.Steps))
			for i, s := range c.Steps {
				inputs[i] = toLedgerInput(t, s.Input)
			}
			folded, deltas := ComputeLedger(inputs, rules, InitialLedgerState())
			if !reflect.DeepEqual(folded, state) {
				t.Errorf("ComputeLedger state = %+v, want %+v", folded, state)
			}
			if len(deltas) != len(c.Steps) {
				t.Fatalf("ComputeLedger gave %d deltas, want %d", len(deltas), len(c.Steps))
			}
		})
	}
}

func itoa(i int) string {
	b, _ := json.Marshal(i)
	return string(b)
}

func TestPointsVectorsEventSequences(t *testing.T) {
	v := loadVectors(t)
	rules := DefaultPointRules()
	for _, c := range v.EventSequences {
		t.Run(c.Name, func(t *testing.T) {
			events := make([]Event, len(c.Events))
			for i, raw := range c.Events {
				if err := json.Unmarshal(raw, &events[i]); err != nil {
					t.Fatalf("event %d: %v", i, err)
				}
			}
			res := ReplayEvents(events, rules, InitialLedgerState())
			want := c.ExpectMismatches
			if want == nil {
				want = []int64{}
			}
			if !slices.Equal(res.Mismatches, want) {
				t.Errorf("mismatches = %v, want %v", res.Mismatches, want)
			}
			if len(res.Malformed) != 0 {
				t.Errorf("malformed = %v, want none", res.Malformed)
			}
			s := res.State
			var lastCountedAt any
			if s.Escalation.LastCountedAtMs != nil {
				lastCountedAt = formatWireTime(*s.Escalation.LastCountedAtMs)
			}
			got := map[string]any{
				"balance":                 s.Balance,
				"xp":                      s.XP,
				"streak":                  s.Streak,
				"bestStreak":              s.BestStreak,
				"lastClosedDay":           s.LastClosedDay,
				"voidedDay":               s.VoidedDay,
				"escalationIndex":         s.Escalation.Index,
				"escalationLastCountedAt": lastCountedAt,
			}
			compareFields(t, "final state", got, c.ExpectFinal)
		})
	}
}
