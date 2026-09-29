package engine

// Attempts (docs/ARCHITECTURE.md §10.8, §8.8 «POST /v1/attempts», §9.5).
//
// Pipeline: covered? → allowance? → the ledger's attempt_detected (the Go port:
// points.ApplyLedgerInput with points.InputAttemptDetected on e.state.Ledger) → merged
// (no event; the dedupe window slides, so the new ledger state is kept) or counted (an
// attempt event whose recorded delta the batch derives). Detections come from the
// extension (domains, ext token), the desktop app's window titles (catalog service ids,
// app token) and the process watcher (procdetect.go, guardian-internal).

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
	"github.com/imdlodoem23/centrate/guardian/internal/points"
)

// Attempt layers (ATTEMPT_LAYERS in domain.ts).
const (
	LayerExtension = "extension"
	LayerWindow    = "window"
	LayerProcess   = "process"
)

// Attempt target types (AttemptTarget.type) and not-blocked reasons (AttemptResponse).
const (
	attemptTargetDomain  = "domain"
	attemptTargetService = "service"

	attemptReasonNotBlocked      = "not_blocked"
	attemptReasonAllowanceActive = "allowance_active"
)

// attemptsState is the persisted attempts state (state.json "engine.attempts"). It is
// empty: the dedupe window and the escalation live in the ledger, and the memo of the
// last counted attempt per key (e.lastCountKey) stays in memory, so the hosts in dom:
// keys never outlive a data deletion (the core resets the memo with every epoch).
type attemptsState struct{}

// attemptMemo is the last counted attempt of a dedupe key (answers merged detections
// with the attempt they merged into, §8.8). The attempt reducer records it, so a replay
// of the log rebuilds it; after a clean restart a merge within the dedupe window answers
// attemptId null and episodePointsDelta 0.
type attemptMemo struct {
	AttemptID   string
	PointsDelta int64
}

// AttemptTarget mirrors AttemptTarget: {type: "domain"|"service", value}.
type AttemptTarget struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

// AttemptRequest mirrors AttemptRequest.
type AttemptRequest struct {
	Layer     string        `json:"layer"`
	Target    AttemptTarget `json:"target"`
	Browser   *string       `json:"browser"`
	Incognito bool          `json:"incognito"`
}

// AttemptBlock is AttemptResponse.block.
type AttemptBlock struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Mode   string `json:"mode"`
	EndsAt string `json:"endsAt"`
	Reason string `json:"reason"`
}

// AttemptResponse mirrors AttemptResponse.
type AttemptResponse struct {
	Blocked            bool          `json:"blocked"`
	Counted            bool          `json:"counted"`
	Merged             bool          `json:"merged"`
	AttemptID          *string       `json:"attemptId"`
	PointsDelta        int64         `json:"pointsDelta"`
	EpisodePointsDelta int64         `json:"episodePointsDelta"`
	EscalationIndex    *int64        `json:"escalationIndex"`
	NextPenalty        int64         `json:"nextPenalty"`
	ServiceID          *string       `json:"serviceId"`
	Block              *AttemptBlock `json:"block"`
	Reason             *string       `json:"reason"`
}

// ReportAttempt is POST /v1/attempts. r.Scope is "app" (layer window, service ids) or
// "ext" (layer extension, domains); anything else is 403 insufficient_scope (§8.8). The
// engine checks the scope rules itself (the API layer may check them first).
func (e *Engine) ReportAttempt(ctx context.Context, r Request, req AttemptRequest) (AttemptResponse, error) {
	return run(e, ctx, cmdOpts{write: true}, func() (AttemptResponse, error) { return e.reportAttempt(r, req) })
}

// attemptDetection is one detection on its way through the pipeline.
type attemptDetection struct {
	Layer string
	// Key is the dedupe key (svc:, app:, dom: or proc:).
	Key string
	// ServiceID is the catalog service of the target ("" none).
	ServiceID string
	// Blocks are the active blocks that cover the target, in creation order.
	Blocks    []*blockRec
	Browser   *string
	Incognito bool
}

