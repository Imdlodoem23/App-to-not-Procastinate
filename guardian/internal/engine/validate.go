package engine

import (
	"fmt"
	"regexp"
	"slices"

	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
)

// Request validation that the engine repeats after the API layer's strict decoding
// (defence in depth; the same paths and issues as the TypeScript validators, §8.1).

var catalogIDRE = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

// validateTargetsShape checks a TargetSpec and a WhitelistAllow like targetSpecIn and
// allowIn: list caps, uniqueness, catalog id and category formats, canonical domains
// and valid, unprotected process names (paths "targets.…" and "allow.…").
func (e *Engine) validateTargetsShape(t TargetSpec, allow WhitelistAllow) *APIError {
	l := limits()
	ids := func(path string, list []string, max int, check func(string) bool) *APIError {
		if len(list) > max {
			return issueErr(path, "length", fmt.Sprintf("between 0 and %d items", max))
		}
		for i, v := range list {
			p := fmt.Sprintf("%s[%d]", path, i)
			if !check(v) {
				return issueErr(p, "pattern", "invalid value")
			}
			if slices.Index(list, v) != i {
				return issueErr(p, "duplicate", "duplicate")
			}
		}
		return nil
	}
	catID := func(v string) bool { return len(v) >= 1 && len(v) <= 64 && catalogIDRE.MatchString(v) }
	if err := ids("targets.serviceIds", t.ServiceIDs, l.MaxIDsPerList, catID); err != nil {
		return err
	}
	cats := e.cat.CategoryIDs()
	if len(t.CategoryIDs) > len(cats) {
		return issueErr("targets.categoryIds", "length", "too many items")
	}
	for i, c := range t.CategoryIDs {
		p := fmt.Sprintf("targets.categoryIds[%d]", i)
		if !slices.Contains(cats, c) {
			return issueErr(p, "enum", "unknown category")
		}
		if slices.Index(t.CategoryIDs, c) != i {
			return issueErr(p, "duplicate", "duplicate")
		}
	}
	if err := ids("targets.appIds", t.AppIDs, l.MaxIDsPerList, catID); err != nil {
		return err
	}
	for _, list := range []struct {
		path string
		v    []string
	}{{"targets.customDomains", t.CustomDomains}, {"allow.customDomains", allow.CustomDomains}} {
		if err := e.checkDomains(list.path, list.v, l.MaxCustomDomains); err != nil {
			return err
		}
	}
	for _, list := range []struct {
		path string
		v    []string
	}{{"targets.customProcesses", t.CustomProcesses}, {"allow.customProcesses", allow.CustomProcesses}} {
		if err := e.checkProcesses(list.path, list.v, l.MaxCustomProcesses); err != nil {
			return err
		}
	}
	return nil
}

// checkDomains validates a list of canonical domains (issue invalid_domain).
func (e *Engine) checkDomains(path string, list []string, max int) *APIError {
	if len(list) > max {
		return issueErr(path, "length", fmt.Sprintf("between 0 and %d items", max))
	}
	for i, d := range list {
		p := fmt.Sprintf("%s[%d]", path, i)
		if !catalog.IsValidDomain(d) {
			return issueErr(p, "invalid_domain", "canonical domain")
		}
		if slices.Index(list, d) != i {
			return issueErr(p, "duplicate", "duplicate")
		}
	}
	return nil
}

// checkProcesses validates a list of process names (invalid_process, protected_process).
func (e *Engine) checkProcesses(path string, list []string, max int) *APIError {
	if len(list) > max {
		return issueErr(path, "length", fmt.Sprintf("between 0 and %d items", max))
	}
	for i, n := range list {
		p := fmt.Sprintf("%s[%d]", path, i)
		if !catalog.IsValidProcessName(n) {
			return issueErr(p, "invalid_process", "executable base name")
		}
		if e.cat.IsProtectedProcessName(n) {
			return issueErr(p, "protected_process", "protected process")
		}
		if slices.Index(list, n) != i {
			return issueErr(p, "duplicate", "duplicate")
		}
	}
	return nil
}

// targetRules are the shared rules of blocks and schedules (targetRules in
// guardian-api.ts): exam is whitelist-only; whitelist-only takes no targets; otherwise
// at least one target and an empty allow.
func targetRules(t TargetSpec, whitelistOnly bool, allow WhitelistAllow, mode string) *APIError {
	if mode == ModeExam && !whitelistOnly {
		return issueErr("whitelistOnly", "rule", "exam mode is whitelist-only")
	}
	if whitelistOnly {
		if t.count() > 0 {
			return issueErr("targets", "rule", "whitelist-only blocks take no targets")
		}
		return nil
	}
	if t.count() == 0 {
		return issueErr("targets", "rule", "at least one target")
	}
	if allow.count() > 0 {
		return issueErr("allow", "rule", "allow needs whitelistOnly")
	}
	return nil
}

