package points

import (
	"math"
	"math/bits"
	"slices"
	"unicode/utf8"
)

// maxEscalationSteps bounds the escalation search like the TypeScript loop (index < 30),
// so degenerate rules (multiplier ≤ 1) cannot loop forever.
const maxEscalationSteps = 30

// maxPhraseUTF16 is the longest typed phrase emergencyPhraseMatches accepts (400 UTF-16
// code units in points.ts). It is an input bound, not a points rule, so it is not in
// rules.json.
const maxPhraseUTF16 = 400

// MaxEscalationIndex is the smallest escalation index whose penalty reaches the cap (3
// with 10/2/80).
func MaxEscalationIndex(r PointRules) int64 {
	var index int64
	penalty := int64(r.AttemptBasePenalty)
	for penalty < int64(r.AttemptPenaltyCap) && index < maxEscalationSteps {
		penalty *= int64(r.AttemptPenaltyMultiplier)
		index++
	}
	return index
}

// AttemptPenalty is the (positive) penalty of an attempt with this escalation index: 10,
// 20, 40, 80, 80…
func AttemptPenalty(escalationIndex int64, r PointRules) int64 {
	index := max(0, min(escalationIndex, MaxEscalationIndex(r)))
	penalty := int64(r.AttemptBasePenalty)
	for i := int64(0); i < index; i++ {
		penalty *= int64(r.AttemptPenaltyMultiplier)
	}
	return min(penalty, int64(r.AttemptPenaltyCap))
}

// NextEscalationIndex is the escalation index of a counted attempt at atMs after
// previous. Trusted time can step back: an attempt earlier than the previous counted one
// starts over at 0.
func NextEscalationIndex(previous Escalation, atMs int64, r PointRules) int64 {
	if previous.LastCountedAtMs == nil {
		return 0
	}
	elapsed := atMs - *previous.LastCountedAtMs
	if elapsed < 0 || elapsed >= int64(r.AttemptEscalationWindowMs) {
		return 0
	}
	return min(previous.Index+1, MaxEscalationIndex(r))
}

// EmergencyPenalty is the (positive) emergency penalty:
// max(emergencyMinPenalty, floor(max(0, base) / emergencyBalanceDivisor)). The guardian
// passes balance + AllowanceValue(active allowances) as base.
func EmergencyPenalty(base int64, r PointRules) int64 {
	var half int64
	if r.EmergencyBalanceDivisor > 0 {
		half = max(0, base) / int64(r.EmergencyBalanceDivisor)
	}
	return max(int64(r.EmergencyMinPenalty), half)
}

// IsEmergencyEligibleMode reports whether an emergency unlock may target a block in this
// mode (normal or strict).
func IsEmergencyEligibleMode(mode string) bool {
	return mode == "normal" || mode == "strict"
}

// EmergencyCountdownMinutes is the countdown of an emergency unlock covering blocks in
// these modes: the strict countdown if any is strict, else the normal one. ok is false
// (TypeScript null) when the list is empty or contains a hardcore or exam block.
func EmergencyCountdownMinutes(modes []string, r EmergencyRules) (minutes int64, ok bool) {
	if len(modes) == 0 {
		return 0, false
	}
	for _, m := range modes {
		if !IsEmergencyEligibleMode(m) {
			return 0, false
		}
	}
	if slices.Contains(modes, "strict") {
		return int64(r.CountdownMinutes.Strict), true
	}
	return int64(r.CountdownMinutes.Normal), true
}

// isPhraseSpace is the whitespace normalizePhrase collapses: ASCII space, \t, \n, \r, \f,
// \v and U+00A0.
func isPhraseSpace(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\r', '\f', '\v', '\u00a0':
		return true
	}
	return false
}

