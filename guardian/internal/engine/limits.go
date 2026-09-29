package engine

// OWNER: daily limits (docs/ARCHITECTURE.md §5.10, §10.13, §8.8 «Daily limits» and
// «POST /v1/usage»).
//
// A daily limit («YouTube máximo 30 minutos al día») gives targets an allowance of usage
// minutes per local day (settings.timezone). Clients report usage (the extension: hosts of
// limited sites; the app: foreground processes); the guardian clamps every report to real
// elapsed time per client and credits each trusted millisecond at most once per limit.
// When the allowance runs out on an applicable day it materializes a block of kind limit
// until the next local midnight, once per (limit, day), plus further blocks when a
// strengthening edit widens what is limited after that. Strengthening edits apply at
// once; weakening ones (and deletions) wait limitWeakeningDelayMs as a pending change
// measured like settings delays (§5.8) and never on the day they were requested. Nothing
// here ever ends or shortens a block (fixed decision §2.1).
//
// State changes go through the reducers of the limit events (and block_created{limit}),
// except the usage counters, which live in state.json only (no event per report), the
// day rollover of limits without usage, and the pending delays' countdown.

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
)

// Usage item types (UsageItem.type).
const (
	usageTypeDomain  = "domain"
	usageTypeProcess = "process"
)

// limitsState is the persisted daily-limits state (state.json "engine.limits"): the
// limits in creation order with their resolution, pending change and today's usage.
type limitsState struct {
	List []*limitRec `json:"list"`
	// mem is not persisted: the per-client time of the last accepted usage report.
	mem *limitsMem
}

// limitsMem is the in-memory part of the limits state.
type limitsMem struct {
	// lastUsageBoot is the boot-clock reading of each client's previous accepted usage
	// report ("app" or "ext:<extensionId>"); lost on restart (§10.13).
	lastUsageBoot map[string]time.Duration
}

// limitRec is a DailyLimit in trusted time without its derived fields.
type limitRec struct {
	ID        string               `json:"id"`
	Def       DailyLimitDefinition `json:"definition"`
	CreatedAt int64                `json:"createdAt"`
	UpdatedAt int64                `json:"updatedAt"`
	// Resolved is what counts as usage and what its blocks enforce on this OS, fixed at
	// create, at every update that changes the targets and when a pending change applies.
	Resolved resolvedTargets `json:"resolved"`
	Pending  *limitPending   `json:"pending"`
	Usage    limitUsage      `json:"usage"`
}

// limitPending is a weakening change waiting (§5.10).
type limitPending struct {
	// Definition is what the limit becomes; nil is a pending deletion.
	Definition *DailyLimitDefinition `json:"definition"`
	// RemainingMs is the delay still to run: decremented by the boot-clock delta while the
	// guardian runs and by verified downtime.
	RemainingMs int64 `json:"remainingMs"`
	// RequestedDay is the local day the delay (re)started: it never applies that day.
	RequestedDay string `json:"requestedDay"`
	// StartedAt is the trusted time the delay (re)started (verified downtime is credited
	// only to changes that existed when the previous run stopped).
	StartedAt int64 `json:"startedAt"`
}

// limitUsage is the usage record of one limit for one local day.
type limitUsage struct {
	Day    string `json:"day"`
	UsedMs int64  `json:"usedMs"`
	// CreditedUntil is the per-limit watermark (trusted ms): time before it is never
	// credited again (§10.13). It survives the day rollover.
	CreditedUntil int64 `json:"creditedUntil"`
	WarnedAt      int64 `json:"warnedAt"`
	ReachedAt     int64 `json:"reachedAt"`
	// Covered is what limit blocks were materialized for today (whether or not they are
	// still active), so an emergency never re-triggers one and a strengthening edit adds
	// only what is new.
	Covered     limitCovered `json:"covered"`
	BlocksToday int          `json:"blocksToday"`
}

// limitCovered are the targets and the highest mode rank materialized today (rank −1:
// nothing).
type limitCovered struct {
	Targets TargetSpec `json:"targets"`
	Rank    int        `json:"rank"`
}

// DailyLimitInput mirrors DailyLimitInput (POST /v1/limits, PUT /v1/limits/{id}).
type DailyLimitInput struct {
	Name                   string     `json:"name"`
	Enabled                bool       `json:"enabled"`
	Targets                TargetSpec `json:"targets"`
	DailyMinutes           int64      `json:"dailyMinutes"`
	Days                   []int      `json:"days"`
	Mode                   string     `json:"mode"`
	Reason                 string     `json:"reason"`
	AcknowledgeNoEmergency bool       `json:"acknowledgeNoEmergency"`
}

// definition is the input without its acknowledgement.
func (in DailyLimitInput) definition() DailyLimitDefinition {
	return DailyLimitDefinition{
		Name: in.Name, Enabled: in.Enabled, Targets: in.Targets, DailyMinutes: in.DailyMinutes,
		Days: in.Days, Mode: in.Mode, Reason: in.Reason,
	}
}

// PendingLimitChange mirrors PendingLimitChange (definition nil: a pending deletion).
type PendingLimitChange struct {
	Definition  *DailyLimitDefinition `json:"definition"`
	EffectiveAt string                `json:"effectiveAt"`
}

// DailyLimit mirrors DailyLimit: the effective definition plus derived fields.
type DailyLimit struct {
	DailyLimitDefinition
	ID                    string              `json:"id"`
	CreatedAt             string              `json:"createdAt"`
	UpdatedAt             string              `json:"updatedAt"`
	Day                   string              `json:"day"`
	AppliesToday          bool                `json:"appliesToday"`
	UsedTodaySeconds      int64               `json:"usedTodaySeconds"`
	RemainingTodaySeconds int64               `json:"remainingTodaySeconds"`
	ReachedAt             *string             `json:"reachedAt"`
	ActiveBlockID         *string             `json:"activeBlockId"`
	PendingChange         *PendingLimitChange `json:"pendingChange"`
}

