package engine

import (
	"context"
	"encoding/base64"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
	"github.com/imdlodoem23/centrate/guardian/internal/points"
)

// Blocks (§5.2, §8.8, §10.9): creation, extension, reads, crediting, completion, and
// the helpers the feature files use to create schedule and punishment blocks and to
// cancel blocks.

// block returns the block with that id, or nil.
func (e *Engine) block(id string) *blockRec {
	for _, b := range e.state.Blocks {
		if b.ID == id {
			return b
		}
	}
	return nil
}

// activeBlocks returns the active blocks in creation order.
func (e *Engine) activeBlocks() []*blockRec {
	out := make([]*blockRec, 0, len(e.state.Blocks))
	for _, b := range e.state.Blocks {
		if b.Status == StatusActive {
			out = append(out, b)
		}
	}
	return out
}

// hasActiveBlocks reports whether any block is active.
func (e *Engine) hasActiveBlocks() bool {
	return slices.ContainsFunc(e.state.Blocks, func(b *blockRec) bool { return b.Status == StatusActive })
}

// blockWire converts a block to its wire form with timestamps shifted by offsetMs: the
// wall offset for API responses (display time), 0 inside events (trusted time).
func (e *Engine) blockWire(b *blockRec, offsetMs int64) Block {
	at := func(ms int64) string { return fmtMs(ms + offsetMs) }
	w := Block{
		ID:              b.ID,
		Kind:            b.Kind,
		Mode:            b.Mode,
		Status:          b.Status,
		Targets:         b.Targets.normalized(),
		WhitelistOnly:   b.WhitelistOnly,
		Allow:           b.Allow.normalized(),
		Reason:          b.Reason,
		CreatedAt:       at(b.CreatedAt),
		StartsAt:        at(b.StartsAt),
		EndsAt:          at(b.EndsAt),
		OriginalEndsAt:  at(b.OriginalEndsAt),
		ExtendedMinutes: b.ExtendedMinutes,
		ScheduleID:      b.ScheduleID,
		PunishmentID:    b.PunishmentID,
		AttemptsCounted: b.AttemptsCounted,
		PointsDelta:     b.PointsDelta,
	}
	if b.EndedAt != nil {
		w.EndedAt = ptr(at(*b.EndedAt))
	}
	w.EmergencyEligible = b.Status == StatusActive && points.IsEmergencyEligibleMode(b.Mode) && !e.blockInPendingEmergency(b.ID)
	return w
}

// displayBlock is blockWire in display time.
func (e *Engine) displayBlock(b *blockRec) Block { return e.blockWire(b, e.wallOffsetMs()) }

// blockSpec describes a block to create (trusted times).
type blockSpec struct {
	Kind          string
	Mode          string
	Targets       TargetSpec
	WhitelistOnly bool
	Allow         WhitelistAllow
	Reason        string
	StartsAt      int64
	EndsAt        int64
	ScheduleID    *string
	PunishmentID  *string
}

// newBlockSnapshot builds the trusted-time Block of block_created with a new id.
func (e *Engine) newBlockSnapshot(s blockSpec) Block {
	return Block{
		ID:                newID("blk"),
		Kind:              s.Kind,
		Mode:              s.Mode,
		Status:            StatusActive,
		Targets:           s.Targets.normalized(),
		WhitelistOnly:     s.WhitelistOnly,
		Allow:             s.Allow.normalized(),
		Reason:            s.Reason,
		CreatedAt:         fmtMs(e.now),
		StartsAt:          fmtMs(s.StartsAt),
		EndsAt:            fmtMs(s.EndsAt),
		OriginalEndsAt:    fmtMs(s.EndsAt),
		ScheduleID:        s.ScheduleID,
		PunishmentID:      s.PunishmentID,
		EmergencyEligible: points.IsEmergencyEligibleMode(s.Mode),
	}
}