// NormalizePhrase normalizes a typed commitment phrase for comparison exactly like
// normalizePhrase in points.ts: runs of ASCII whitespace and U+00A0 become one space, one
// space is trimmed at each end, only ASCII letters are lowercased and one trailing «.»
// (and a space before it) is dropped. Bytes that are not valid UTF-8 are kept as they
// are.
func NormalizePhrase(text string) string {
	out := make([]byte, 0, len(text))
	inSpace := false
	for i := 0; i < len(text); {
		r, size := utf8.DecodeRuneInString(text[i:])
		if isPhraseSpace(r) {
			if !inSpace {
				out = append(out, ' ')
				inSpace = true
			}
			i += size
			continue
		}
		inSpace = false
		for j := i; j < i+size; j++ {
			c := text[j]
			if c >= 'A' && c <= 'Z' {
				c += 'a' - 'A'
			}
			out = append(out, c)
		}
		i += size
	}
	s := string(out)
	if len(s) > 0 && s[0] == ' ' {
		s = s[1:]
	}
	if len(s) > 0 && s[len(s)-1] == ' ' {
		s = s[:len(s)-1]
	}
	if len(s) > 0 && s[len(s)-1] == '.' {
		s = s[:len(s)-1]
		if len(s) > 0 && s[len(s)-1] == ' ' {
			s = s[:len(s)-1]
		}
	}
	return s
}

// utf16Len is the length of s in UTF-16 code units (JavaScript's String length). Invalid
// UTF-8 bytes count one unit each, as the U+FFFD a JSON decoder replaces them with.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// EmergencyPhraseMatches reports whether typed matches any language's emergency phrase.
func EmergencyPhraseMatches(typed string, r EmergencyRules) bool {
	if utf16Len(typed) > maxPhraseUTF16 {
		return false
	}
	normalized := NormalizePhrase(typed)
	for _, phrase := range []string{r.Phrases.ES, r.Phrases.EN} {
		if NormalizePhrase(phrase) == normalized {
			return true
		}
	}
	return false
}

// IsEarningBlockKind reports whether blocks of this kind earn points (manual and schedule
// with the current rules).
func IsEarningBlockKind(kind string, r PointRules) bool {
	return slices.Contains(r.EarningBlockKinds, kind)
}

// BlockPoints is the result of BlockCompletionPoints.
type BlockPoints struct {
	MinutePoints int64 `json:"minutePoints"`
	CleanBonus   int64 `json:"cleanBonus"`
	Total        int64 `json:"total"`
}

// BlockCompletionPoints is the points of a completed block: credited minutes × the
// per-minute value plus the clean bonus when eligible (no counted attempt and at least
// cleanSessionMinMinutes credited). Non-earning kinds and blocks without credit get 0.
func BlockCompletionPoints(kind string, creditedMinutes, attemptsCounted int64, r PointRules) BlockPoints {
	if !IsEarningBlockKind(kind, r) || creditedMinutes <= 0 {
		return BlockPoints{}
	}
	minutePoints := creditedMinutes * int64(r.BlockPointsPerMinute)
	var cleanBonus int64
	if attemptsCounted == 0 && creditedMinutes >= int64(r.CleanSessionMinMinutes) {
		cleanBonus = int64(r.CleanSessionBonus)
	}
	return BlockPoints{MinutePoints: minutePoints, CleanBonus: cleanBonus, Total: minutePoints + cleanBonus}
}

// StudyEndBonus is the clean bonus of a study session: completed, no strikes, no attempts
// and at least cleanSessionMinMinutes planned.
func StudyEndBonus(outcome string, strikes, attempts, plannedMinutes int64, r PointRules) int64 {
	if outcome == "completed" && strikes == 0 && attempts == 0 && plannedMinutes >= int64(r.CleanSessionMinMinutes) {
		return int64(r.CleanSessionBonus)
	}
	return 0
}

// mulDiv is floor(a × b / c) for a, b ≥ 0 and c > 0 with a 128-bit intermediate, so it
// never overflows while the quotient fits (it is ≤ a whenever b ≤ c).
func mulDiv(a, b, c int64) int64 {
	hi, lo := bits.Mul64(uint64(a), uint64(b))
	if hi >= uint64(c) {
		return math.MaxInt64
	}
	q, _ := bits.Div64(hi, lo, uint64(c))
	if q > math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(q)
}