// LimitResponse mirrors LimitResponse.
type LimitResponse struct {
	Limit DailyLimit `json:"limit"`
}

// ListLimitsResponse mirrors ListLimitsResponse.
type ListLimitsResponse struct {
	Limits []DailyLimit `json:"limits"`
}

// UsageItem mirrors UsageItem.
type UsageItem struct {
	Type    string `json:"type"`
	Value   string `json:"value"`
	Seconds int64  `json:"seconds"`
}

// UsageReportRequest mirrors UsageReportRequest (POST /v1/usage).
type UsageReportRequest struct {
	IntervalMs int64       `json:"intervalMs"`
	Items      []UsageItem `json:"items"`
}

// LimitUsageStatus mirrors LimitUsageStatus.
type LimitUsageStatus struct {
	LimitID               string  `json:"limitId"`
	UsedTodaySeconds      int64   `json:"usedTodaySeconds"`
	RemainingTodaySeconds int64   `json:"remainingTodaySeconds"`
	AppliesToday          bool    `json:"appliesToday"`
	CreditedSeconds       int64   `json:"creditedSeconds"`
	BlockedUntil          *string `json:"blockedUntil"`
}

// UsageReportResponse mirrors UsageReportResponse.
type UsageReportResponse struct {
	Day       string             `json:"day"`
	Limits    []LimitUsageStatus `json:"limits"`
	ServerNow string             `json:"serverNow"`
}

// ExtRuleLimit mirrors ExtRuleLimit: an enabled limit as the extension needs it.
type ExtRuleLimit struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	ServiceIDs      []string `json:"serviceIds"`
	Domains         []string `json:"domains"`
	ExcludedDomains []string `json:"excludedDomains"`
	DailyMinutes    int64    `json:"dailyMinutes"`
	AppliesToday    bool     `json:"appliesToday"`
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

// ListLimits is GET /v1/limits (creation order, exact usage).
func (e *Engine) ListLimits(ctx context.Context) (ListLimitsResponse, error) {
	return run(e, ctx, cmdOpts{}, func() (ListLimitsResponse, error) {
		return ListLimitsResponse{Limits: e.limitsWire(e.wallOffsetMs(), true)}, nil
	})
}

// CreateLimit is POST /v1/limits (idempotent, 201).
func (e *Engine) CreateLimit(ctx context.Context, r Request, in DailyLimitInput) (LimitResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem, status: 201}, func() (LimitResponse, error) {
		return e.createLimit(in)
	})
}

func (e *Engine) createLimit(in DailyLimitInput) (LimitResponse, error) {
	def, err := e.limValidate(in)
	if err != nil {
		return LimitResponse{}, err
	}
	l := limits()
	if len(e.state.Limits.List) >= l.MaxLimits {
		ae := issueErr("$", "length", fmt.Sprintf("at most %d daily limits", l.MaxLimits))
		ae.Details["limit"] = l.MaxLimits
		return LimitResponse{}, ae
	}
	if err := e.limFinalChecks(def, "", def.Mode == ModeHardcore, in.AcknowledgeNoEmergency); err != nil {
		return LimitResponse{}, err
	}
	rec := &limitRec{
		ID: newID("lim"), Def: def, CreatedAt: e.now, UpdatedAt: e.now,
		Usage: freshLimitUsage(e.localDay(e.now), e.now),
	}
	b := e.newBatch()
	b.add(EvLimitCreated, LimitCreatedData{Limit: e.limitWire(rec, 0, true)})
	if err := e.commit(b); err != nil {
		return LimitResponse{}, err
	}
	// A 5-minute limit warns at once (§8.8).
	e.evaluateLimits(e.now)
	return e.limResponse(rec.ID)
}

// UpdateLimit is PUT /v1/limits/{id} (full replace): the strengthening part applies at
// once, the rest waits as the pending change (§5.10).
func (e *Engine) UpdateLimit(ctx context.Context, r Request, id string, in DailyLimitInput) (LimitResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem}, func() (LimitResponse, error) {
		return e.updateLimit(id, in)
	})
}

func (e *Engine) updateLimit(id string, in DailyLimitInput) (LimitResponse, error) {
	rec := e.limit(id)
	if rec == nil {
		return LimitResponse{}, notFound("limit")
	}
	req, err := e.limValidate(in)
	if err != nil {
		return LimitResponse{}, err
	}
	applied, pending := splitLimitChange(rec.Def, req)
	applied = applied.normalized()
	if err := e.limFinalChecks(applied, id, req.Mode == ModeHardcore, in.AcknowledgeNoEmergency); err != nil {
		return LimitResponse{}, err
	}
	next := e.limNextPending(rec.Pending, pending, false)
	if limitDefEqual(applied, rec.Def) && limPendingSame(rec.Pending, next) {
		return e.limResponse(id) // nothing changed: no event
	}
	snap := *rec
	snap.Def, snap.Pending, snap.UpdatedAt = applied, next, e.now
	b := e.newBatch()
	b.add(EvLimitUpdated, LimitUpdatedData{Limit: e.limitWire(&snap, 0, true), Cause: "user"})
	if err := e.commit(b); err != nil {
		return LimitResponse{}, err
	}
	// A lower allowance or a new day may reach it now; new targets or a stricter mode
	// after reaching it add a limit block.
	e.evaluateLimits(e.now)
	return e.limResponse(id)
}

// DeleteLimit is DELETE /v1/limits/{id}: it never deletes at once; it sets (or keeps) a
// pending deletion and answers 200 with the limit (§8.8).
func (e *Engine) DeleteLimit(ctx context.Context, r Request, id string) (LimitResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem}, func() (LimitResponse, error) {
		return e.deleteLimit(id)
	})
}

