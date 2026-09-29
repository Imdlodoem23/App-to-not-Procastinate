package engine

// Pure daily-limit rules (docs/ARCHITECTURE.md §5.10, §10.13): the Go port of
// limitModeRank, limitDefinitionWeakens, splitLimitChange, pendingLimitDelayKept,
// clampUsageInterval and limitUsageCredit of packages/shared/src/guardian-api.ts. They
// run packages/shared/test/fixtures/limits-vectors.json in place (limits_vectors_test.go);
// never change one side without the other.

import (
	"cmp"
	"slices"
)

// Limit modes (LIMIT_MODES in domain.ts), in rank order: normal < strict < hardcore.
var limitModes = []string{ModeNormal, ModeStrict, ModeHardcore}

// DailyLimitDefinition mirrors DailyLimitDefinition: what the user defines for a daily
// limit. Days are ISO weekdays.
type DailyLimitDefinition struct {
	Name         string     `json:"name"`
	Enabled      bool       `json:"enabled"`
	Targets      TargetSpec `json:"targets"`
	DailyMinutes int64      `json:"dailyMinutes"`
	Days         []int      `json:"days"`
	Mode         string     `json:"mode"`
	Reason       string     `json:"reason"`
}

// normalized is a deep copy whose lists are never nil and whose days are sorted and
// unique.
func (d DailyLimitDefinition) normalized() DailyLimitDefinition {
	out := d
	out.Targets = d.Targets.normalized()
	out.Days = sortedDays(d.Days)
	return out
}

// limitModeRank is limitModeRank: normal 0 < strict 1 < hardcore 2 (−1 for anything
// else).
func limitModeRank(mode string) int { return slices.Index(limitModes, mode) }

// targetLists are the five lists of a TargetSpec in TARGET_LISTS order.
func targetLists(t TargetSpec) [5][]string {
	return [5][]string{t.ServiceIDs, t.CategoryIDs, t.AppIDs, t.CustomDomains, t.CustomProcesses}
}

// unionList is first followed by the entries of second it lacks, in order.
func unionList(first, second []string) []string {
	out := cloneList(first)
	for _, v := range second {
		if !slices.Contains(out, v) {
			out = append(out, v)
		}
	}
	return out
}

// sortedDays is the sorted, unique copy of days (never nil).
func sortedDays(days []int) []int {
	out := cloneList(days)
	slices.Sort(out)
	return slices.Compact(out)
}

// limitDefinitionWeakens reports whether next weakens prev: a higher dailyMinutes, a
// target entry or a day of prev missing from next, a lower mode rank, or enabled true →
// false. Name and reason are neutral.
func limitDefinitionWeakens(next, prev DailyLimitDefinition) bool {
	if next.DailyMinutes > prev.DailyMinutes {
		return true
	}
	if prev.Enabled && !next.Enabled {
		return true
	}
	if limitModeRank(next.Mode) < limitModeRank(prev.Mode) {
		return true
	}
	if !schSubset(prev.Days, next.Days) {
		return true
	}
	pl, nl := targetLists(prev.Targets), targetLists(next.Targets)
	for i := range pl {
		if !schSubset(pl[i], nl[i]) {
			return true
		}
	}
	return false
}

