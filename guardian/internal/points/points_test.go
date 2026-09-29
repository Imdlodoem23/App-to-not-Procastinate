package points

import (
	"math"
	"strings"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

// Expected values below that are not rules were computed with the TypeScript
// implementation (node) for the JavaScript edge cases (Date.UTC, Date.parse,
// toISOString, Math.round).

func TestEmbeddedRulesAreUsable(t *testing.T) {
	r := DefaultPointRules()
	if r.EmergencyBalanceDivisor <= 0 || r.LevelXPStep <= 0 || r.AttemptPenaltyMultiplier < 1 ||
		r.AttemptBasePenalty <= 0 || r.AttemptPenaltyCap < r.AttemptBasePenalty ||
		r.AttemptDedupeWindowMs <= 0 || r.AttemptEscalationWindowMs <= 0 || len(r.EarningBlockKinds) == 0 {
		t.Fatalf("embedded point rules are degenerate: %+v", r)
	}
	e := DefaultEmergencyRules()
	if e.Phrases.ES == "" || e.Phrases.EN == "" || e.CountdownMinutes.Normal <= 0 || e.CountdownMinutes.Strict <= 0 {
		t.Fatalf("embedded emergency rules are degenerate: %+v", e)
	}
	if RulesVersion() <= 0 {
		t.Fatal("no rules version")
	}
}

func TestEscalationIndexAndPenalty(t *testing.T) {
	r := DefaultPointRules()
	maxIdx := MaxEscalationIndex(r)
	if AttemptPenalty(maxIdx, r) != int64(r.AttemptPenaltyCap) || AttemptPenalty(maxIdx-1, r) >= int64(r.AttemptPenaltyCap) {
		t.Fatalf("MaxEscalationIndex = %d is not the first capped index", maxIdx)
	}
	if AttemptPenalty(-3, r) != int64(r.AttemptBasePenalty) {
		t.Error("a negative index must clamp to 0")
	}
	if AttemptPenalty(math.MaxInt64, r) != int64(r.AttemptPenaltyCap) {
		t.Error("a huge index must clamp to the cap")
	}

	last := int64(1_000_000)
	prev := Escalation{LastCountedAtMs: &last, Index: 1}
	window := int64(r.AttemptEscalationWindowMs)
	cases := []struct {
		at   int64
		want int64
	}{
		{last, 2},
		{last + window - 1, 2},
		{last + window, 0}, // reset at exactly the window
		{last - 1, 0},      // trusted time stepped back
	}
	for _, c := range cases {
		if got := NextEscalationIndex(prev, c.at, r); got != c.want {
			t.Errorf("NextEscalationIndex(at %+d) = %d, want %d", c.at-last, got, c.want)
		}
	}
	if got := NextEscalationIndex(Escalation{}, last, r); got != 0 {
		t.Errorf("first attempt index = %d, want 0", got)
	}
	capped := Escalation{LastCountedAtMs: &last, Index: maxIdx}
	if got := NextEscalationIndex(capped, last+1, r); got != maxIdx {
		t.Errorf("index past the cap = %d, want %d", got, maxIdx)
	}
}

func TestDegenerateRulesNeverPanicOrHang(t *testing.T) {
	r := DefaultPointRules()
	r.AttemptPenaltyMultiplier = 1
	if got := MaxEscalationIndex(r); got != maxEscalationSteps {
		t.Errorf("MaxEscalationIndex with multiplier 1 = %d, want the %d-step bound", got, maxEscalationSteps)
	}
	r = DefaultPointRules()
	r.EmergencyBalanceDivisor = 0
	if got := EmergencyPenalty(1_000_000, r); got != int64(r.EmergencyMinPenalty) {
		t.Errorf("EmergencyPenalty with divisor 0 = %d", got)
	}
	r = DefaultPointRules()
	r.LevelXPStep = 0
	if LevelForXP(1000, r) != 1 || XPForLevel(5, r) != 0 {
		t.Error("level curve with step 0")
	}
}

func TestEmergencyPenaltyUsesTheBase(t *testing.T) {
	r := DefaultPointRules()
	min := int64(r.EmergencyMinPenalty)
	div := int64(r.EmergencyBalanceDivisor)
	big := 10 * min * div
	if got := EmergencyPenalty(big+1, r); got != (big+1)/div {
		t.Errorf("EmergencyPenalty(%d) = %d", big+1, got)
	}
	if got := EmergencyPenalty(math.MinInt64, r); got != min {
		t.Errorf("EmergencyPenalty(MinInt64) = %d", got)
	}
}

func TestEmergencyCountdown(t *testing.T) {
	e := DefaultEmergencyRules()
	if m, ok := EmergencyCountdownMinutes([]string{"normal", "normal"}, e); !ok || m != int64(e.CountdownMinutes.Normal) {
		t.Errorf("normal = %d,%v", m, ok)
	}
	if m, ok := EmergencyCountdownMinutes([]string{"normal", "strict"}, e); !ok || m != int64(e.CountdownMinutes.Strict) {
		t.Errorf("normal+strict = %d,%v", m, ok)
	}
	for _, modes := range [][]string{nil, {"exam"}, {"strict", "hardcore"}, {"Normal"}} {
		if _, ok := EmergencyCountdownMinutes(modes, e); ok {
			t.Errorf("%v must have no countdown", modes)
		}
	}
}

func TestNormalizePhrase(t *testing.T) {
	cases := map[string]string{
		"":                   "",
		" ":                  "",
		".":                  "",
		" . ":                "",
		"a  b":               "a b",
		"a b":                "a b",     // other Unicode spaces are kept
		"ÁRBOL Ñ":            "Árbol Ñ", // ASCII-only lowercase
		"x..":                "x.",
		"hola .":             "hola",
		"\t\n\r\f\vA\t":      "a",
		"a \xff b":           "a \xff b", // invalid UTF-8 is kept byte for byte
		"😀 SMILE.":           "😀 smile",
		"  two  words .  ":   "two words",
		"trailing dot. ":     "trailing dot",
		"space before . end": "space before . end",
	}
	for in, want := range cases {
		if got := NormalizePhrase(in); got != want {
			t.Errorf("NormalizePhrase(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEmergencyPhraseLengthBound(t *testing.T) {
	e := DefaultEmergencyRules()
	phrase := e.Phrases.ES
	pad := maxPhraseUTF16 - utf16Len(phrase)
	if !EmergencyPhraseMatches(phrase+strings.Repeat(" ", pad), e) {
		t.Error("a phrase of exactly the bound must match")
	}
	if EmergencyPhraseMatches(phrase+strings.Repeat(" ", pad+1), e) {
		t.Error("a phrase over the bound must not match")
	}
	if got := utf16Len("a😀á"); got != 4 {
		t.Errorf("utf16Len = %d, want 4 (astral characters count 2)", got)
	}
	if !EmergencyPhraseMatches(strings.ToUpper(e.Phrases.EN)+".", e) {
		t.Error("the English phrase must match too")
	}
}

func TestBlockAndStudyBonus(t *testing.T) {
	r := DefaultPointRules()
	minMin := int64(r.CleanSessionMinMinutes)
	bp := BlockCompletionPoints("manual", minMin, 0, r)
	if bp.CleanBonus != int64(r.CleanSessionBonus) || bp.MinutePoints != minMin*int64(r.BlockPointsPerMinute) ||
		bp.Total != bp.MinutePoints+bp.CleanBonus {
		t.Errorf("BlockCompletionPoints at the minimum = %+v", bp)
	}
	if bp := BlockCompletionPoints("manual", minMin-1, 0, r); bp.CleanBonus != 0 {
		t.Errorf("below the minimum = %+v", bp)
	}
	if bp := BlockCompletionPoints("schedule", -5, 0, r); bp != (BlockPoints{}) {
		t.Errorf("negative credit = %+v", bp)
	}
	if !IsEarningBlockKind("manual", r) || IsEarningBlockKind("punishment", r) || IsEarningBlockKind("", r) {
		t.Error("IsEarningBlockKind")
	}
	if StudyEndBonus("completed", 0, 0, minMin, r) != int64(r.CleanSessionBonus) {
		t.Error("clean study at the minimum")
	}
}

func TestAllowanceRefundDoesNotOverflow(t *testing.T) {
	const big = math.MaxInt64 / 3
	if got := AllowanceRefund(big, math.MaxInt64, math.MaxInt64); got != big {
		t.Errorf("full refund = %d, want %d", got, big)
	}
	if got := AllowanceRefund(big, math.MaxInt64-1, (math.MaxInt64-1)/2); got != big/2 {
		t.Errorf("half refund = %d, want %d", got, big/2)
	}
	if got := AllowanceValue([]AllowanceWorth{{Cost: 150, TotalMs: 900_000, RemainingMs: 450_000}, {Cost: -1, TotalMs: 1, RemainingMs: 1}}); got != 75 {
		t.Errorf("AllowanceValue = %d, want 75", got)
	}
}

func TestLevels(t *testing.T) {
	r := DefaultPointRules()
	for xp := int64(-5); xp <= 50_000; xp++ {
		l := LevelForXP(xp, r)
		if l < 1 || (xp >= 0 && (XPForLevel(l, r) > xp || XPForLevel(l+1, r) <= xp)) {
			t.Fatalf("LevelForXP(%d) = %d is outside its band", xp, l)
		}
	}
	// Huge XP neither hangs nor overflows.
	l := LevelForXP(math.MaxInt64, r)
	if XPForLevel(l, r) > math.MaxInt64 || l < 2 {
		t.Fatalf("LevelForXP(MaxInt64) = %d", l)
	}
	if XPForLevel(math.MaxInt64, r) != math.MaxInt64 {
		t.Error("XPForLevel must saturate")
	}
}

func TestClampTunable(t *testing.T) {
	rng := TunableRange{Min: -20, Max: 60, Default: 7}
	cases := []struct {
		v    float64
		want int
	}{
		{math.NaN(), 7}, {math.Inf(1), 7}, {math.Inf(-1), 7},
		{2.5, 3}, {-2.5, -2}, {0.49999999999999994, 0}, {-0.4, 0},
		{59.5, 60}, {1e300, 60}, {-1e300, -20}, {-20.5, -20}, {33, 33},
	}
	for _, c := range cases {
		if got := ClampTunable(c.v, rng); got != c.want {
			t.Errorf("ClampTunable(%v) = %d, want %d", c.v, got, c.want)
		}
	}
	// Inverted range: like Math.min(max, Math.max(min, v)), max wins.
	if got := ClampTunable(3, TunableRange{Min: 10, Max: 5}); got != 5 {
		t.Errorf("inverted range = %d, want 5", got)
	}
}

func TestPomodoroAndOffers(t *testing.T) {
	want := map[string]int64{"25-5": 115, "50-10": 110}
	presets := 0
	for _, p := range embedded.Rules().PomodoroPresets {
		presets++
		got := PomodoroPlannedMinutes(int64(p.WorkMinutes), int64(p.BreakMinutes), int64(p.Cycles))
		if w, ok := want[p.ID]; ok && got != w {
			t.Errorf("preset %s planned = %d, want %d", p.ID, got, w)
		}
	}
	if presets == 0 {
		t.Error("no embedded presets")
	}
	if got := PomodoroPlannedMinutes(25, 5, 0); got != 25 {
		t.Errorf("zero cycles = %d, want one cycle (25)", got)
	}
	offers := DefaultRewardOffers()
	if len(offers) == 0 {
		t.Fatal("no embedded offers")
	}
	o, ok := FindRewardOffer(offers[0].ID, offers)
	if !ok || o != offers[0] {
		t.Errorf("FindRewardOffer(%q) = %+v, %v", offers[0].ID, o, ok)
	}
	if _, ok := FindRewardOffer("nope", offers); ok {
		t.Error("unknown offer found")
	}
}

func TestDayNumber(t *testing.T) {
	valid := map[string]int64{
		"1970-01-01": 0, "1969-12-31": -1, "2026-09-27": 20723, "0100-01-01": -683003,
		"9999-12-31": 2932896, "2028-02-29": 21243, "2000-02-29": 11016,
	}
	for d, want := range valid {
		if got, ok := DayNumber(d); !ok || got != want {
			t.Errorf("DayNumber(%q) = %d,%v, want %d", d, got, ok, want)
		}
		if !IsLocalDay(d) {
			t.Errorf("IsLocalDay(%q) = false", d)
		}
	}
	for _, d := range []string{
		"0099-12-31", "0000-01-01", "2026-02-29", "1900-02-29", "2026-13-01", "2026-00-10",
		"2026-01-00", "2026-04-31", "2026-1-01", " 2026-01-01", "2026-01-01\n", "2026/01/01",
		"２０２６-01-01", "", "bogus",
	} {
		if _, ok := DayNumber(d); ok || IsLocalDay(d) {
			t.Errorf("DayNumber(%q) must be invalid", d)
		}
	}
}

func TestAddDays(t *testing.T) {
	cases := []struct {
		day  string
		n    int64
		want string
	}{
		{"2026-09-27", 3_000_000, "+010240-06"},
		{"2026-09-27", -800_000, "-000164-05"},
		{"9999-12-31", 1, "+010000-01"},
		{"0100-01-01", -1, "0099-12-31"},
		{"0100-01-01", -36525, "0000-01-01"},
		{"1970-01-01", 100_000_000, "+275760-09"},
		{"1970-01-01", -100_000_000, "-271821-04"},
	}
	for _, c := range cases {
		if got, err := AddDays(c.day, c.n); err != nil || got != c.want {
			t.Errorf("AddDays(%q, %d) = %q, %v; want %q", c.day, c.n, got, err, c.want)
		}
	}
	for _, c := range []struct {
		day string
		n   int64
	}{{"1970-01-01", 100_000_001}, {"1970-01-01", -100_000_001}, {"bogus", 1}, {"2026-01-01", math.MaxInt64}, {"2026-01-01", math.MinInt64}} {
		if _, err := AddDays(c.day, c.n); err == nil {
			t.Errorf("AddDays(%q, %d) must fail", c.day, c.n)
		}
	}
}

func TestParseWireTime(t *testing.T) {
	valid := map[string]int64{
		"2026-09-27T10:00:00.000Z": 1790503200000,
		"1970-01-01T00:00:00.000Z": 0,
		"1969-12-31T23:59:59.999Z": -1,
		"2026-02-30T00:00:00.000Z": 1772409600000, // V8 rolls the day over
		"2026-01-01T24:00:00.000Z": 1767312000000, // 24:00 is the next midnight
		"0000-01-01T00:00:00.000Z": -62167219200000,
		"0099-01-01T00:00:00.000Z": -59042995200000,
	}
	for s, want := range valid {
		if got, ok := ParseWireTime(s); !ok || got != want {
			t.Errorf("ParseWireTime(%q) = %d,%v, want %d", s, got, ok, want)
		}
	}
	for _, s := range []string{
		"2026-02-32T00:00:00.000Z", "2026-13-01T00:00:00.000Z", "2026-00-01T00:00:00.000Z",
		"2026-01-00T00:00:00.000Z", "2026-01-01T24:00:00.001Z", "2026-01-01T24:01:00.000Z",
		"2026-01-01T23:60:00.000Z", "2026-01-01T23:59:60.000Z", "2026-01-01T00:00:00Z",
		"2026-01-01T00:00:00.000+01:00", "2026-01-01T00:00:00.0000Z", "2026-01-01 00:00:00.000Z",
		"",
	} {
		if _, ok := ParseWireTime(s); ok {
			t.Errorf("ParseWireTime(%q) must fail", s)
		}
	}
}