func (e *Engine) deleteLimit(id string) (LimitResponse, error) {
	rec := e.limit(id)
	if rec == nil {
		return LimitResponse{}, notFound("limit")
	}
	if rec.Pending != nil && rec.Pending.Definition == nil {
		return e.limResponse(id) // already pending: no event, the delay keeps running
	}
	snap := *rec
	snap.Pending, snap.UpdatedAt = e.limNextPending(rec.Pending, nil, true), e.now
	b := e.newBatch()
	b.add(EvLimitUpdated, LimitUpdatedData{Limit: e.limitWire(&snap, 0, true), Cause: "user"})
	if err := e.commit(b); err != nil {
		return LimitResponse{}, err
	}
	return e.limResponse(id)
}

// ReportUsage is POST /v1/usage (app or ext token). It is a report (§8.3 step 6):
// accepted in safe mode, refused only in frozen mode.
func (e *Engine) ReportUsage(ctx context.Context, r Request, req UsageReportRequest) (UsageReportResponse, error) {
	return run(e, ctx, cmdOpts{report: true}, func() (UsageReportResponse, error) { return e.reportUsage(r, req) })
}

func (e *Engine) reportUsage(r Request, req UsageReportRequest) (UsageReportResponse, error) {
	if err := validateUsageReport(req); err != nil {
		return UsageReportResponse{}, err
	}
	client, want := "", ""
	switch r.Scope {
	case scopeExt:
		client, want = "ext:"+r.ExtensionID, usageTypeDomain
	case scopeApp:
		client, want = scopeApp, usageTypeProcess
	}
	if want == "" || slices.ContainsFunc(req.Items, func(it UsageItem) bool { return it.Type != want }) {
		return UsageReportResponse{}, apiErr("insufficient_scope", "the extension reports domains and the app reports processes", nil)
	}
	l := limits()
	slack := int64(l.UsageSlackMs)
	m := e.limitsMem()
	var since *int64
	if last, ok := m.lastUsageBoot[client]; ok {
		since = ptr((e.bootNow - last).Milliseconds())
	}
	interval := clampUsageInterval(req.IntervalMs, since, slack)
	m.lastUsageBoot[client] = e.bootNow
	today := e.localDay(e.now)
	dayStart := e.startOfLocalDay(e.now)
	credited := map[string]int64{}
	for _, rec := range e.state.Limits.List {
		if !rec.Def.Enabled {
			continue // reports never create usage for a disabled limit
		}
		var rep int64
		for _, it := range req.Items {
			if e.limMatches(rec, it) {
				rep += it.Seconds * 1000
			}
		}
		rep = min(rep, interval)
		if rep <= 0 {
			continue
		}
		u := limUsageFor(rec, today)
		c, until := limitUsageCredit(e.now, dayStart, interval, rep, u.CreditedUntil, slack)
		u.UsedMs += c
		u.CreditedUntil = until
		credited[rec.ID] = c
		if c > 0 {
			e.markDirty(false)
		}
	}
	e.evaluateLimits(e.now)
	res := UsageReportResponse{Day: e.localDay(e.now), Limits: []LimitUsageStatus{}, ServerNow: e.serverNow()}
	for _, rec := range e.state.Limits.List {
		if !rec.Def.Enabled {
			continue
		}
		used := e.limUsedToday(rec) / 1000
		st := LimitUsageStatus{
			LimitID: rec.ID, UsedTodaySeconds: used, RemainingTodaySeconds: max(0, rec.Def.DailyMinutes*60-used),
			AppliesToday: e.limAppliesOn(rec, res.Day), CreditedSeconds: credited[rec.ID] / 1000,
		}
		if b := e.limActiveBlock(rec.ID); b != nil {
			st.BlockedUntil = ptr(e.display(b.EndsAt))
		}
		res.Limits = append(res.Limits, st)
	}
	return res, nil
}

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

// limValidate validates a DailyLimitInput in the order of dailyLimitInputSchema (shape,
// then the target rule), then the semantic checks shared with blocks (unknown ids,
// protected custom domains). It returns the definition with sorted days.
func (e *Engine) limValidate(in DailyLimitInput) (DailyLimitDefinition, *APIError) {
	l := limits()
	in.Targets = in.Targets.normalized()
	if issue := catalog.TextFieldIssue(catalog.FieldLimitName, in.Name); issue != "" {
		return DailyLimitDefinition{}, issueErr("name", issue, "invalid limit name")
	}
	if err := e.validateTargetsShape(in.Targets, emptyAllow()); err != nil {
		return DailyLimitDefinition{}, err
	}
	if in.DailyMinutes < int64(l.LimitMinMinutes) || in.DailyMinutes > int64(l.LimitMaxMinutes) {
		return DailyLimitDefinition{}, issueErr("dailyMinutes", "range", fmt.Sprintf("integer in [%d, %d]", l.LimitMinMinutes, l.LimitMaxMinutes))
	}
	if len(in.Days) < 1 || len(in.Days) > schDaysMax {
		return DailyLimitDefinition{}, issueErr("days", "length", fmt.Sprintf("between 1 and %d items", schDaysMax))
	}
	for i, d := range in.Days {
		p := fmt.Sprintf("days[%d]", i)
		if d < 1 || d > schDaysMax {
			return DailyLimitDefinition{}, issueErr(p, "enum", "an ISO weekday (1 = Monday … 7 = Sunday)")
		}
		if slices.Index(in.Days, d) != i {
			return DailyLimitDefinition{}, issueErr(p, "duplicate", "duplicate")
		}
	}
	if !slices.Contains(limitModes, in.Mode) {
		return DailyLimitDefinition{}, issueErr("mode", "enum", "normal, strict or hardcore")
	}
	if issue := catalog.TextFieldIssue(catalog.FieldReason, in.Reason); issue != "" {
		return DailyLimitDefinition{}, issueErr("reason", issue, "invalid reason")
	}
	if in.Targets.count() == 0 {
		return DailyLimitDefinition{}, issueErr("targets", "rule", "at least one target")
	}
	if err := e.validateSemanticTargets(in.Targets, emptyAllow()); err != nil {
		return DailyLimitDefinition{}, err
	}
	return in.definition().normalized(), nil
}