// addBlockCreated adds block_created (source user, schedule or punishment) and, for a
// hardcore or exam block, the revocation of every active allowance (§10.7). Guardian
// sources are never refused for budgets (§5.2).
func (e *Engine) addBlockCreated(b *batch, blk Block, source string) {
	b.add(EvBlockCreated, BlockCreatedData{Block: blk, Source: source})
	if blk.Mode == ModeHardcore || blk.Mode == ModeExam {
		e.addRevokeAllowances(b, blk.ID)
	}
}

// addPunishmentEvents adds the punishment batch tail of §10.5: a strict block of kind
// punishment (every distraction category for distractions and nuclear, the study
// whitelist for whitelist), punishment_started (−100) and the revocation of every
// active allowance. The punishment snapshots the session's task. It returns both
// snapshots (trusted time).
func (e *Engine) addPunishmentEvents(b *batch, sessionID *string, task, cause string, pol PunishmentPolicy) (Block, Punishment) {
	pid := newID("pun")
	spec := blockSpec{
		Kind:         KindPunishment,
		Mode:         ModeStrict,
		Targets:      emptyTargets(),
		Allow:        emptyAllow(),
		StartsAt:     b.at,
		EndsAt:       b.at + int64(pol.Minutes)*msPerMinute,
		PunishmentID: &pid,
	}
	if pol.Level == "whitelist" {
		spec.WhitelistOnly = true
	} else {
		spec.Targets.CategoryIDs = e.cat.CategoryIDs()
	}
	blk := e.newBlockSnapshot(spec)
	pun := Punishment{
		ID: pid, BlockID: blk.ID, SessionID: sessionID, Task: task, Cause: cause, Level: pol.Level,
		Minutes: int64(pol.Minutes), StartsAt: blk.StartsAt, EndsAt: blk.EndsAt, Status: StatusActive,
	}
	b.add(EvBlockCreated, BlockCreatedData{Block: blk, Source: "punishment"})
	b.add(EvPunishmentStarted, PunishmentStartedData{Punishment: pun})
	e.addRevokeAllowances(b, blk.ID)
	return blk, pun
}

// addBlockCancelled adds block_cancelled for an active block an emergency confirmed
// (§10.6) and punishment_ended{emergency} when it enforces a punishment.
func (e *Engine) addBlockCancelled(b *batch, rec *blockRec, emergencyID string) {
	forfeited := max(0, ceilDiv(rec.EndsAt-b.at, msPerMinute))
	b.add(EvBlockCancelled, BlockCancelledData{BlockID: rec.ID, EmergencyID: emergencyID, ForfeitedMinutes: forfeited})
	if rec.Kind == KindPunishment && rec.PunishmentID != nil {
		b.add(EvPunishmentEnded, PunishmentEndedData{PunishmentID: *rec.PunishmentID, BlockID: rec.ID, Outcome: "emergency"})
	}
}

// resolveBlock fixes what a block enforces on this OS (§5.2): the catalog resolution of
// its targets, or the whitelist allow set snapshot.
func (e *Engine) resolveBlock(rec *blockRec) {
	if rec.WhitelistOnly {
		rec.Resolved = resolvedTargets{Domains: []string{}, ExcludedDomains: []string{}, Processes: []string{}, ServiceIDs: []string{}}
		rec.WL = e.whitelistSnapshot(rec.Allow)
		return
	}
	t := rec.Targets
	if rec.Kind == KindRecovered {
		// The section's exact hosts (already expanded when they were written).
		rec.Resolved = resolvedTargets{Domains: sortedUnique(t.CustomDomains), ExcludedDomains: []string{}, Processes: []string{}, ServiceIDs: []string{}}
		rec.WL = nil
		return
	}
	r := e.cat.ResolveTargets(catalog.Selection{
		ServiceIDs:   t.ServiceIDs,
		CategoryIDs:  t.CategoryIDs,
		Domains:      t.CustomDomains,
		AppIDs:       t.AppIDs,
		ProcessNames: t.CustomProcesses,
	}, e.platform)
	svc := slices.Clone(t.ServiceIDs)
	for _, c := range t.CategoryIDs {
		for _, s := range e.cat.ServicesInCategory(c) {
			svc = append(svc, s.ID)
		}
	}
	slices.Sort(svc)
	rec.Resolved = resolvedTargets{
		Domains:         r.Domains,
		ExcludedDomains: r.ExcludedDomains,
		Processes:       r.Processes,
		ServiceIDs:      slices.Compact(svc),
	}
	rec.WL = nil
}

