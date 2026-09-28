package engine

// OWNER: data deletion teammate (docs/ARCHITECTURE.md §10.11, §8.8 «POST
// /v1/data/delete»).
//
// «Borrar todos mis datos» starts a new epoch (data_deleted) in one batch. What must
// survive travels in epoch_started, so the new epoch is rebuildable from its own events
// and nothing is re-charged: a negative balance (carry = min(0, balance)), the attempt
// escalation, the active blocks, punishments and allowances, the schedules in progress or
// inside the pre-start freeze, the materialized occurrence keys, the anti-cheat settings
// with their pending changes (no instant weakening) and the paired extensions. The study
// whitelist extras and their pending changes are dropped (they hold the user's own
// domains). Everything else is deleted: the old epoch's segments, quarantine/*,
// backups/state.v*.json (the store does these in NewEpoch), the idempotency cache, the
// Céntrate section of the rotating hosts backups and the guardian logs (through the
// optional interfaces below); state.prev.json is rewritten equal to the new state.

import (
	"context"
	"strings"

	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// ddConfirmMaxLen is the length cap of deleteDataRequestSchema.confirm.
const ddConfirmMaxLen = 16

// HostsBackupScrubber is implemented by a hosts layer that can strip the Céntrate section
// from its rotating backups (backups/hosts.bak*), which a data deletion requires (§10.11
// step 3: they list the domains the user blocked). The live section is re-rendered by
// the next reconcile anyway.
type HostsBackupScrubber interface {
	ScrubBackups() error
}

// LogPurger is implemented by the slog.Handler of Options.Logger when the guardian logs
// can be deleted (§10.11 step 3). They never hold personal data (logx), but a deletion
// starts them afresh.
type LogPurger interface {
	PurgeLogs() error
}

// DeleteDataRequest mirrors DeleteDataRequest.
type DeleteDataRequest struct {
	Confirm string `json:"confirm"`
}

// DeleteDataResponse mirrors DeleteDataResponse.
type DeleteDataResponse struct {
	Epoch             string   `json:"epoch"`
	CarryOverBalance  int64    `json:"carryOverBalance"`
	KeptBlockIDs      []string `json:"keptBlockIds"`
	KeptPunishmentIDs []string `json:"keptPunishmentIds"`
	KeptScheduleIDs   []string `json:"keptScheduleIds"`
}

// DeleteData is POST /v1/data/delete (idempotent).
func (e *Engine) DeleteData(ctx context.Context, r Request, req DeleteDataRequest) (DeleteDataResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem, status: 200}, func() (DeleteDataResponse, error) {
		return e.deleteData(req)
	})
}

func (e *Engine) deleteData(req DeleteDataRequest) (DeleteDataResponse, error) {
	if err := ddCheckConfirm(req.Confirm); err != nil {
		return DeleteDataResponse{}, err
	}
	switch {
	case e.studyActive():
		return DeleteDataResponse{}, ddBlocked("study_active")
	case e.emergencyPending():
		return DeleteDataResponse{}, ddBlocked("emergency_pending")
	case len(e.state.Clock.Unverified) > 0:
		// Deleting would erase the evidence resurrection needs (§10.2).
		return DeleteDataResponse{}, ddBlocked("clock_unverified")
	}

	carry := min(0, e.state.Ledger.Balance)
	esc := escalationWire(e.state.Ledger.Escalation)
	kept := e.keptNow(true)
	kept.Settings.StudyWhitelist = embedded.StudyWhitelistSettings{ExtraDomains: []string{}, ExtraProcesses: []string{}}
	var prev *string
	if e.state.Epoch != "" {
		prev = ptr(e.state.Epoch)
	}
	if err := e.startEpoch(store.EpochDataDeleted, prev, carry, esc, kept, nil); err != nil {
		e.countError("data_delete")
		e.log.Error("data deletion: new epoch not started", "err", err)
		return DeleteDataResponse{}, storeWriteErr(err)
	}
	// The idempotency cache goes with the old epoch (this request's response is stored
	// again when the turn ends, so a retry still replays it).
	e.idem = nil
	e.ddScrub()
	if err := e.saveStateAll(); err != nil {
		// The epoch is started and applied; the next save rewrites state.json.
		e.countError("state_save")
		e.log.Warn("data deletion: state files not rewritten", "err", err)
	}

	res := DeleteDataResponse{
		Epoch: e.state.Epoch, CarryOverBalance: carry,
		KeptBlockIDs: []string{}, KeptPunishmentIDs: []string{}, KeptScheduleIDs: []string{},
	}
	for _, b := range kept.Blocks {
		res.KeptBlockIDs = append(res.KeptBlockIDs, b.ID)
	}
	for _, p := range kept.Punishments {
		res.KeptPunishmentIDs = append(res.KeptPunishmentIDs, p.ID)
	}
	for _, s := range kept.Schedules {
		res.KeptScheduleIDs = append(res.KeptScheduleIDs, s.ID)
	}
	return res, nil
}

// ddCheckConfirm validates the confirmation word: the request shape (1–16 UTF-16 units,
// no control characters: 422 validation_failed), then DATA_DELETE_CONFIRM_WORDS, trimmed
// and case-insensitive (422 confirm_word_mismatch).
func ddCheckConfirm(word string) *APIError {
	if n := catalog.UTF16Len(word); n < 1 || n > ddConfirmMaxLen {
		return issueErr("confirm", "length", "length in [1, 16]")
	}
	if strings.ContainsFunc(word, ddUnsafeRune) {
		return issueErr("confirm", "pattern", "control characters")
	}
	w := strings.TrimSpace(word)
	for _, ok := range embedded.API().DataDeleteConfirmWords {
		if strings.EqualFold(w, ok) {
			return nil
		}
	}
	return apiErr("confirm_word_mismatch", "type the confirmation word to delete your data", nil)
}

// ddUnsafeRune is UNSAFE_TEXT_RE of guardian-api.ts (control characters, bidi overrides
// and isolates).
func ddUnsafeRune(r rune) bool {
	return r <= 0x1F || (r >= 0x7F && r <= 0x9F) || (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069)
}

// ddBlocked is 409 data_delete_blocked with details.reason.
func ddBlocked(reason string) *APIError {
	return apiErr("data_delete_blocked", "data cannot be deleted right now", map[string]any{"reason": reason})
}

// ddScrub removes the copies outside the store (§10.11 step 3): the Céntrate section of
// the hosts backups and the guardian logs. Failures are logged (codes only) and never
// undo the deletion.
func (e *Engine) ddScrub() {
	if s, ok := e.o.Hosts.(HostsBackupScrubber); ok {
		if err := s.ScrubBackups(); err != nil {
			e.countError("data_delete_hosts_backups")
			e.log.Warn("data deletion: hosts backups not scrubbed", "err", err)
		}
	}
	e.enfDirty = true // the live section is re-rendered from the kept blocks
	if p, ok := e.log.Handler().(LogPurger); ok {
		if err := p.PurgeLogs(); err != nil {
			e.countError("data_delete_logs")
			e.log.Warn("data deletion: logs not purged", "err", err)
		}
	}
}