// limFinalChecks are the checks after the shape and the semantics (§8.8): the custom-host
// budget of enabled limits counted with the applied definition (exclude is the limit
// being replaced) and the no-emergency confirmation of a request for mode hardcore.
func (e *Engine) limFinalChecks(applied DailyLimitDefinition, exclude string, hardcore, acknowledged bool) *APIError {
	l := limits()
	if applied.Enabled {
		if requested := e.customHostCount(applied.Targets.CustomDomains); requested > 0 {
			current := 0
			for _, rec := range e.state.Limits.List {
				if rec.Def.Enabled && rec.ID != exclude {
					current += e.customHostCount(rec.Def.Targets.CustomDomains)
				}
			}
			if current+requested > l.MaxLimitCustomHosts {
				return apiErr("too_many_targets", "too many custom hosts across enabled daily limits",
					map[string]any{"limit": l.MaxLimitCustomHosts, "current": current, "requested": requested, "kind": "limit_custom_hosts"})
			}
		}
	}
	if hardcore && !acknowledged {
		return apiErr("confirmation_required", "the daily limit needs an explicit confirmation", map[string]any{"needs": []string{"no_emergency"}})
	}
	return nil
}

// validateUsageReport validates POST /v1/usage like usageReportRequestSchema: the shape
// (intervalMs, then each item's type, value and seconds), then the refinement (no item
// with more seconds than the interval, no duplicate item).
func validateUsageReport(req UsageReportRequest) *APIError {
	l := limits()
	maxInterval := int64(l.UsageMaxIntervalMs)
	if req.IntervalMs < 1000 || req.IntervalMs > maxInterval {
		return issueErr("intervalMs", "range", fmt.Sprintf("integer in [1000, %d]", maxInterval))
	}
	if len(req.Items) > l.UsageMaxItems {
		return issueErr("items", "length", fmt.Sprintf("between 0 and %d items", l.UsageMaxItems))
	}
	for i, it := range req.Items {
		p := fmt.Sprintf("items[%d]", i)
		switch it.Type {
		case usageTypeDomain:
			if !catalog.IsValidDomain(it.Value) {
				return issueErr(p+".value", "invalid_domain", "canonical domain")
			}
		case usageTypeProcess:
			if !catalog.IsValidProcessName(it.Value) {
				return issueErr(p+".value", "invalid_process", "executable base name")
			}
		default:
			return issueErr(p+".type", "enum", "unknown variant")
		}
		if it.Seconds < 1 || it.Seconds > maxInterval/1000 {
			return issueErr(p+".seconds", "range", fmt.Sprintf("integer in [1, %d]", maxInterval/1000))
		}
	}
	maxSeconds := ceilDiv(req.IntervalMs, 1000)
	seen := map[string]bool{}
	for i, it := range req.Items {
		p := fmt.Sprintf("items[%d]", i)
		if it.Seconds > maxSeconds {
			return issueErr(p+".seconds", "rule", "more seconds than the interval")
		}
		key := it.Type + ":" + it.Value
		if seen[key] {
			return issueErr(p, "rule", "duplicate item")
		}
		seen[key] = true
	}
	return nil
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

// limit returns the limit with that id, or nil.
func (e *Engine) limit(id string) *limitRec {
	for _, rec := range e.state.Limits.List {
		if rec.ID == id {
			return rec
		}
	}
	return nil
}

func (e *Engine) limitsMem() *limitsMem {
	st := &e.state.Limits
	if st.mem == nil {
		st.mem = &limitsMem{}
	}
	if st.mem.lastUsageBoot == nil {
		st.mem.lastUsageBoot = map[string]time.Duration{}
	}
	return st.mem
}

// limDelayMs is limitWeakeningDelayMs.
func limDelayMs() int64 { return int64(limits().LimitWeakeningDelayMs) }

// freshLimitUsage is an empty usage record for day, keeping the watermark.
func freshLimitUsage(day string, creditedUntil int64) limitUsage {
	return limitUsage{Day: day, CreditedUntil: creditedUntil, Covered: limitCovered{Targets: emptyTargets(), Rank: -1}}
}

// limUsageFor is the usage record of rec for day: a record of an earlier day is replaced
// by a fresh one (a later one, which only a time-zone change can leave, is kept: usage
// never moves to a day that was already counted).
func limUsageFor(rec *limitRec, day string) *limitUsage {
	if rec.Usage.Day < day {
		rec.Usage = freshLimitUsage(day, rec.Usage.CreditedUntil)
	}
	return &rec.Usage
}

// limUsedToday is the usage counted today (ms).
func (e *Engine) limUsedToday(rec *limitRec) int64 {
	if rec.Usage.Day >= e.localDay(e.now) {
		return rec.Usage.UsedMs
	}
	return 0
}

// limAppliesOn reports whether the limit applies on the local day: enabled and the
// weekday in its days.
func (e *Engine) limAppliesOn(rec *limitRec, day string) bool {
	if !rec.Def.Enabled {
		return false
	}
	d, ok := parseLocalDay(day)
	return ok && slices.Contains(rec.Def.Days, d.isoWeekday())
}

// parseLocalDay parses YYYY-MM-DD.
func parseLocalDay(day string) (schDate, bool) {
	t, err := time.Parse(time.DateOnly, day)
	if err != nil {
		return schDate{}, false
	}
	y, m, d := t.Date()
	return schDate{y, m, d}, true
}

// localDate is the local calendar date of a trusted time (settings.timezone).
func (e *Engine) localDate(ms int64) schDate {
	y, m, d := time.UnixMilli(ms).In(e.location()).Date()
	return schDate{y, m, d}
}

// startOfLocalDay is the first instant of the local day of T (trusted ms).
func (e *Engine) startOfLocalDay(T int64) int64 {
	return schWallInstant(e.localDate(T), 0, e.location())
}

// nextLocalMidnight is the first instant whose local date is the day after T's (a DST gap
// at midnight moves it to the transition, an overlap to the earlier instant).
func (e *Engine) nextLocalMidnight(T int64) int64 {
	return schWallInstant(e.localDate(T).addDays(1), 0, e.location())
}

// startOfDayAfter is the first instant of the local day after day (0 when day is not a
// date).
func (e *Engine) startOfDayAfter(day string) int64 {
	d, ok := parseLocalDay(day)
	if !ok {
		return 0
	}
	return schWallInstant(d.addDays(1), 0, e.location())
}

// limEffectiveAt estimates when a pending change applies (trusted ms): max(now +
// remaining, the start of the day after the request day).
func (e *Engine) limEffectiveAt(p *limitPending) int64 {
	return max(e.now+max(0, p.RemainingMs), e.startOfDayAfter(p.RequestedDay))
}

// limActiveBlock is the latest-ending active block the limit materialized, or nil.
func (e *Engine) limActiveBlock(id string) *blockRec {
	var best *blockRec
	for _, b := range e.state.Blocks {
		if b.Status != StatusActive || b.LimitID == nil || *b.LimitID != id {
			continue
		}
		if best == nil || b.EndsAt > best.EndsAt || (b.EndsAt == best.EndsAt && b.Rank > best.Rank) {
			best = b
		}
	}
	return best
}

// limMatches reports whether a usage item counts for the limit (§10.13): a host equal to
// or under one of its resolved domains and not equal to or under an excluded one, or a
// process whose name key equals one of its resolved processes.
func (e *Engine) limMatches(rec *limitRec, it UsageItem) bool {
	switch it.Type {
	case usageTypeDomain:
		return underAnyDomain(it.Value, rec.Resolved.Domains) && !underAnyDomain(it.Value, rec.Resolved.ExcludedDomains)
	case usageTypeProcess:
		return containsProcess(rec.Resolved.Processes, it.Value, e.platform)
	}
	return false
}

// limNextPending is the pending change after a PUT (next: the pending definition, nil for
// none) or a DELETE (deletion). The delay already run is kept when the new change weakens
// nothing relative to the old one (pendingLimitDelayKept), else it restarts today.
func (e *Engine) limNextPending(old *limitPending, next *DailyLimitDefinition, deletion bool) *limitPending {
	if !deletion && next == nil {
		return nil
	}
	var def *DailyLimitDefinition
	if !deletion {
		d := next.normalized()
		def = &d
	}
	if old != nil && pendingLimitDelayKept(old.Definition, def) {
		return &limitPending{Definition: def, RemainingMs: old.RemainingMs, RequestedDay: old.RequestedDay, StartedAt: old.StartedAt}
	}
	return &limitPending{Definition: def, RemainingMs: limDelayMs(), RequestedDay: e.localDay(e.now), StartedAt: e.now}
}

// limPendingSame reports whether two pending changes are the same change.
func limPendingSame(a, b *limitPending) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	if a.Definition == nil || b.Definition == nil {
		return a.Definition == nil && b.Definition == nil
	}
	return limitDefEqual(*a.Definition, *b.Definition)
}

