package points

import "slices"

// Block crediting helpers (ARCHITECTURE §10.9). The engine owns the tick and the block
// state; these are the pure pieces of the rule.

const msPerMinute = 60_000

// BlockCreditedMinutes is the creditedMinutes of a completed block:
// min(round half up(creditedMs / 1 min), ceil((endsAt − startsAt) / 1 min)), never
// below 0. So an awake 60-minute block credits exactly 60 whatever the tick phase, and no
// block credits more minutes than it lasted.
func BlockCreditedMinutes(creditedMs, startsAtMs, endsAtMs int64) int64 {
	if creditedMs <= 0 || endsAtMs <= startsAtMs {
		return 0
	}
	rounded := creditedMs/msPerMinute + boolInt(creditedMs%msPerMinute >= msPerMinute/2)
	span := endsAtMs - startsAtMs
	ceil := span/msPerMinute + boolInt(span%msPerMinute != 0)
	return min(rounded, ceil)
}

func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

// CreditCandidate is an active block that may earn credit during one tick. Only pass
// blocks that can earn: an earning kind (IsEarningBlockKind) and no active allowance on a
// service the block targets.
type CreditCandidate struct {
	StartsAtMs int64
	EndsAtMs   int64
	// Rank breaks ties between blocks ending at the same instant: the lowest rank wins
	// (use the creation order, so the earliest created block wins); then the lowest index.
	Rank int64
}

// SplitTickCredit splits one tick among the candidates (§10.9). The tick covers
// [prevMs, nowMs] of trusted time; awakeMs is the awake time the tick measured (the caller
// clamps it). Its awake share f = min(1, awakeMs / (nowMs − prevMs)) of every instant of
// the tick inside a candidate's [StartsAtMs, EndsAtMs] goes to exactly one candidate: the
// earliest-ending one active at that instant (ties: lowest Rank). So overlapping blocks
// never earn the same minute twice, a block ending mid-tick is credited up to its end
// and one starting mid-tick gets nothing before its start. It returns the credited
// milliseconds of each candidate (same order; each rounded down).
func SplitTickCredit(prevMs, nowMs, awakeMs int64, cands []CreditCandidate) []int64 {
	credit := make([]int64, len(cands))
	interval := nowMs - prevMs
	if interval <= 0 || awakeMs <= 0 || len(cands) == 0 {
		return credit
	}
	awake := min(awakeMs, interval)

	cuts := []int64{prevMs, nowMs}
	for _, c := range cands {
		for _, t := range []int64{c.StartsAtMs, c.EndsAtMs} {
			if t > prevMs && t < nowMs {
				cuts = append(cuts, t)
			}
		}
	}
	slices.Sort(cuts)
	cuts = slices.Compact(cuts)

	raw := make([]int64, len(cands))
	for i := 0; i+1 < len(cuts); i++ {
		a, b := cuts[i], cuts[i+1]
		best := -1
		for j, c := range cands {
			if c.StartsAtMs > a || c.EndsAtMs < b {
				continue
			}
			if best < 0 || c.EndsAtMs < cands[best].EndsAtMs ||
				(c.EndsAtMs == cands[best].EndsAtMs && c.Rank < cands[best].Rank) {
				best = j
			}
		}
		if best >= 0 {
			raw[best] += b - a
		}
	}
	for i, ms := range raw {
		if ms > 0 {
			credit[i] = mulDiv(ms, awake, interval)
		}
	}
	return credit
}