// whitelistSnapshot is the allow set of a new whitelist-only block (§5.2): the catalog
// study whitelist, settings.studyWhitelist and allow, each entry re-checked against the
// embedded catalog (offending entries are dropped), plus the always-allowed hosts.
func (e *Engine) whitelistSnapshot(allow WhitelistAllow) *whitelistSet {
	ok := func(domains, procs []string) bool {
		return e.cat.FindAllowDistraction(catalog.AllowEntries{Domains: domains, Processes: procs},
			catalog.AllowPaths{Domains: "d", Processes: "p"}, e.platform) == nil
	}
	sw := e.state.Settings.StudyWhitelist
	var domains []string
	for _, list := range [][]string{e.cat.StudyWhitelistDomains(), sw.ExtraDomains, allow.CustomDomains} {
		for _, d := range list {
			if ok([]string{d}, nil) {
				domains = append(domains, d)
			}
		}
	}
	domains = append(domains, e.cat.AlwaysAllowedHosts()...)
	var procs []string
	for _, list := range [][]string{e.cat.StudyWhitelistProcesses(e.platform), sw.ExtraProcesses, allow.CustomProcesses} {
		for _, p := range list {
			if ok(nil, []string{p}) {
				procs = append(procs, p)
			}
		}
	}
	return &whitelistSet{
		Domains:      sortedUnique(domains),
		HostPatterns: e.cat.StudyWhitelistHostPatterns(),
		Processes:    sortedUnique(procs),
	}
}

func sortedUnique(s []string) []string {
	out := slices.Clone(s)
	if out == nil {
		out = []string{}
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

// CreateBlock is POST /v1/blocks (idempotent, 201).
func (e *Engine) CreateBlock(ctx context.Context, r Request, req CreateBlockRequest) (CreateBlockResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem, status: 201}, func() (CreateBlockResponse, error) {
		return e.createBlock(req)
	})
}

func (e *Engine) createBlock(req CreateBlockRequest) (CreateBlockResponse, error) {
	endsAt, err := e.validateCreateBlock(&req)
	if err != nil {
		return CreateBlockResponse{}, err
	}
	b := e.newBatch()
	blk := e.newBlockSnapshot(blockSpec{
		Kind:          KindManual,
		Mode:          req.Mode,
		Targets:       req.Targets,
		WhitelistOnly: req.WhitelistOnly,
		Allow:         req.Allow,
		Reason:        req.Reason,
		StartsAt:      e.now,
		EndsAt:        endsAt,
	})
	e.addBlockCreated(b, blk, "user")
	if err := e.commit(b); err != nil {
		return CreateBlockResponse{}, err
	}
	rec := e.block(blk.ID)
	return CreateBlockResponse{Block: e.displayBlock(rec), StateVersion: e.state.Versions.State}, nil
}

// ExtendBlock is POST /v1/blocks/{id}/extend (idempotent): never shortens (§8.8).
func (e *Engine) ExtendBlock(ctx context.Context, r Request, id string, req ExtendBlockRequest) (ExtendBlockResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem, status: 200}, func() (ExtendBlockResponse, error) {
		return e.extendBlock(id, req)
	})
}