// limitWire converts a limit with its derived fields (offsetMs: the wall offset for API
// responses, 0 in events; exact: usage to the second, else floored to whole minutes as
// /v1/state shows it).
func (e *Engine) limitWire(rec *limitRec, offsetMs int64, exact bool) DailyLimit {
	today := e.localDay(e.now)
	var used, reached int64
	if rec.Usage.Day >= today {
		used, reached = rec.Usage.UsedMs, rec.Usage.ReachedAt
	}
	usedSec := used / 1000
	if !exact {
		usedSec = used / msPerMinute * 60
	}
	w := DailyLimit{
		DailyLimitDefinition:  rec.Def.normalized(),
		ID:                    rec.ID,
		CreatedAt:             fmtMs(rec.CreatedAt + offsetMs),
		UpdatedAt:             fmtMs(rec.UpdatedAt + offsetMs),
		Day:                   today,
		AppliesToday:          e.limAppliesOn(rec, today),
		UsedTodaySeconds:      usedSec,
		RemainingTodaySeconds: max(0, rec.Def.DailyMinutes*60-usedSec),
	}
	if reached != 0 {
		w.ReachedAt = ptr(fmtMs(reached + offsetMs))
	}
	if b := e.limActiveBlock(rec.ID); b != nil {
		w.ActiveBlockID = ptr(b.ID)
	}
	if p := rec.Pending; p != nil {
		pc := &PendingLimitChange{EffectiveAt: fmtMs(ceilDiv(e.limEffectiveAt(p)+offsetMs, 1000) * 1000)}
		if p.Definition != nil {
			d := p.Definition.normalized()
			pc.Definition = &d
		}
		w.PendingChange = pc
	}
	return w
}

// limitsWire lists every limit in creation order.
func (e *Engine) limitsWire(offsetMs int64, exact bool) []DailyLimit {
	out := []DailyLimit{}
	for _, rec := range e.state.Limits.List {
		out = append(out, e.limitWire(rec, offsetMs, exact))
	}
	return out
}

// limResponse is the response of a committed limit write (display time, exact usage).
func (e *Engine) limResponse(id string) (LimitResponse, error) {
	rec := e.limit(id)
	if rec == nil {
		return LimitResponse{}, apiErr("internal", "the daily limit was not applied", nil)
	}
	return LimitResponse{Limit: e.limitWire(rec, e.wallOffsetMs(), true)}, nil
}