// attemptOutcome is what the pipeline did with a detection.
type attemptOutcome struct {
	// Reason is not_blocked or allowance_active when nothing was charged ("" otherwise).
	Reason  string
	Counted bool
	Merged  bool
	// AttemptID and Episode are the counted attempt (or the one a merge joined, when
	// still known) and its recorded delta; Points is what this detection charged.
	AttemptID string
	Points    int64
	Episode   int64
	Index     *int64
}

func (e *Engine) reportAttempt(r Request, req AttemptRequest) (AttemptResponse, error) {
	if err := e.validateAttempt(r.Scope, req); err != nil {
		return AttemptResponse{}, err
	}
	var d attemptDetection
	switch req.Target.Type {
	case attemptTargetDomain:
		host := req.Target.Value
		d = attemptDetection{Key: e.cat.DomainTargetKey(host), Blocks: e.blocksCoveringDomain(host)}
		if s := e.cat.FindServiceByDomain(host); s != nil {
			d.ServiceID = s.ID
		}
	default:
		if e.cat.Service(req.Target.Value) != nil {
			d = attemptDetection{Key: catalog.ServiceTargetKey(req.Target.Value), ServiceID: req.Target.Value,
				Blocks: e.blocksCoveringService(req.Target.Value)}
		}
	}
	d.Layer, d.Browser, d.Incognito = req.Layer, req.Browser, req.Incognito
	out, err := e.runAttempt(d)
	if err != nil {
		return AttemptResponse{}, err
	}
	return e.attemptResponse(d, out), nil
}

// validateAttempt checks the scope rules and the request shape (§8.8, attemptRequestSchema):
// the ext token may only send layer extension with a domain (hostname only), the app
// token layer window with a catalog service id; process is guardian-internal.
func (e *Engine) validateAttempt(scope string, req AttemptRequest) error {
	if req.Layer != LayerExtension && req.Layer != LayerWindow {
		if req.Layer == LayerProcess {
			return apiErr("insufficient_scope", "the process layer is guardian-internal", nil)
		}
		return issueErr("layer", "enum", "extension or window")
	}
	if req.Target.Type != attemptTargetDomain && req.Target.Type != attemptTargetService {
		return issueErr("target.type", "enum", "domain or service")
	}
	ok := (scope == scopeExt && req.Layer == LayerExtension && req.Target.Type == attemptTargetDomain) ||
		(scope == scopeApp && req.Layer == LayerWindow && req.Target.Type == attemptTargetService)
	if !ok {
		return apiErr("insufficient_scope", "the extension reports domains and the app reports services", nil)
	}
	v := req.Target.Value
	switch req.Target.Type {
	case attemptTargetDomain:
		if !catalog.IsValidDomain(v) {
			return issueErr("target.value", "invalid_domain", "canonical domain")
		}
	default:
		if len(v) < 1 || len(v) > 64 || !catalogIDRE.MatchString(v) {
			return issueErr("target.value", "pattern", "catalog service id")
		}
	}
	if req.Browser != nil && !e.isBrowserFamily(*req.Browser) {
		return issueErr("browser", "enum", "browser family")
	}
	return nil
}

// blocksCoveringDomain returns the active blocks that cover a host (§10.8, extension
// layer), in creation order: a non-whitelist block when the host equals or is under
// one of its resolved domains and is not under one of its excluded hosts; a whitelist
// block when its allow set does not allow the host. Always-allowed and protected hosts
// are never covered.
func (e *Engine) blocksCoveringDomain(host string) []*blockRec {
	if e.cat.IsAlwaysAllowedHost(host) || e.cat.IsProtectedDomain(host) {
		return nil
	}
	var out []*blockRec
	for _, b := range e.activeBlocks() {
		if b.WhitelistOnly {
			if b.WL != nil && !catalog.IsDomainAllowedInWhitelist(host, b.WL.Domains, b.WL.HostPatterns) {
				out = append(out, b)
			}
			continue
		}
		if underAnyDomain(host, b.Resolved.Domains) && !underAnyDomain(host, b.Resolved.ExcludedDomains) {
			out = append(out, b)
		}
	}
	return out
}

