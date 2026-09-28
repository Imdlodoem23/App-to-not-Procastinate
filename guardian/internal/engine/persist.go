package engine

import (
	"bytes"
	"errors"
	"slices"

	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// Persistence (§11.3 step 8): state.json with the engine state, the enforcement core and
// the idempotency records; the rollback anchor; idempotent replays (§8.6).

// errCriticalPending: state.json waits for the critical startup batch.
var errCriticalPending = errors.New("engine: startup evidence not logged yet")

// saveState writes state.json now (SaveState keeps state.prev.json).
func (e *Engine) saveState() error { return e.saveStateWith(e.st.SaveState) }

// saveStateAll writes both generations (data deletion, §10.11 step 3).
func (e *Engine) saveStateAll() error { return e.saveStateWith(e.st.SaveStateAll) }

func (e *Engine) saveStateWith(save func(store.StateSnapshot) error) error {
	if e.criticalHeld() {
		return errCriticalPending
	}
	snap := e.det.Snapshot()
	e.state.Clock.Snapshot = &snap
	e.idem = store.PruneIdempotency(e.idem, e.now)
	err := save(store.StateSnapshot{
		LastEventSeq: e.state.LastEventSeq,
		Enforcement:  e.enforcementCoreNow(),
		Idempotency:  e.idem,
		Engine:       &e.state,
	})
	if err != nil {
		return err
	}
	e.dirty, e.urgent = false, false
	e.lastSave = e.bootNow
	if e.anchorSeq != e.state.LastEventSeq || e.anchorEpoch != e.state.Epoch {
		e.putAnchor()
	}
	return nil
}

// putAnchor stores the rollback anchor at the current log position (§11.3 steps 6, 8).
//
// It waits while startup evidence is pending (critical.go): the anchor must keep the
// position that proves a rollback until the correction is logged.
func (e *Engine) putAnchor() {
	if e.state.LastEventSeq == 0 || e.criticalHeld() {
		return
	}
	l := e.state.Ledger
	a := store.Anchor{
		Balance:       l.Balance,
		XP:            l.XP,
		Escalation:    store.AnchorEscalation{Index: l.Escalation.Index},
		Streak:        l.Streak,
		BestStreak:    l.BestStreak,
		LastClosedDay: l.LastClosedDay,
		VoidedDay:     l.VoidedDay,
		At:            fmtMs(e.now),
	}
	if l.Escalation.LastCountedAtMs != nil {
		a.Escalation.LastCountedAt = ptr(fmtMs(*l.Escalation.LastCountedAtMs))
	}
	if err := e.st.PutAnchor(a); err != nil {
		e.countError("anchor")
		e.log.Warn("rollback anchor update failed", "err", err)
		return
	}
	e.anchorEpoch, e.anchorSeq = e.state.Epoch, e.state.LastEventSeq
}

// Idempotency is what the API layer computed for an idempotent request (§8.6).
type Idempotency struct {
	// Lookup identifies (scope, key), e.g. hex(sha256(scope | key)); the raw key is never
	// stored.
	Lookup string
	Scope  string
	Method string
	// Path is the concrete path of the request.
	Path string
	// RequestHash is hex(sha256(path | body)).
	RequestHash string
	// Req is store.ReqFingerprint(scope, method, path, key): the events' req.
	Req string
}

// idemLookup returns a *ReplayedResponse for a stored identical request, 409
// idempotency_conflict for the same key with another path or body, or nil. A request
// whose events are in the log but whose record was lost (addLostResponses) is never run
// again: 409 idempotency_conflict with details.reason "response_lost".
func (e *Engine) idemLookup(k *Idempotency) error {
	e.idem = store.PruneIdempotency(e.idem, e.now)
	for _, r := range e.idem {
		if r.Lookup == "" {
			if k.Req != "" && r.Req == k.Req {
				return apiErr("idempotency_conflict", "the request with this Idempotency-Key was applied, but its response was lost in a restart",
					map[string]any{"reason": "response_lost"})
			}
			continue
		}
		if r.Lookup != k.Lookup || r.Scope != k.Scope {
			continue
		}
		if r.Method == k.Method && r.Path == k.Path && r.RequestHash == k.RequestHash {
			return &ReplayedResponse{Status: r.Status, Body: bytes.Clone(r.Body)}
		}
		return apiErr("idempotency_conflict", "the Idempotency-Key was used for another request", nil)
	}
	return nil
}

// idemStore records a successful idempotent response; it is persisted with state.json
// before the turn ends, so a replay after a restart returns the same bytes.
func (e *Engine) idemStore(k *Idempotency, status int, res any) {
	body, err := EncodeResponse(res)
	if err != nil {
		return
	}
	if status == 0 {
		status = 200
	}
	e.idem = slices.DeleteFunc(e.idem, func(r store.IdempotencyRecord) bool { return r.Lookup == k.Lookup && r.Scope == k.Scope })
	e.idem = append(e.idem, store.IdempotencyRecord{
		Lookup: k.Lookup, Scope: k.Scope, Method: k.Method, Path: k.Path, RequestHash: k.RequestHash,
		Req: k.Req, Status: status, Body: body, CreatedAtMs: e.now,
	})
	e.idem = store.PruneIdempotency(e.idem, e.now)
	e.markDirty(true)
}

// addLostResponses turns the idempotent requests whose events were replayed at startup
// but whose records did not reach state.json (a crash between the append and the state
// write, §11.3) into records without a response (Lookup ""), so a retry with the same
// key is refused instead of running the mutation a second time (§8.6). They are pruned
// like any record and persisted with state.json.
func (e *Engine) addLostResponses() {
	reqs := e.replayedReqs
	e.replayedReqs = nil
	if len(reqs) == 0 {
		return
	}
	have := make(map[string]bool, len(e.idem))
	for _, r := range e.idem {
		have[r.Req] = true
	}
	added := false
	for req, at := range reqs {
		if !have[req] {
			e.idem = append(e.idem, store.IdempotencyRecord{Req: req, CreatedAtMs: at})
			added = true
		}
	}
	if added {
		e.idem = store.PruneIdempotency(e.idem, e.now)
		e.markDirty(true)
	}
}