func (e *Engine) extendBlock(id string, req ExtendBlockRequest) (ExtendBlockResponse, error) {
	l := limits()
	if req.AddMinutes < 1 || req.AddMinutes > int64(l.ExtendMaxAddMinutes) {
		return ExtendBlockResponse{}, issueErr("addMinutes", "range", fmt.Sprintf("integer in [1, %d]", l.ExtendMaxAddMinutes))
	}
	rec := e.block(id)
	if rec == nil {
		return ExtendBlockResponse{}, notFound("block")
	}
	if rec.Status != StatusActive {
		return ExtendBlockResponse{}, apiErr("block_not_active", "the block already ended", map[string]any{"status": rec.Status})
	}
	if rec.Kind == KindPunishment {
		return ExtendBlockResponse{}, apiErr("not_extendable", "punishment blocks cannot be extended", nil)
	}
	maxMs := int64(l.BlockMaxMinutes) * msPerMinute
	newEnds := rec.EndsAt + req.AddMinutes*msPerMinute
	if newEnds-e.now > maxMs {
		maxAdd := max(0, (e.now+maxMs-rec.EndsAt)/msPerMinute)
		return ExtendBlockResponse{}, apiErr("extension_exceeds_max", "a block cannot last more than its maximum from now",
			map[string]any{"maxAddMinutes": maxAdd})
	}
	b := e.newBatch()
	b.add(EvBlockExtended, BlockExtendedData{BlockID: rec.ID, AddMinutes: req.AddMinutes, EndsAt: fmtMs(newEnds)})
	if err := e.commit(b); err != nil {
		return ExtendBlockResponse{}, err
	}
	return ExtendBlockResponse{Block: e.displayBlock(rec), StateVersion: e.state.Versions.State}, nil
}

// ListBlocks is GET /v1/blocks.
func (e *Engine) ListBlocks(ctx context.Context, q ListBlocksQuery) (ListBlocksResponse, error) {
	return run(e, ctx, cmdOpts{}, func() (ListBlocksResponse, error) { return e.listBlocks(q) })
}

func badQuery(msg string) *APIError { return apiErr("bad_query", msg, nil) }

func (e *Engine) listBlocks(q ListBlocksQuery) (ListBlocksResponse, error) {
	switch q.Status {
	case "", StatusActive:
		// Every active block, always (limit is accepted and ignored; a cursor is not).
		if q.Cursor != "" || q.Limit < 0 || q.Limit > limits().BlocksPageMax {
			return ListBlocksResponse{}, badQuery("a cursor only applies to status=ended")
		}
		out := []Block{}
		for _, b := range e.sortedActive() {
			out = append(out, e.displayBlock(b))
		}
		return ListBlocksResponse{Blocks: out}, nil
	case "ended":
	default:
		return ListBlocksResponse{}, badQuery("status must be active or ended")
	}
	limit := q.Limit
	if limit == 0 {
		limit = blocksPageDefault
	}
	if limit < 1 || limit > limits().BlocksPageMax {
		return ListBlocksResponse{}, badQuery("limit out of range")
	}
	var afterMs int64
	var afterID string
	if q.Cursor != "" {
		var ok bool
		if afterMs, afterID, ok = decodeBlockCursor(q.Cursor); !ok {
			return ListBlocksResponse{}, badQuery("invalid cursor")
		}
	}
	var ended []*blockRec
	for _, b := range e.state.Blocks {
		if b.Status != StatusActive && b.EndedAt != nil && *b.EndedAt >= e.now-endedBlocksHistoryMs {
			ended = append(ended, b)
		}
	}
	slices.SortFunc(ended, func(a, b *blockRec) int {
		if *a.EndedAt != *b.EndedAt {
			if *a.EndedAt > *b.EndedAt {
				return -1
			}
			return 1
		}
		return -strings.Compare(a.ID, b.ID)
	})
	out := []Block{}
	var next *string
	for _, b := range ended {
		if q.Cursor != "" && (*b.EndedAt > afterMs || (*b.EndedAt == afterMs && b.ID >= afterID)) {
			continue
		}
		if len(out) == limit {
			last := out[len(out)-1]
			c := encodeBlockCursor(e.block(last.ID))
			next = &c
			break
		}
		out = append(out, e.displayBlock(b))
	}
	return ListBlocksResponse{Blocks: out, NextCursor: next}, nil
}

func encodeBlockCursor(b *blockRec) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(*b.EndedAt, 10) + ":" + b.ID))
}

