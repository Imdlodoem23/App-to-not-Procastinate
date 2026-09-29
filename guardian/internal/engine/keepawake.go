package engine

// Keep-awake («Mantener despierto», docs/ARCHITECTURE.md §5.11, §8.8 «Keep awake»,
// §10.14): the user's configuration, persisted in state.json and rebuilt from its events,
// the PUT transitions, the expiry of `until` on trusted time (also at startup, before the
// inhibitor starts) and the OS inhibitor (internal/awake), told to hold after every change
// and on every step.
//
// It is not an anti-cheat setting: every change applies at once, safe mode accepts it
// (the user must always be able to turn it off), frozen mode refuses it and holds nothing.
// Its events have Δ 0 and are no ledger input; it never touches blocks, crediting, Study
// Mode, schedules or limits.

import (
	"context"
	"fmt"

	"github.com/imdlodoem23/centrate/guardian/internal/awake"
	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

// Keep-awake off reasons (KEEP_AWAKE_OFF_REASONS).
const (
	KeepAwakeOffUser    = "user"
	KeepAwakeOffExpired = "expired"
)

// KeepAwakeRequest is the PUT /v1/keep-awake body (KeepAwakeRequest in guardian-api.ts).
// DurationMinutes nil is «Hasta que lo desactive».
type KeepAwakeRequest struct {
	On              bool `json:"on"`
	DurationMinutes *int `json:"durationMinutes"`
	Display         bool `json:"display"`
}

// KeepAwakeConfig mirrors KeepAwakeConfig (domain.ts) in trusted time: the data of the
// keep_awake_* events and EpochKeptState.keepAwake.
type KeepAwakeConfig struct {
	On              bool    `json:"on"`
	DurationMinutes *int    `json:"durationMinutes"`
	Display         bool    `json:"display"`
	Since           *string `json:"since"`
	Until           *string `json:"until"`
}

// KeepAwakeState is KeepAwakeState (display time): the configuration plus whether the OS
// inhibition is held. Error is nil, "unsupported" or "failed".
type KeepAwakeState struct {
	On              bool    `json:"on"`
	DurationMinutes *int    `json:"durationMinutes"`
	Display         bool    `json:"display"`
	Since           *string `json:"since"`
	Until           *string `json:"until"`
	Active          bool    `json:"active"`
	Error           *string `json:"error"`
}

// KeepAwakeResponse answers GET and PUT /v1/keep-awake.
type KeepAwakeResponse struct {
	KeepAwake KeepAwakeState `json:"keepAwake"`
}

// keepAwakeState is the persisted configuration (state.json "keepAwake"), trusted
// Unix milliseconds. A state.json written before keep-awake has none: DEFAULT_KEEP_AWAKE.
type keepAwakeState struct {
	On              bool   `json:"on"`
	DurationMinutes *int   `json:"durationMinutes"`
	Display         bool   `json:"display"`
	Since           *int64 `json:"since"`
	Until           *int64 `json:"until"`
}

// kaStatus is what /v1/state shows of the inhibitor (active, error).
type kaStatus struct {
	active bool
	err    string
}

// defaultKeepAwake is DEFAULT_KEEP_AWAKE (api.json defaultKeepAwake).
func defaultKeepAwake() keepAwakeState {
	d := embedded.API().DefaultKeepAwake
	return keepAwakeState{On: false, DurationMinutes: clonePtr(d.DurationMinutes), Display: d.Display}
}

func clonePtr[T any](p *T) *T {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

// keepAwake is the current configuration.
func (e *Engine) keepAwake() keepAwakeState {
	if e.state.KeepAwake == nil {
		return defaultKeepAwake()
	}
	return *e.state.KeepAwake
}

// kaWire is the configuration in trusted time (events, kept state).
func kaWire(k keepAwakeState) KeepAwakeConfig {
	c := KeepAwakeConfig{On: k.On, DurationMinutes: clonePtr(k.DurationMinutes), Display: k.Display}
	if k.Since != nil {
		c.Since = ptr(fmtMs(*k.Since))
	}
	if k.Until != nil {
		c.Until = ptr(fmtMs(*k.Until))
	}
	return c
}

// kaFromWire parses a trusted-time configuration.
func kaFromWire(c KeepAwakeConfig) (keepAwakeState, error) {
	k := keepAwakeState{On: c.On, DurationMinutes: clonePtr(c.DurationMinutes), Display: c.Display}
	for _, f := range []struct {
		s   *string
		dst **int64
	}{{c.Since, &k.Since}, {c.Until, &k.Until}} {
		if f.s == nil {
			continue
		}
		ms, ok := parseMs(*f.s)
		if !ok {
			return keepAwakeState{}, fmt.Errorf("keep-awake: invalid timestamp %q", *f.s)
		}
		*f.dst = ptr(ms)
	}
	if !k.On {
		k.Since, k.Until = nil, nil
	}
	return k, nil
}

func sameMinutes(a, b *int) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

// GetKeepAwake is GET /v1/keep-awake.
func (e *Engine) GetKeepAwake(ctx context.Context) (KeepAwakeResponse, error) {
	return run(e, ctx, cmdOpts{}, func() (KeepAwakeResponse, error) {
		return KeepAwakeResponse{KeepAwake: e.keepAwakeWire()}, nil
	})
}

// SetKeepAwake is PUT /v1/keep-awake: a full replace applied at once (§5.11). It is
// refused in frozen mode only (report): safe mode must still let the user turn it off.
// No Idempotency-Key: an identical body is a no-op (200, no event, `until` kept).
func (e *Engine) SetKeepAwake(ctx context.Context, _ Request, req KeepAwakeRequest) (KeepAwakeResponse, error) {
	return run(e, ctx, cmdOpts{report: true}, func() (KeepAwakeResponse, error) {
		return e.setKeepAwake(req)
	})
}

func (e *Engine) setKeepAwake(req KeepAwakeRequest) (KeepAwakeResponse, error) {
	if err := kaValidate(req); err != nil {
		return KeepAwakeResponse{}, err
	}
	cur := e.keepAwake()
	if cur.On == req.On && sameMinutes(cur.DurationMinutes, req.DurationMinutes) && cur.Display == req.Display {
		e.keepAwakeHold()
		return KeepAwakeResponse{KeepAwake: e.keepAwakeWire()}, nil
	}
	T := e.now
	next := cur
	next.DurationMinutes, next.Display = clonePtr(req.DurationMinutes), req.Display
	restart := func() {
		next.Until = nil
		if d := req.DurationMinutes; d != nil {
			next.Until = ptr(T + int64(*d)*msPerMinute)
		}
	}
	b := e.newBatch()
	switch {
	case !cur.On && req.On:
		next.On, next.Since = true, ptr(T)
		restart()
		b.add(EvKeepAwakeOn, KeepAwakeData{KeepAwake: kaWire(next)})
	case cur.On && req.On:
		if !sameMinutes(cur.DurationMinutes, req.DurationMinutes) {
			restart() // the countdown restarts at T
		}
		b.add(EvKeepAwakeUpdated, KeepAwakeData{KeepAwake: kaWire(next)})
	case cur.On && !req.On:
		next.On, next.Since, next.Until = false, nil, nil
		b.add(EvKeepAwakeOff, KeepAwakeOffData{KeepAwake: kaWire(next), Reason: KeepAwakeOffUser})
	default: // off → off, duration or display changed
		b.add(EvKeepAwakeUpdated, KeepAwakeData{KeepAwake: kaWire(next)})
	}
	if err := e.commit(b); err != nil {
		return KeepAwakeResponse{}, err
	}
	e.log.Info("keep-awake changed", "event", b.events[0].Type)
	e.keepAwakeHold()
	e.keepAwakeNoteStatus()
	return KeepAwakeResponse{KeepAwake: e.keepAwakeWire()}, nil
}

// kaValidate checks the values the shape check leaves to the engine (§8.8): the
// duration range, with the keep-awake bounds in details.
func kaValidate(req KeepAwakeRequest) *APIError {
	d := req.DurationMinutes
	if d == nil {
		return nil
	}
	l := limits()
	if *d < l.KeepAwakeMinMinutes || *d > l.KeepAwakeMaxMinutes {
		return apiErr("duration_out_of_range", fmt.Sprintf("durationMinutes must be in [%d, %d] or null", l.KeepAwakeMinMinutes, l.KeepAwakeMaxMinutes),
			map[string]any{"path": "durationMinutes", "issue": "range", "minMinutes": l.KeepAwakeMinMinutes, "maxMinutes": l.KeepAwakeMaxMinutes})
	}
	return nil
}

// ---------------------------------------------------------------------------------------
// Time step, startup and the inhibitor
// ---------------------------------------------------------------------------------------

// keepAwakeStep is the keep-awake part of the time step (§10.1): a passed `until` turns
// it off (keep_awake_off{expired}); then the inhibitor is told what to hold (cheap and
// idempotent) and a change of its status bumps stateVersion.
func (e *Engine) keepAwakeStep(T int64) {
	e.keepAwakeExpire(T)
	e.keepAwakeHold()
	e.keepAwakeNoteStatus()
}

// keepAwakeExpire writes keep_awake_off{expired} when `until` has passed
// (!T.Before(until)). A failed commit is retried at the next step.
func (e *Engine) keepAwakeExpire(T int64) {
	k := e.keepAwake()
	if !k.On || k.Until == nil || T < *k.Until {
		return
	}
	next := k
	next.On, next.Since, next.Until = false, nil, nil
	b := e.newBatch()
	b.add(EvKeepAwakeOff, KeepAwakeOffData{KeepAwake: kaWire(next), Reason: KeepAwakeOffExpired})
	if e.commitNow(b, "keep_awake_off") {
		e.log.Info("keep-awake ended: its time is over")
	}
}

// keepAwakeStart runs at the end of the startup ladder, after the clock restore: a
// deadline that passed while the guardian was stopped or the machine was off expires
// first, and only then does the inhibitor start and hold (§5.11).
func (e *Engine) keepAwakeStart() {
	e.keepAwakeExpire(e.now)
	e.openInhibitor()
	e.keepAwakeHold()
	e.kaSeen = e.keepAwakeStatus(e.keepAwake())
}

// openInhibitor creates the inhibitor (once).
func (e *Engine) openInhibitor() {
	if e.inh != nil {
		return
	}
	e.inh = e.o.NewInhibitor(e.pokeKeepAwake)
	if e.inh == nil {
		e.inh = awake.Unsupported()
	}
}

// pokeKeepAwake is the inhibitor's onChange: it asks the loop for a turn (never blocks).
func (e *Engine) pokeKeepAwake() {
	select {
	case e.kaWake <- struct{}{}:
	default:
	}
}

// closeInhibitor releases the inhibition at a clean stop (Stop, and so uninstall).
func (e *Engine) closeInhibitor() {
	if e.inh != nil {
		e.inh.Close()
	}
}

// keepAwakeHold tells the inhibitor what to hold: on, and never in frozen mode.
func (e *Engine) keepAwakeHold() {
	if e.inh != nil {
		e.inh.Hold(e.keepAwake().On && !e.isFrozen())
	}
}

// keepAwakeNoteStatus bumps stateVersion when what /v1/state shows of the inhibitor
// changed (§5.11 «Versions»).
func (e *Engine) keepAwakeNoteStatus() {
	st := e.keepAwakeStatus(e.keepAwake())
	if st == e.kaSeen {
		return
	}
	e.log.Info("keep-awake inhibition", "mechanism", awake.Mechanism, "active", st.active, "error", st.err)
	e.kaSeen = st
	e.bumpState()
	e.markDirty(false)
}

// keepAwakeStatus maps the inhibitor's Status to the API's (active, error) under the
// keepAwakeStateSchema invariants: off → not active, error "" or unsupported; frozen
// while on → failed; active → no error.
func (e *Engine) keepAwakeStatus(k keepAwakeState) kaStatus {
	var st awake.Status
	if e.inh != nil {
		st = e.inh.Status()
	}
	switch {
	case !k.On:
		if st.Err == awake.ErrUnsupported {
			return kaStatus{err: awake.ErrUnsupported}
		}
		return kaStatus{}
	case e.isFrozen():
		return kaStatus{err: awake.ErrFailed}
	case st.Active:
		return kaStatus{active: true}
	}
	return kaStatus{err: st.Err}
}

// keepAwakeWire is KeepAwakeState in display time.
func (e *Engine) keepAwakeWire() KeepAwakeState {
	k := e.keepAwake()
	st := e.keepAwakeStatus(k)
	w := KeepAwakeState{
		On: k.On, DurationMinutes: clonePtr(k.DurationMinutes), Display: k.Display,
		Since: e.displayPtr(k.Since), Until: e.displayPtr(k.Until), Active: st.active,
	}
	if st.err != "" {
		w.Error = ptr(st.err)
	}
	return w
}

// ---------------------------------------------------------------------------------------
// Reducer and epochs
// ---------------------------------------------------------------------------------------

// applyKeepAwake is the reducer of keep_awake_on, keep_awake_updated and keep_awake_off:
// each carries the whole configuration, so the state is the last snapshot.
func (e *Engine) applyKeepAwake(ev *storeEvent) error {
	d, err := decode[KeepAwakeData](ev)
	if err != nil {
		return err
	}
	k, err := kaFromWire(d.KeepAwake)
	if err != nil {
		return fmt.Errorf("seq %d: %w", ev.Seq, err)
	}
	e.state.KeepAwake = &k
	return nil
}

// keptKeepAwake is epoch_started.kept.keepAwake: the configuration as it is (a running
// keep-awake keeps its since and until across a data deletion).
func (e *Engine) keptKeepAwake() *KeepAwakeConfig {
	return ptr(kaWire(e.keepAwake()))
}

// restoreKeptKeepAwake applies epoch_started.kept.keepAwake (absent: the default).
func (e *Engine) restoreKeptKeepAwake(c *KeepAwakeConfig) error {
	if c == nil {
		e.state.KeepAwake = nil
		return nil
	}
	k, err := kaFromWire(*c)
	if err != nil {
		e.state.KeepAwake = nil
		return err
	}
	e.state.KeepAwake = &k
	return nil
}