// splitLimitChange is how a PUT /v1/limits/{id} splits (§5.10): applied is effective at
// once (the requested name and reason, the lower dailyMinutes, the union of targets with
// the effective entries first and of days, sorted, the stricter mode, enabled if either
// is); pending is the requested definition (days sorted) when it still weakens applied,
// else nil.
func splitLimitChange(effective, requested DailyLimitDefinition) (DailyLimitDefinition, *DailyLimitDefinition) {
	et, rt := effective.Targets, requested.Targets
	mode := effective.Mode
	if limitModeRank(requested.Mode) > limitModeRank(effective.Mode) {
		mode = requested.Mode
	}
	applied := DailyLimitDefinition{
		Name:    requested.Name,
		Enabled: effective.Enabled || requested.Enabled,
		Targets: TargetSpec{
			ServiceIDs:      unionList(et.ServiceIDs, rt.ServiceIDs),
			CategoryIDs:     unionList(et.CategoryIDs, rt.CategoryIDs),
			AppIDs:          unionList(et.AppIDs, rt.AppIDs),
			CustomDomains:   unionList(et.CustomDomains, rt.CustomDomains),
			CustomProcesses: unionList(et.CustomProcesses, rt.CustomProcesses),
		},
		DailyMinutes: min(effective.DailyMinutes, requested.DailyMinutes),
		Days:         sortedDays(append(cloneList(effective.Days), requested.Days...)),
		Mode:         mode,
		Reason:       requested.Reason,
	}
	normalized := requested.normalized()
	if limitDefinitionWeakens(normalized, applied) {
		return applied, &normalized
	}
	return applied, nil
}

// pendingLimitDelayKept reports whether replacing the pending change prev by next keeps
// the delay already run (nil is a pending deletion, the weakest of all).
func pendingLimitDelayKept(prev, next *DailyLimitDefinition) bool {
	if next == nil {
		return prev == nil
	}
	if prev == nil {
		return true
	}
	return !limitDefinitionWeakens(*next, *prev)
}

// clampUsageInterval is the per-client clamp of a usage report (§10.13): at most the
// awake time (suspend excluded) since that client's previous accepted report plus
// slackMs (sinceLastMs nil: its first report since the guardian started).
func clampUsageInterval(intervalMs int64, sinceLastMs *int64, slackMs int64) int64 {
	bound := intervalMs
	if sinceLastMs != nil {
		bound = max(0, *sinceLastMs) + slackMs
	}
	return max(0, min(intervalMs, bound))
}

// creditSpan is a stretch [start, end) of trusted Unix ms already credited to a limit.
type creditSpan [2]int64

// usageMaxCreditSpans bounds the spans a limit keeps (usageMaxCreditSpans in
// guardian-api.ts); past it the two closest spans merge, which only ever credits less.
const usageMaxCreditSpans = 32

// limitUsageCredit is the milliseconds one report adds to one limit (§10.13), all in
// trusted Unix ms, and the limit's credited spans after it. The report covers [nowMs −
// intervalMs, nowMs] (the interval already clamped per client), cut at the start of the
// local day and at floorMs (nothing before it ever counts: the limit's creation, an epoch
// start) minus slackMs. Only the part of that window no earlier report credited is free;
// the credit is what the report's matching items add up to (reportedMs), at most the free
// time plus slackMs of jitter tolerance, and it is placed in the free gaps earliest first,
// so a second client can fill what the first did not use while each trusted millisecond
// counts at most once per limit. Credited time ahead of nowMs (trusted time moved back)
// blocks everything before its end. Spans no later report can reach (ending
// maxIntervalMs or more before nowMs) are dropped.
func limitUsageCredit(nowMs, dayStartMs, intervalMs, reportedMs, floorMs int64, credited []creditSpan, slackMs, maxIntervalMs int64) (creditMs int64, next []creditSpan) {
	spans := normalizeCreditSpans(credited)
	lo := max(nowMs-intervalMs, dayStartMs, floorMs-slackMs)
	if n := len(spans); n > 0 && spans[n-1][1] > nowMs {
		// Credited time ahead of now: trusted time moved back. Nothing counts until it is
		// reached again.
		lo = max(lo, spans[n-1][1])
	}
	if lo < nowMs && reportedMs > 0 {
		gaps := creditGaps(spans, lo, nowMs)
		var free int64
		for _, g := range gaps {
			free += g[1] - g[0]
		}
		creditMs = max(0, min(reportedMs, intervalMs, nowMs-lo, free+slackMs))
		place := min(creditMs, free)
		for _, g := range gaps {
			if place <= 0 {
				break
			}
			n := min(place, g[1]-g[0])
			spans = append(spans, creditSpan{g[0], g[0] + n})
			place -= n
		}
		spans = normalizeCreditSpans(spans)
	}
	spans = slices.DeleteFunc(spans, func(s creditSpan) bool { return s[1] <= nowMs-maxIntervalMs })
	for len(spans) > usageMaxCreditSpans {
		best := 0
		for i := 1; i+1 < len(spans); i++ {
			if spans[i+1][0]-spans[i][1] < spans[best+1][0]-spans[best][1] {
				best = i
			}
		}
		spans[best][1] = spans[best+1][1]
		spans = slices.Delete(spans, best+1, best+2)
	}
	if len(spans) == 0 {
		spans = nil
	}
	return creditMs, spans
}