// blocksCoveringService returns the active blocks that cover a catalog service (§10.8,
// window layer), in creation order: a block that targets it (directly or through a
// category), or a whitelist block whose allow set does not allow it.
func (e *Engine) blocksCoveringService(id string) []*blockRec {
	svc := e.cat.Service(id)
	if svc == nil {
		return nil
	}
	var out []*blockRec
	for _, b := range e.activeBlocks() {
		if b.WhitelistOnly {
			if b.WL != nil && !e.serviceAllowedInWhitelist(svc.Domains, svc.AppIDs, b.WL) {
				out = append(out, b)
			}
			continue
		}
		if slices.Contains(b.Resolved.ServiceIDs, id) {
			out = append(out, b)
		}
	}
	return out
}

// serviceAllowedInWhitelist reports whether a whitelist allow set exempts a whole
// service: every domain allowed and every app process listed.
func (e *Engine) serviceAllowedInWhitelist(domains, appIDs []string, wl *whitelistSet) bool {
	for _, d := range domains {
		if !catalog.IsDomainAllowedInWhitelist(d, wl.Domains, wl.HostPatterns) {
			return false
		}
	}
	for _, aid := range appIDs {
		if a := e.cat.App(aid); a != nil {
			for _, p := range a.Processes.For(string(e.platform)) {
				if !containsProcess(wl.Processes, p, e.platform) {
					return false
				}
			}
		}
	}
	return true
}

// underAnyDomain reports whether host equals or is a subdomain of an entry.
func underAnyDomain(host string, list []string) bool {
	return slices.ContainsFunc(list, func(d string) bool { return catalog.IsSameOrSubdomain(host, d) })
}

// runAttempt is the pipeline of §10.8 for one detection of any layer.
func (e *Engine) runAttempt(d attemptDetection) (attemptOutcome, error) {
	if len(d.Blocks) == 0 {
		return attemptOutcome{Reason: attemptReasonNotBlocked}, nil
	}
	if d.ServiceID != "" && slices.Contains(e.activeAllowanceServiceIDs(), d.ServiceID) {
		return attemptOutcome{Reason: attemptReasonAllowanceActive}, nil
	}
	rules := points.DefaultPointRules()
	e.pruneAttemptMemos(rules)
	penalized := e.state.Settings.AttemptPenalties
	step := points.ApplyLedgerInput(e.state.Ledger, points.LedgerInput{
		Type: points.InputAttemptDetected, AtMs: e.now, Day: e.localDay(e.now), Key: d.Key, Penalized: penalized,
	}, rules)
	if step.Outcome.Merged != nil && *step.Outcome.Merged {
		// The dedupe window slides with every detection (no event, §10.8).
		e.state.Ledger = step.State
		e.markDirty(false)
		out := attemptOutcome{Merged: true}
		if m, ok := e.lastCountKey[d.Key]; ok {
			out.AttemptID, out.Episode = m.AttemptID, m.PointsDelta
		}
		return out, nil
	}
	index := int64(0)
	if step.Outcome.EscalationIndex != nil {
		index = *step.Outcome.EscalationIndex
	}
	ids := make([]string, len(d.Blocks))
	for i, b := range d.Blocks {
		ids[i] = b.ID
	}
	data := AttemptData{
		AttemptID:       newID("att"),
		Layer:           d.Layer,
		TargetKey:       d.Key,
		TargetType:      attemptTargetType(d.Key),
		ServiceID:       strPtrOrNil(d.ServiceID),
		BlockIDs:        ids,
		Browser:         d.Browser,
		Incognito:       d.Incognito,
		EscalationIndex: index,
		Penalized:       penalized,
	}
	b := e.newBatch()
	pts := b.add(EvAttempt, data)
	if err := e.commit(b); err != nil {
		return attemptOutcome{}, err
	}
	return attemptOutcome{Counted: true, AttemptID: data.AttemptID, Points: pts, Episode: pts, Index: &index}, nil
}

