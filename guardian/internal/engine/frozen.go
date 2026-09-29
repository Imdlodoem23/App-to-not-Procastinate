package engine

import (
	"encoding/json"
	"slices"

	"github.com/imdlodoem23/centrate/guardian/internal/clock"
	"github.com/imdlodoem23/centrate/guardian/internal/procwatch"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// Frozen mode (§11.5): the data was written by a newer guardian. Nothing is written
// (the store refuses), writes answer 503 read_only{schema_too_new}, and enforcement
// continues from the v1 enforcement core until each item ends; then the section goes.

func (e *Engine) startFrozen(rep store.RecoveryReport) error {
	e.mode = ModeGuardianFrozen
	e.integrity = "ok"
	core := &enforcementCore{V: 1}
	if len(rep.FrozenEnforcement) > 0 {
		if err := json.Unmarshal(rep.FrozenEnforcement, core); err != nil {
			e.log.Warn("frozen enforcement core unreadable", "err", err)
			core = &enforcementCore{V: 1}
		}
	}
	e.frozenCore = core
	switch {
	case core.Clock != nil && !core.Clock.Trusted.IsZero():
		e.det.Restore(*core.Clock)
	default:
		var s clock.Snapshot
		if ok, err := e.st.LoadClock(&s); err == nil && ok {
			e.det.Restore(s)
		}
	}
	e.startClock()
	e.startedAt = e.now
	// Frozen mode never holds keep-awake (§10.14); the inhibitor still probes support.
	e.openInhibitor()
	e.keepAwakeHold()
	e.kaSeen = e.keepAwakeStatus(e.keepAwake())
	e.reconcile()
	return nil
}

// frozenStep keeps time and expires core items.
func (e *Engine) frozenStep() {
	e.det.Tick()
	e.readClocks()
	e.now = e.trustedNowMs()
	c := e.frozenCore
	if c == nil {
		return
	}
	n := len(c.Items)
	c.Items = slices.DeleteFunc(c.Items, func(it enforcementCoreItem) bool {
		ms, ok := parseMs(it.EndsAtTrusted)
		return !ok || ms <= e.now
	})
	if len(c.Items) != n {
		e.enfDirty = true
	}
}

// frozenReconcile enforces the union of the core items.
func (e *Engine) frozenReconcile() {
	var domains, procs []string
	var until int64
	if c := e.frozenCore; c != nil {
		for _, it := range c.Items {
			domains = append(domains, it.Domains...)
			procs = append(procs, it.Processes...)
			if ms, ok := parseMs(it.EndsAtTrusted); ok {
				until = max(until, ms)
			}
		}
	}
	domains = slices.DeleteFunc(sortedUnique(domains), func(d string) bool {
		return e.cat.IsAlwaysAllowedHost(d) || e.cat.IsProtectedDomain(d)
	})
	procs = e.effectiveProcesses(procs, nil)
	e.enf = enforcementPlan{HostsDomains: domains, BlockDomains: domains, ExcludedDomains: []string{}, Processes: procs, Until: until}
	m := procwatch.NewMatcher(procs)
	e.matcher.Store(&m)
	e.applyHosts(domains, until)
}