// normalizeCreditSpans sorts a copy of the spans and merges the ones that touch or
// overlap (empty spans are dropped).
func normalizeCreditSpans(in []creditSpan) []creditSpan {
	s := slices.DeleteFunc(slices.Clone(in), func(c creditSpan) bool { return c[1] <= c[0] })
	slices.SortFunc(s, func(a, b creditSpan) int {
		if a[0] != b[0] {
			return cmp.Compare(a[0], b[0])
		}
		return cmp.Compare(a[1], b[1])
	})
	out := s[:0]
	for _, c := range s {
		if n := len(out); n > 0 && c[0] <= out[n-1][1] {
			out[n-1][1] = max(out[n-1][1], c[1])
			continue
		}
		out = append(out, c)
	}
	return out
}

// creditGaps are the parts of [lo, hi) outside the normalized spans, in order.
func creditGaps(spans []creditSpan, lo, hi int64) []creditSpan {
	var gaps []creditSpan
	cur := lo
	for _, s := range spans {
		if s[1] <= cur {
			continue
		}
		if s[0] >= hi {
			break
		}
		if s[0] > cur {
			gaps = append(gaps, creditSpan{cur, s[0]})
		}
		cur = max(cur, s[1])
		if cur >= hi {
			break
		}
	}
	if cur < hi {
		gaps = append(gaps, creditSpan{cur, hi})
	}
	return gaps
}

// limitDefEqual reports whether two definitions are identical (days compared sorted).
func limitDefEqual(a, b DailyLimitDefinition) bool {
	if a.Name != b.Name || a.Enabled != b.Enabled || a.DailyMinutes != b.DailyMinutes || a.Mode != b.Mode || a.Reason != b.Reason {
		return false
	}
	if !slices.Equal(sortedDays(a.Days), sortedDays(b.Days)) {
		return false
	}
	return targetsEqual(a.Targets, b.Targets)
}

// targetsEqual compares two target specs list by list (order matters).
func targetsEqual(a, b TargetSpec) bool {
	al, bl := targetLists(a), targetLists(b)
	for i := range al {
		if !slices.Equal(al[i], bl[i]) {
			return false
		}
	}
	return true
}

// targetsCover reports whether every entry of t is in covered.
func targetsCover(covered, t TargetSpec) bool {
	cl, tl := targetLists(covered), targetLists(t)
	for i := range cl {
		if !schSubset(tl[i], cl[i]) {
			return false
		}
	}
	return true
}

// targetsUnion is the union of two target specs (a's entries first).
func targetsUnion(a, b TargetSpec) TargetSpec {
	return TargetSpec{
		ServiceIDs:      unionList(a.ServiceIDs, b.ServiceIDs),
		CategoryIDs:     unionList(a.CategoryIDs, b.CategoryIDs),
		AppIDs:          unionList(a.AppIDs, b.AppIDs),
		CustomDomains:   unionList(a.CustomDomains, b.CustomDomains),
		CustomProcesses: unionList(a.CustomProcesses, b.CustomProcesses),
	}
}