// attemptTargetType is attempt.targetType: the kind of the dedupe key.
func attemptTargetType(key string) string {
	switch {
	case strings.HasPrefix(key, "svc:"):
		return "service"
	case strings.HasPrefix(key, "app:"):
		return "app"
	case strings.HasPrefix(key, "dom:"):
		return "domain"
	}
	return "process"
}

// pruneAttemptMemos forgets the memos of keys that left the ledger's dedupe window.
func (e *Engine) pruneAttemptMemos(rules points.PointRules) {
	win := int64(rules.AttemptDedupeWindowMs)
	for k := range e.lastCountKey {
		at, ok := e.state.Ledger.Dedupe[k]
		if !ok || e.now-at >= win || e.now < at {
			delete(e.lastCountKey, k)
		}
	}
}

// nextAttemptPenalty is what a new counted attempt would cost right now (0 with
// penalties off).
func (e *Engine) nextAttemptPenalty() int64 {
	if !e.state.Settings.AttemptPenalties {
		return 0
	}
	rules := points.DefaultPointRules()
	return points.AttemptPenalty(points.NextEscalationIndex(e.state.Ledger.Escalation, e.now, rules), rules)
}

// attemptResponse builds AttemptResponse after the pipeline (and its commit).
func (e *Engine) attemptResponse(d attemptDetection, out attemptOutcome) AttemptResponse {
	res := AttemptResponse{
		ServiceID:   strPtrOrNil(d.ServiceID),
		NextPenalty: e.nextAttemptPenalty(),
	}
	if out.Reason != "" {
		res.Reason = ptr(out.Reason)
		return res
	}
	res.Blocked, res.Counted, res.Merged = true, out.Counted, out.Merged
	res.AttemptID = strPtrOrNil(out.AttemptID)
	res.PointsDelta, res.EpisodePointsDelta, res.EscalationIndex = out.Points, out.Episode, out.Index
	if b := latestEndingBlock(d.Blocks); b != nil {
		res.Block = &AttemptBlock{ID: b.ID, Kind: b.Kind, Mode: b.Mode, EndsAt: e.display(b.EndsAt), Reason: b.Reason}
	}
	return res
}

// latestEndingBlock is the covering block with the latest endsAt (ties: the most
// recently created): when access actually returns (§8.8).
func latestEndingBlock(blocks []*blockRec) *blockRec {
	var best *blockRec
	for _, b := range blocks {
		if best == nil || b.EndsAt > best.EndsAt || (b.EndsAt == best.EndsAt && b.Rank > best.Rank) {
			best = b
		}
	}
	return best
}

// ---------------------------------------------------------------------------------------
// Hooks the core calls
// ---------------------------------------------------------------------------------------

// processAttempt handles a process detection outside the grace cases (procdetect.go):
// layer process, key e.processKey(d.Name), covering blocks d.Blocks.
func (e *Engine) processAttempt(d processDetection) {
	name := d.Name
	if name == "" {
		name = d.Target
	}
	det := attemptDetection{Layer: LayerProcess, Key: e.processKey(name), ServiceID: d.ServiceID, Blocks: d.Blocks}
	if _, err := e.runAttempt(det); err != nil {
		e.log.Warn("process attempt not committed", "err", err)
	}
}

// applyAttempt is the reducer of attempt: every covering block's attemptsCounted and the
// active study session's attempts increase; the key's memo answers later merges.
func (e *Engine) applyAttempt(ev *storeEvent) error {
	d, err := decode[AttemptData](ev)
	if err != nil {
		return err
	}
	for _, id := range d.BlockIDs {
		if b := e.block(id); b != nil {
			b.AttemptsCounted++
		}
	}
	e.studyNoteAttempt(ev.Points)
	if d.TargetKey == "" {
		return fmt.Errorf("seq %d: attempt without a target key", ev.Seq)
	}
	if e.lastCountKey == nil {
		e.lastCountKey = map[string]attemptMemo{}
	}
	e.lastCountKey[d.TargetKey] = attemptMemo{AttemptID: d.AttemptID, PointsDelta: ev.Points}
	return nil
}
