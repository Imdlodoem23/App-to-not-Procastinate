package points

import (
	"slices"
	"testing"
)

const minute = int64(60_000)

func TestBlockCreditedMinutes(t *testing.T) {
	start := t0
	end60 := start + 60*minute
	cases := []struct {
		credited, starts, ends int64
		want                   int64
	}{
		{60 * minute, start, end60, 60},
		{60*minute - 1, start, end60, 60},
		{59*minute + minute/2, start, end60, 60}, // half up
		{59*minute + minute/2 - 1, start, end60, 59},
		{61 * minute, start, end60, 60},                    // never more than the block lasted
		{61 * minute, start, start + 60*minute + 1, 61},    // a partial last minute counts
		{25*minute - 20_000, start, start + 25*minute, 25}, // keeps the clean-bonus minimum
		{0, start, end60, 0},
		{-5, start, end60, 0},
		{10 * minute, end60, start, 0},
	}
	for _, c := range cases {
		if got := BlockCreditedMinutes(c.credited, c.starts, c.ends); got != c.want {
			t.Errorf("BlockCreditedMinutes(%d, span %d) = %d, want %d", c.credited, c.ends-c.starts, got, c.want)
		}
	}
}

func TestSplitTickCreditBasics(t *testing.T) {
	a := CreditCandidate{StartsAtMs: 0, EndsAtMs: 10_000, Rank: 1}
	b := CreditCandidate{StartsAtMs: 0, EndsAtMs: 20_000, Rank: 2}
	c := CreditCandidate{StartsAtMs: 5_000, EndsAtMs: 10_000, Rank: 3}
	cases := []struct {
		name            string
		prev, now, wake int64
		cands           []CreditCandidate
		want            []int64
	}{
		{"one block, awake", 1_000, 2_000, 1_000, []CreditCandidate{b}, []int64{1_000}},
		{"awake share caps at 1", 1_000, 2_000, 5_000, []CreditCandidate{b}, []int64{1_000}},
		{"half awake", 1_000, 3_000, 1_000, []CreditCandidate{b}, []int64{1_000}},
		{"asleep", 1_000, 3_000, 0, []CreditCandidate{b}, []int64{0}},
		{"earliest ending wins", 1_000, 2_000, 1_000, []CreditCandidate{b, a}, []int64{0, 1_000}},
		{"ends mid-tick, the next block takes over", 9_500, 10_500, 1_000, []CreditCandidate{a, b}, []int64{500, 500}},
		{"starts mid-tick", 4_000, 6_000, 2_000, []CreditCandidate{c}, []int64{1_000}},
		{"tie on end: lowest rank", 6_000, 7_000, 1_000, []CreditCandidate{c, a}, []int64{0, 1_000}},
		{"tie on end and rank: lowest index", 6_000, 7_000, 1_000,
			[]CreditCandidate{{StartsAtMs: 0, EndsAtMs: 10_000}, {StartsAtMs: 0, EndsAtMs: 10_000}}, []int64{1_000, 0}},
		{"before any block", -2_000, -1_000, 1_000, []CreditCandidate{a}, []int64{0}},
		{"backwards tick", 2_000, 1_000, 1_000, []CreditCandidate{a}, []int64{0}},
		{"no candidates", 0, 1_000, 1_000, nil, []int64{}},
	}
	for _, tc := range cases {
		got := SplitTickCredit(tc.prev, tc.now, tc.wake, tc.cands)
		if !slices.Equal(got, tc.want) {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

// An awake 60-minute block credits exactly 60 minutes whatever the tick phase and length
// (ARCHITECTURE §10.9 and §15), and an overlapping longer block only gets the rest.
func TestSplitTickCreditPhaseSweep(t *testing.T) {
	const blockMs = 60 * minute
	for _, tick := range []int64{1_000, 1_500, 2_000, 7_000} {
		for phase := int64(0); phase < 2_000; phase += 37 {
			start := t0 + 250
			short := CreditCandidate{StartsAtMs: start, EndsAtMs: start + blockMs, Rank: 1}
			long := CreditCandidate{StartsAtMs: start, EndsAtMs: start + 2*blockMs, Rank: 2}
			var credit [2]int64
			for prev := start - 10_000 + phase; prev < start+2*blockMs+10_000; prev += tick {
				got := SplitTickCredit(prev, prev+tick, tick, []CreditCandidate{short, long})
				if got[0]+got[1] > tick {
					t.Fatalf("tick credited %v > %d", got, tick)
				}
				credit[0] += got[0]
				credit[1] += got[1]
			}
			if m := BlockCreditedMinutes(credit[0], short.StartsAtMs, short.EndsAtMs); m != 60 || credit[0] != blockMs {
				t.Fatalf("tick %d phase %d: short block credited %d ms (%d min)", tick, phase, credit[0], m)
			}
			if credit[1] != blockMs {
				t.Fatalf("tick %d phase %d: long block credited %d ms, want only its exclusive hour", tick, phase, credit[1])
			}
		}
	}
}