// validateSemanticTargets runs the semantic checks shared by blocks and schedules, in
// the order of §8.8: unknown ids, protected custom domains, distractions in allow.
func (e *Engine) validateSemanticTargets(t TargetSpec, allow WhitelistAllow) *APIError {
	for i, id := range t.ServiceIDs {
		if e.cat.Service(id) == nil {
			return apiErr("unknown_id", "unknown service id", map[string]any{"path": fmt.Sprintf("targets.serviceIds[%d]", i), "id": id})
		}
	}
	for i, id := range t.AppIDs {
		if e.cat.App(id) == nil {
			return apiErr("unknown_id", "unknown app id", map[string]any{"path": fmt.Sprintf("targets.appIds[%d]", i), "id": id})
		}
	}
	for i, d := range t.CustomDomains {
		if e.cat.IsProtectedDomain(d) {
			return apiErr("protected_target", "protected domain",
				map[string]any{"path": fmt.Sprintf("targets.customDomains[%d]", i), "issue": "protected_domain"})
		}
	}
	if a := e.cat.FindAllowDistraction(
		catalog.AllowEntries{Domains: allow.CustomDomains, Processes: allow.CustomProcesses},
		catalog.AllowPaths{Domains: "allow.customDomains", Processes: "allow.customProcesses"}, e.platform); a != nil {
		d := map[string]any{"path": a.Path, "reason": a.Reason, "serviceId": nilIfEmpty(a.ServiceID), "appId": nilIfEmpty(a.AppID)}
		return apiErr("allow_distraction", "a whitelist entry is a distraction", d)
	}
	return nil
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// validateCreateBlock validates POST /v1/blocks in the order of §8.8 and returns the
// trusted end.
func (e *Engine) validateCreateBlock(req *CreateBlockRequest) (int64, error) {
	l := limits()
	req.Targets = req.Targets.normalized()
	req.Allow = req.Allow.normalized()
	// Shape.
	if err := e.validateTargetsShape(req.Targets, req.Allow); err != nil {
		return 0, err
	}
	if !slices.Contains(blockModes, req.Mode) {
		return 0, issueErr("mode", "enum", "unknown mode")
	}
	if req.DurationMinutes != nil {
		if d := *req.DurationMinutes; d < int64(l.BlockMinMinutes) || d > int64(l.BlockMaxMinutes) {
			return 0, issueErr("durationMinutes", "range", fmt.Sprintf("integer in [%d, %d]", l.BlockMinMinutes, l.BlockMaxMinutes))
		}
	}
	var endsDisplay int64
	if req.EndsAt != nil {
		ms, ok := parseMs(*req.EndsAt)
		if !ok {
			return 0, issueErr("endsAt", "pattern", "ISO 8601 UTC timestamp with milliseconds")
		}
		endsDisplay = ms
	}
	if issue := catalog.TextFieldIssue(catalog.FieldReason, req.Reason); issue != "" {
		return 0, issueErr("reason", issue, "invalid reason")
	}
	if (req.DurationMinutes == nil) == (req.EndsAt == nil) {
		return 0, issueErr("durationMinutes", "rule", "exactly one of durationMinutes and endsAt")
	}
	if err := targetRules(req.Targets, req.WhitelistOnly, req.Allow, req.Mode); err != nil {
		return 0, err
	}
	// Semantics.
	if err := e.validateSemanticTargets(req.Targets, req.Allow); err != nil {
		return 0, err
	}
	if err := e.checkBlockBudgets(req.Targets); err != nil {
		return 0, err
	}
	var end int64
	if req.DurationMinutes != nil {
		end = e.now + *req.DurationMinutes*msPerMinute
	} else {
		end = endsDisplay - e.wallOffsetMs() // display → trusted (§4)
	}
	minutes := ceilDiv(end-e.now, msPerMinute)
	if minutes < int64(l.BlockMinMinutes) || minutes > int64(l.BlockMaxMinutes) {
		return 0, apiErr("duration_out_of_range", "the block must last between the minimum and the maximum",
			map[string]any{"path": "endsAt", "issue": "range", "minMinutes": l.BlockMinMinutes, "maxMinutes": l.BlockMaxMinutes})
	}
	var needs []string
	if minutes > int64(l.LongBlockConfirmMinutes) && !req.AcknowledgeLong {
		needs = append(needs, "long")
	}
	if (req.Mode == ModeHardcore || req.Mode == ModeExam) && !req.AcknowledgeNoEmergency {
		needs = append(needs, "no_emergency")
	}
	if len(needs) > 0 {
		return 0, apiErr("confirmation_required", "the block needs an explicit confirmation", map[string]any{"needs": needs})
	}
	return end, nil
}

// checkBlockBudgets enforces the client budgets of §5.2: at most maxActiveBlocks active
// blocks of any kind, and at most maxActiveCustomHosts hosts entries from custom domains
// (after www./apex expansion) across active manual blocks.
func (e *Engine) checkBlockBudgets(t TargetSpec) *APIError {
	l := limits()
	active := e.activeBlocks()
	if len(active)+1 > l.MaxActiveBlocks {
		return apiErr("too_many_targets", "too many active blocks",
			map[string]any{"limit": l.MaxActiveBlocks, "current": len(active), "requested": 1, "kind": "blocks"})
	}
	current := 0
	for _, b := range active {
		if b.Kind == KindManual {
			current += e.customHostCount(b.Targets.CustomDomains)
		}
	}
	requested := e.customHostCount(t.CustomDomains)
	if requested > 0 && current+requested > l.MaxActiveCustomHosts {
		return apiErr("too_many_targets", "too many custom hosts",
			map[string]any{"limit": l.MaxActiveCustomHosts, "current": current, "requested": requested, "kind": "custom_hosts"})
	}
	return nil
}

// customHostCount is the number of hosts entries custom domains expand to.
func (e *Engine) customHostCount(domains []string) int {
	n := 0
	for _, d := range domains {
		n += len(e.cat.ExpandDomainVariants(d))
	}
	return n
}