// AllowanceRefund is the (positive) refund of a revoked allowance:
// floor(cost × remaining / total) with remainingMs clamped to [0, totalMs]; 0 when
// totalMs ≤ 0 or cost ≤ 0.
func AllowanceRefund(cost, totalMs, remainingMs int64) int64 {
	if totalMs <= 0 || cost <= 0 {
		return 0
	}
	remaining := max(0, min(remainingMs, totalMs))
	return mulDiv(cost, remaining, totalMs)
}

// AllowanceWorth is what an active allowance is worth right now (the refund inputs).
type AllowanceWorth struct {
	Cost        int64 `json:"cost"`
	TotalMs     int64 `json:"totalMs"`
	RemainingMs int64 `json:"remainingMs"`
}

// AllowanceValue is the points parked in active allowances: the sum of AllowanceRefund of
// each (what revoking them now would give back). It is added to the balance before an
// emergency (or equivalent tamper) penalty.
func AllowanceValue(allowances []AllowanceWorth) int64 {
	var total int64
	for _, a := range allowances {
		total += AllowanceRefund(a.Cost, a.TotalMs, a.RemainingMs)
	}
	return total
}

// XPForLevel is the XP needed to reach level (level 1 starts at 0):
// levelXpStep × L × (L − 1), saturating at math.MaxInt64.
func XPForLevel(level int64, r PointRules) int64 {
	if level <= 1 {
		return 0
	}
	if r.LevelXPStep <= 0 {
		return 0
	}
	hi, lo := bits.Mul64(uint64(level), uint64(level-1))
	if hi != 0 || lo > math.MaxInt64 {
		return math.MaxInt64
	}
	hi, lo = bits.Mul64(lo, uint64(r.LevelXPStep))
	if hi != 0 || lo > math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(lo)
}

// LevelForXP is the level (≥ 1) for this much XP.
func LevelForXP(xp int64, r PointRules) int64 {
	if xp <= 0 || r.LevelXPStep <= 0 {
		return 1
	}
	estimate := math.Floor((1 + math.Sqrt(1+(4*float64(xp))/float64(r.LevelXPStep))) / 2)
	level := int64(1)
	if estimate > 1 && estimate < 1<<53 {
		level = int64(estimate)
	}
	for XPForLevel(level+1, r) <= xp && XPForLevel(level+1, r) < math.MaxInt64 {
		level++
	}
	for level > 1 && XPForLevel(level, r) > xp {
		level--
	}
	return level
}

// jsRound is JavaScript's Math.round: halves round towards +∞.
func jsRound(x float64) float64 {
	f := math.Floor(x)
	if x-f >= 0.5 {
		return f + 1
	}
	return f
}

// ClampTunable clamps a user-picked value to a tunable range (rounded like Math.round);
// NaN and ±Inf give the default.
func ClampTunable(value float64, r TunableRange) int {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return r.Default
	}
	v := max(float64(r.Min), jsRound(value))
	if v >= float64(r.Max) {
		return r.Max
	}
	if v == float64(r.Min) {
		return r.Min
	}
	return int(v)
}

// PomodoroPlannedMinutes is the plannedMinutes of a Pomodoro session:
// cycles × (work + break) − break, with at least one cycle.
func PomodoroPlannedMinutes(workMinutes, breakMinutes, cycles int64) int64 {
	cycles = max(1, cycles)
	return cycles*(workMinutes+breakMinutes) - breakMinutes
}

// FindRewardOffer is the offer with this id, if any.
func FindRewardOffer(id string, offers []RewardOffer) (RewardOffer, bool) {
	for _, o := range offers {
		if o.ID == id {
			return o, true
		}
	}
	return RewardOffer{}, false
}