// extRuleLimits is ExtRulesResponse.limits: every enabled limit in creation order.
func (e *Engine) extRuleLimits() []ExtRuleLimit {
	today := e.localDay(e.now)
	out := []ExtRuleLimit{}
	for _, rec := range e.state.Limits.List {
		if !rec.Def.Enabled {
			continue
		}
		out = append(out, ExtRuleLimit{
			ID: rec.ID, Name: rec.Def.Name, ServiceIDs: nonNil(slices.Clone(rec.Resolved.ServiceIDs)),
			Domains: nonNil(slices.Clone(rec.Resolved.Domains)), ExcludedDomains: nonNil(slices.Clone(rec.Resolved.ExcludedDomains)),
			DailyMinutes: rec.Def.DailyMinutes, AppliesToday: e.limAppliesOn(rec, today),
		})
	}
	return out
}

// extBlockKind is the block kind an extension token sees (§8.4): a limit block is
// reported as manual (older extensions reject unknown kinds); limitId tells it apart.
func extBlockKind(kind string) string {
	if kind == KindLimit {
		return KindManual
	}
	return kind
}

// ---------------------------------------------------------------------------------------
// Hooks the core calls
// ---------------------------------------------------------------------------------------

// limitsStep is the daily-limit part of the time step (§10.13): the day rollover, the
// pending changes (dBootMs: the boot-clock time since the last step) and the evaluation.
func (e *Engine) limitsStep(T, dBootMs int64) {
	if len(e.state.Limits.List) == 0 {
		return
	}
	e.limitsRollover(T)
	e.limitsApplyPending(T, dBootMs)
	e.evaluateLimits(T)
}

// limitsRollover starts a new usage record for every limit whose record is of an earlier
// local day, after writing limit_day_closed for those that had usage or were reached
// (one batch). A new day bumps both versions (appliesToday may change).
func (e *Engine) limitsRollover(T int64) {
	today := e.localDay(T)
	var rolled []*limitRec
	b := e.newBatch()
	for _, rec := range e.state.Limits.List {
		u := rec.Usage
		if u.Day >= today {
			continue
		}
		rolled = append(rolled, rec)
		if u.Day != "" && (u.UsedMs > 0 || u.ReachedAt != 0) {
			b.add(EvLimitDayClosed, LimitDayClosedData{
				LimitID: rec.ID, Name: rec.Def.Name, Day: u.Day, DailyMinutes: rec.Def.DailyMinutes,
				UsedSeconds: u.UsedMs / 1000, Applied: e.limAppliesOn(rec, u.Day), Reached: u.ReachedAt != 0,
			})
		}
	}
	if len(rolled) == 0 {
		return
	}
	if !b.empty() && !e.commitNow(b, "limit day rollover") {
		return // retried on the next step
	}
	for _, rec := range rolled {
		limUsageFor(rec, today)
	}
	e.bumpState()
	e.bumpExtRules()
	e.markDirty(true)
}

// limitsApplyPending runs the pending delays and applies the changes that are due: their
// delay ran out and the local day is after the one they were requested on.
func (e *Engine) limitsApplyPending(T, dBootMs int64) {
	today := e.localDay(T)
	for _, rec := range slices.Clone(e.state.Limits.List) {
		p := rec.Pending
		if p == nil {
			continue
		}
		if dBootMs > 0 {
			p.RemainingMs -= dBootMs
		}
		if p.RemainingMs > 0 || today <= p.RequestedDay {
			continue
		}
		b := e.newBatch()
		if p.Definition == nil {
			b.add(EvLimitDeleted, LimitDeletedData{LimitID: rec.ID, Name: rec.Def.Name})
		} else {
			snap := *rec
			snap.Def, snap.Pending, snap.UpdatedAt = p.Definition.normalized(), nil, T
			b.add(EvLimitUpdated, LimitUpdatedData{Limit: e.limitWire(&snap, 0, true), Cause: "pending_applied"})
		}
		if !e.commitNow(b, "pending limit change") {
			return
		}
		e.bumpExtRules()
	}
}

// evaluateLimits (§10.13) runs after every step, usage report and limit write: per
// enabled limit that applies today, in creation order, limit_warning once when 0 <
// remaining ≤ limitWarningSeconds, and limit_reached plus a limit block until the next
// local midnight when the allowance ran out (once per day, plus a further block when a
// strengthening edit widened what is limited, at most limitMaxBlocksPerDay).
func (e *Engine) evaluateLimits(T int64) {
	l := limits()
	today := e.localDay(T)
	for _, rec := range slices.Clone(e.state.Limits.List) {
		if !e.limAppliesOn(rec, today) || rec.Usage.Day < today {
			continue
		}
		u := rec.Usage
		allowance := rec.Def.DailyMinutes * msPerMinute
		if u.UsedMs < allowance {
			if u.ReachedAt == 0 && u.WarnedAt == 0 && allowance-u.UsedMs <= int64(l.LimitWarningSeconds)*1000 {
				b := e.newBatch()
				b.add(EvLimitWarning, LimitWarningData{
					LimitID: rec.ID, Name: rec.Def.Name, Day: u.Day, DailyMinutes: rec.Def.DailyMinutes,
					UsedSeconds: u.UsedMs / 1000, RemainingSeconds: rec.Def.DailyMinutes*60 - u.UsedMs/1000,
				})
				if !e.commitNow(b, "limit warning") {
					return
				}
			}
			continue
		}
		first := u.ReachedAt == 0
		rank := limitModeRank(rec.Def.Mode)
		grow := !first && (!targetsCover(u.Covered.Targets, rec.Def.Targets) || rank > u.Covered.Rank)
		if !first && (!grow || u.BlocksToday >= l.LimitMaxBlocksPerDay) {
			continue
		}
		b := e.newBatch()
		var blk *Block
		if end := e.nextLocalMidnight(T); end-T >= int64(l.LimitMinBlockMs) {
			id := rec.ID
			snap := e.newBlockSnapshot(blockSpec{
				Kind: KindLimit, Mode: rec.Def.Mode, Targets: rec.Def.Targets, Allow: emptyAllow(),
				Reason: rec.Def.Reason, StartsAt: T, EndsAt: end, LimitID: &id,
			})
			blk = &snap
		}
		if first {
			var blockID *string
			if blk != nil {
				blockID = ptr(blk.ID)
			}
			b.add(EvLimitReached, LimitReachedData{
				LimitID: rec.ID, Name: rec.Def.Name, Day: u.Day, DailyMinutes: rec.Def.DailyMinutes,
				UsedSeconds: u.UsedMs / 1000, BlockID: blockID,
			})
		}
		if blk != nil {
			e.addBlockCreated(b, *blk, "limit")
		}
		if b.empty() {
			continue // a strengthening edit less than a minute before midnight
		}
		if !e.commitNow(b, "limit reached") {
			return
		}
	}
}

