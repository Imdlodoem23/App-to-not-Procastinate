package engine

// Pure daily-limit rules (docs/ARCHITECTURE.md §5.10, §10.13): the Go port of
// limitModeRank, limitDefinitionWeakens, splitLimitChange, pendingLimitDelayKept,
// clampUsageInterval and limitUsageCredit of packages/shared/src/guardian-api.ts. They
// run packages/shared/test/fixtures/limits-vectors.json in place (limits_vectors_test.go);
// never change one side without the other.

import (
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
// boot-clock time since that client's previous accepted report plus slackMs (sinceLastMs
// nil: its first report since the guardian started).
func clampUsageInterval(intervalMs int64, sinceLastMs *int64, slackMs int64) int64 {
	bound := intervalMs
	if sinceLastMs != nil {
		bound = max(0, *sinceLastMs) + slackMs
	}
	return max(0, min(intervalMs, bound))
}

// limitUsageCredit is the milliseconds one report adds to one limit (§10.13), all in
// trusted Unix ms: the part of [nowMs − intervalMs, nowMs] after the start of the local
// day and after the limit's watermark creditedUntilMs (minus slackMs), capped by what the
// report's matching items add up to. The watermark moves to nowMs when something was
// credited.
func limitUsageCredit(nowMs, dayStartMs, intervalMs, reportedMs, creditedUntilMs, slackMs int64) (creditMs, newCreditedUntilMs int64) {
	windowStart := max(nowMs-intervalMs, dayStartMs)
	from := max(windowStart, creditedUntilMs-slackMs)
	free := max(0, nowMs-from)
	creditMs = max(0, min(reportedMs, free, intervalMs))
	newCreditedUntilMs = creditedUntilMs
	if creditMs > 0 {
		newCreditedUntilMs = max(creditedUntilMs, nowMs)
	}
	return creditMs, newCreditedUntilMs
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