func decodeBlockCursor(c string) (int64, string, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil {
		return 0, "", false
	}
	ms, id, ok := strings.Cut(string(raw), ":")
	if !ok || !strings.HasPrefix(id, "blk_") {
		return 0, "", false
	}
	n, err := strconv.ParseInt(ms, 10, 64)
	if err != nil {
		return 0, "", false
	}
	return n, id, true
}

// sortedActive returns the active blocks by endsAt descending (ties: the most recently
// created first), the order of /v1/state.blocks: blocks[0] drives the big countdown.
func (e *Engine) sortedActive() []*blockRec {
	out := e.activeBlocks()
	slices.SortStableFunc(out, func(a, b *blockRec) int {
		if a.EndsAt != b.EndsAt {
			if a.EndsAt > b.EndsAt {
				return -1
			}
			return 1
		}
		return int(b.Rank - a.Rank)
	})
	return out
}

// GetBlock is GET /v1/blocks/{id}.
func (e *Engine) GetBlock(ctx context.Context, id string) (GetBlockResponse, error) {
	return run(e, ctx, cmdOpts{}, func() (GetBlockResponse, error) {
		rec := e.block(id)
		if rec == nil {
			return GetBlockResponse{}, notFound("block")
		}
		return GetBlockResponse{
			Block: e.displayBlock(rec),
			Progress: BlockProgress{
				CreditedMinutes: points.BlockCreditedMinutes(rec.CreditedMs, rec.StartsAt, rec.EndsAt),
				DowntimeMs:      rec.DowntimeMs,
			},
		}, nil
	})
}

// ---------------------------------------------------------------------------------------
// Time-driven
// ---------------------------------------------------------------------------------------

// creditBlocks credits the awake share of the tick [prevT, T] (§10.9): every instant
// goes to one earning block at most (the earliest-ending one; ties: earliest created),
// never to a block while an allowance opens part of it, never while suspended or down.
func (e *Engine) creditBlocks(prevT, T, awakeMs int64) {
	if T <= prevT || awakeMs <= 0 {
		return
	}
	rules := points.DefaultPointRules()
	allowed := e.activeAllowanceServiceIDs()
	var recs []*blockRec
	var cands []points.CreditCandidate
	for _, b := range e.state.Blocks {
		if b.Status != StatusActive || !points.IsEarningBlockKind(b.Kind, rules) {
			continue
		}
		if b.EndsAt <= prevT || b.StartsAt >= T {
			continue
		}
		if len(allowed) > 0 && (b.WhitelistOnly || slices.ContainsFunc(b.Resolved.ServiceIDs, func(id string) bool { return slices.Contains(allowed, id) })) {
			continue
		}
		recs = append(recs, b)
		cands = append(cands, points.CreditCandidate{StartsAtMs: b.StartsAt, EndsAtMs: b.EndsAt, Rank: b.Rank})
	}
	if len(cands) == 0 {
		return
	}
	for i, ms := range points.SplitTickCredit(prevT, T, awakeMs, cands) {
		recs[i].CreditedMs += ms
	}
}

// completeBlocks completes every active block whose end passed (§10.9), honouring the
// boot hold (§10.2): endedAt is the scheduled end, creditedMinutes what it was credited;
// a punishment block also ends its punishment. One batch per block.
func (e *Engine) completeBlocks(T int64) {
	due := []*blockRec{}
	for _, b := range e.state.Blocks {
		if b.Status == StatusActive && T >= b.EndsAt && !e.held(b) {
			due = append(due, b)
		}
	}
	slices.SortFunc(due, func(a, b *blockRec) int {
		if a.EndsAt != b.EndsAt {
			if a.EndsAt < b.EndsAt {
				return -1
			}
			return 1
		}
		return int(a.Rank - b.Rank)
	})
	for _, rec := range due {
		b := e.newBatch()
		b.add(EvBlockCompleted, BlockCompletedData{
			BlockID:         rec.ID,
			Kind:            rec.Kind,
			Mode:            rec.Mode,
			CreditedMinutes: points.BlockCreditedMinutes(rec.CreditedMs, rec.StartsAt, rec.EndsAt),
			AttemptsCounted: rec.AttemptsCounted,
			DowntimeMs:      rec.DowntimeMs,
			ClockTrust:      e.trust(),
		})
		if rec.Kind == KindPunishment && rec.PunishmentID != nil {
			b.add(EvPunishmentEnded, PunishmentEndedData{PunishmentID: *rec.PunishmentID, BlockID: rec.ID, Outcome: StatusCompleted})
		}
		if !e.commitNow(b, "block completion") {
			return
		}
	}
}