// limitsCreditVerifiedDowntime subtracts downtime a network time check verified from the
// pending changes that existed when the previous run stopped (§5.10, like §5.8).
func (e *Engine) limitsCreditVerifiedDowntime(ms int64) {
	if ms <= 0 {
		return
	}
	for _, rec := range e.state.Limits.List {
		if p := rec.Pending; p != nil && p.StartedAt <= e.cal.stopT {
			p.RemainingMs -= ms
		}
	}
	e.markDirty(true)
}

// keptLimits are the limits an epoch keeps: every one, with its pending change and
// today's usage (§10.11 step 2), in trusted time.
func (e *Engine) keptLimits() []DailyLimit { return e.limitsWire(0, true) }

// restoreKeptLimits replaces the limits with epoch_started.kept.limits. A limit this
// engine already holds (a live data deletion) keeps its exact usage record and pending
// delay; the others are rebuilt from the snapshot: today's usage, a reached limit counts
// as materialized with its current targets and mode, and a pending delay runs from the
// estimate it carries. The watermark restarts at the epoch start either way.
func (e *Engine) restoreKeptLimits(list []DailyLimit, ev *storeEvent) {
	at := atMs(ev)
	prev := map[string]*limitRec{}
	for _, rec := range e.state.Limits.List {
		prev[rec.ID] = rec
	}
	st := &e.state.Limits
	st.List = []*limitRec{}
	for _, w := range list {
		rec, err := limRecFromWire(w)
		if err != nil || slices.ContainsFunc(st.List, func(r *limitRec) bool { return r.ID == rec.ID }) {
			continue
		}
		old := prev[rec.ID]
		if old != nil && targetsEqual(old.Def.Targets, rec.Def.Targets) {
			rec.Resolved = old.Resolved
		} else {
			rec.Resolved = e.resolveTargets(rec.Def.Targets)
		}
		switch {
		case old != nil && limPendingSame(old.Pending, pendingFromDailyLimit(w)):
			rec.Pending = old.Pending
		default:
			rec.Pending = e.limPendingFromKept(w.PendingChange, ev)
		}
		if old != nil {
			rec.Usage = old.Usage
			rec.Usage.CreditedUntil = max(rec.Usage.CreditedUntil, at)
		} else {
			rec.Usage = e.limUsageFromKept(rec, w, at)
		}
		st.List = append(st.List, rec)
	}
}

// limUsageFromKept rebuilds a usage record from a kept snapshot.
func (e *Engine) limUsageFromKept(rec *limitRec, w DailyLimit, at int64) limitUsage {
	u := freshLimitUsage(w.Day, at)
	u.UsedMs = max(0, w.UsedTodaySeconds) * 1000
	if w.ReachedAt != nil {
		if ms, ok := parseMs(*w.ReachedAt); ok {
			u.ReachedAt = ms
			u.WarnedAt = ms
			u.Covered = limitCovered{Targets: rec.Def.Targets.normalized(), Rank: limitModeRank(rec.Def.Mode)}
			n := 0
			for _, b := range e.state.Blocks {
				if b.Status == StatusActive && b.LimitID != nil && *b.LimitID == rec.ID {
					n++
				}
			}
			u.BlocksToday = max(1, n)
		}
	}
	if u.WarnedAt == 0 && w.AppliesToday && u.UsedMs > 0 && rec.Def.DailyMinutes*msPerMinute-u.UsedMs <= int64(limits().LimitWarningSeconds)*1000 {
		u.WarnedAt = at
	}
	return u
}

// pendingFromDailyLimit is the pending change a snapshot carries, without its timing.
func pendingFromDailyLimit(w DailyLimit) *limitPending {
	if w.PendingChange == nil {
		return nil
	}
	return &limitPending{Definition: w.PendingChange.Definition}
}

// limPendingFromKept rebuilds a pending change from a snapshot that is not the request
// (an epoch's kept limits): the delay runs until the estimate it carries (never more than
// the full delay) and the request day is the earliest one that estimate allows.
func (e *Engine) limPendingFromKept(w *PendingLimitChange, ev *storeEvent) *limitPending {
	if w == nil {
		return nil
	}
	delay := limDelayMs()
	at := atMs(ev)
	rem := delay
	day := ev.Day
	if ea, ok := parseMs(w.EffectiveAt); ok && at > 0 {
		rem = min(max(ea-at, 0), delay)
		if d := e.localDay(ea - delay); d < day {
			day = d
		}
	}
	p := &limitPending{RemainingMs: rem, RequestedDay: day, StartedAt: at - (delay - rem)}
	if w.Definition != nil {
		d := w.Definition.normalized()
		p.Definition = &d
	}
	return p
}

// limPendingFromWire is the pending change of a limit_updated snapshot: the delay of the
// previous pending change is kept when the new one weakens nothing relative to it
// (pendingLimitDelayKept, exactly as the command decided), else it starts at the event.
func limPendingFromWire(prev *limitPending, w *PendingLimitChange, ev *storeEvent) *limitPending {
	if w == nil {
		return nil
	}
	var def *DailyLimitDefinition
	if w.Definition != nil {
		d := w.Definition.normalized()
		def = &d
	}
	if prev != nil && pendingLimitDelayKept(prev.Definition, def) {
		return &limitPending{Definition: def, RemainingMs: prev.RemainingMs, RequestedDay: prev.RequestedDay, StartedAt: prev.StartedAt}
	}
	delay := limDelayMs()
	at := atMs(ev)
	rem := delay
	if ea, ok := parseMs(w.EffectiveAt); ok && at > 0 {
		rem = min(max(ea-at, 0), delay)
	}
	return &limitPending{Definition: def, RemainingMs: rem, RequestedDay: ev.Day, StartedAt: at - (delay - rem)}
}

// limRecFromWire reads a trusted-time DailyLimit snapshot (events, epoch_started.kept)
// without resolution, pending change or usage.
func limRecFromWire(w DailyLimit) (*limitRec, error) {
	created, ok1 := parseMs(w.CreatedAt)
	updated, ok2 := parseMs(w.UpdatedAt)
	if !ok1 || !ok2 {
		return nil, fmt.Errorf("limit %s: invalid timestamp", w.ID)
	}
	return &limitRec{ID: w.ID, Def: w.DailyLimitDefinition.normalized(), CreatedAt: created, UpdatedAt: updated}, nil
}

// markLimitBlock records a limit block in its limit's usage record (the reducer of
// block_created{limit}): what is covered today and how many blocks were materialized.
func (e *Engine) markLimitBlock(blk *blockRec, ev *storeEvent) {
	if blk.LimitID == nil {
		return
	}
	rec := e.limit(*blk.LimitID)
	if rec == nil {
		return
	}
	u := limUsageFor(rec, ev.Day)
	if u.Day != ev.Day {
		return
	}
	u.Covered = limitCovered{Targets: targetsUnion(u.Covered.Targets, blk.Targets).normalized(), Rank: max(u.Covered.Rank, limitModeRank(blk.Mode))}
	u.BlocksToday++
}

// ---------------------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------------------

func (e *Engine) applyLimitCreated(ev *storeEvent) error {
	d, err := decode[LimitCreatedData](ev)
	if err != nil {
		return err
	}
	rec, err := limRecFromWire(d.Limit)
	if err != nil {
		return fmt.Errorf("seq %d: %w", ev.Seq, err)
	}
	if e.limit(rec.ID) != nil {
		return fmt.Errorf("seq %d: limit %s exists", ev.Seq, rec.ID)
	}
	rec.Resolved = e.resolveTargets(rec.Def.Targets)
	// Nothing before the limit existed ever counts.
	rec.Usage = freshLimitUsage(ev.Day, atMs(ev))
	e.state.Limits.List = append(e.state.Limits.List, rec)
	return nil
}

func (e *Engine) applyLimitUpdated(ev *storeEvent) error {
	d, err := decode[LimitUpdatedData](ev)
	if err != nil {
		return err
	}
	rec := e.limit(d.Limit.ID)
	if rec == nil {
		return fmt.Errorf("seq %d: unknown limit %s", ev.Seq, d.Limit.ID)
	}
	w, err := limRecFromWire(d.Limit)
	if err != nil {
		return fmt.Errorf("seq %d: %w", ev.Seq, err)
	}
	if !targetsEqual(w.Def.Targets, rec.Def.Targets) || len(rec.Resolved.Domains)+len(rec.Resolved.Processes) == 0 {
		rec.Resolved = e.resolveTargets(w.Def.Targets)
	}
	rec.Def = w.Def
	rec.UpdatedAt = w.UpdatedAt
	rec.Pending = limPendingFromWire(rec.Pending, d.Limit.PendingChange, ev)
	return nil
}

func (e *Engine) applyLimitDeleted(ev *storeEvent) error {
	d, err := decode[LimitDeletedData](ev)
	if err != nil {
		return err
	}
	st := &e.state.Limits
	n := len(st.List)
	st.List = slices.DeleteFunc(st.List, func(r *limitRec) bool { return r.ID == d.LimitID })
	if len(st.List) == n {
		return fmt.Errorf("seq %d: unknown limit %s", ev.Seq, d.LimitID)
	}
	return nil
}

func (e *Engine) applyLimitWarning(ev *storeEvent) error {
	d, err := decode[LimitWarningData](ev)
	if err != nil {
		return err
	}
	rec := e.limit(d.LimitID)
	if rec == nil {
		return nil // deleted later in a log being rebuilt
	}
	if u := limUsageFor(rec, d.Day); u.Day == d.Day {
		u.UsedMs = max(u.UsedMs, d.UsedSeconds*1000)
		u.WarnedAt = atMs(ev)
	}
	return nil
}

func (e *Engine) applyLimitReached(ev *storeEvent) error {
	d, err := decode[LimitReachedData](ev)
	if err != nil {
		return err
	}
	rec := e.limit(d.LimitID)
	if rec == nil {
		return nil
	}
	u := limUsageFor(rec, d.Day)
	if u.Day != d.Day {
		return nil
	}
	u.UsedMs = max(u.UsedMs, d.UsedSeconds*1000)
	u.ReachedAt = atMs(ev)
	if d.BlockID == nil {
		// Nothing was blocked (less than a minute before midnight): still materialized.
		u.Covered = limitCovered{Targets: targetsUnion(u.Covered.Targets, rec.Def.Targets).normalized(), Rank: max(u.Covered.Rank, limitModeRank(rec.Def.Mode))}
	}
	return nil
}

func (e *Engine) applyLimitDayClosed(ev *storeEvent) error {
	d, err := decode[LimitDayClosedData](ev)
	if err != nil {
		return err
	}
	if rec := e.limit(d.LimitID); rec != nil && rec.Usage.Day == d.Day {
		rec.Usage = freshLimitUsage(ev.Day, rec.Usage.CreditedUntil)
	}
	return nil
}