// pruneHistory forgets ended blocks and punishments older than the history window and
// counters older than a day.
func (e *Engine) pruneHistory(T int64) {
	cut := T - endedBlocksHistoryMs
	e.state.Blocks = slices.DeleteFunc(e.state.Blocks, func(b *blockRec) bool {
		return b.Status != StatusActive && b.EndedAt != nil && *b.EndedAt < cut
	})
	e.state.Punishments = slices.DeleteFunc(e.state.Punishments, func(p *punishmentRec) bool {
		return p.Status != StatusActive && p.EndedAt != nil && *p.EndedAt < cut
	})
	day := T - jumpsWindowMs
	old := func(ms int64) bool { return ms < day }
	e.state.Clock.Jumps = slices.DeleteFunc(e.state.Clock.Jumps, old)
	e.kills = slices.DeleteFunc(e.kills, old)
	e.tampers = slices.DeleteFunc(e.tampers, old)
}

// recentEndedBlocks is /v1/state.recent.endedBlocks (ended in the last 2 min).
func (e *Engine) recentEndedBlocks() []EndedBlockNotice {
	out := []EndedBlockNotice{}
	win := int64(limits().RecentEndedBlocksMs)
	for _, b := range e.state.Blocks {
		if b.Status == StatusActive || b.EndedAt == nil || *b.EndedAt < e.now-win {
			continue
		}
		var pts int64
		if b.PointsDelta != nil {
			pts = *b.PointsDelta
		}
		out = append(out, EndedBlockNotice{ID: b.ID, Kind: b.Kind, Mode: b.Mode, Outcome: b.Status, EndedAt: e.display(*b.EndedAt), PointsDelta: pts})
	}
	return out
}

// punishment returns the punishment with that id, or nil.
func (e *Engine) punishment(id string) *punishmentRec {
	for _, p := range e.state.Punishments {
		if p.ID == id {
			return p
		}
	}
	return nil
}

// punishmentWire converts a punishment (offsetMs as in blockWire).
func punishmentWire(p *punishmentRec, offsetMs int64) Punishment {
	w := Punishment{
		ID: p.ID, BlockID: p.BlockID, SessionID: p.SessionID, Task: p.Task, Cause: p.Cause, Level: p.Level,
		Minutes: p.Minutes, StartsAt: fmtMs(p.StartsAt + offsetMs), EndsAt: fmtMs(p.EndsAt + offsetMs), Status: p.Status,
	}
	if p.EndedAt != nil {
		w.EndedAt = ptr(fmtMs(*p.EndedAt + offsetMs))
	}
	return w
}

// activePunishments returns the active punishments by endsAt descending.
func (e *Engine) activePunishments() []*punishmentRec {
	var out []*punishmentRec
	for _, p := range e.state.Punishments {
		if p.Status == StatusActive {
			out = append(out, p)
		}
	}
	slices.SortStableFunc(out, func(a, b *punishmentRec) int {
		switch {
		case a.EndsAt > b.EndsAt:
			return -1
		case a.EndsAt < b.EndsAt:
			return 1
		}
		return 0
	})
	return out
}

// nuclearActive is true while any active punishment has level nuclear.
func (e *Engine) nuclearActive() bool {
	return slices.ContainsFunc(e.state.Punishments, func(p *punishmentRec) bool {
		return p.Status == StatusActive && p.Level == "nuclear"
	})
}
