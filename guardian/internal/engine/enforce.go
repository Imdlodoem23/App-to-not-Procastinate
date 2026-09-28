package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"slices"
	"strings"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
	"github.com/imdlodoem23/centrate/guardian/internal/hosts"
	"github.com/imdlodoem23/centrate/guardian/internal/procwatch"
)

// Enforcement rendering (§10.10): the union of what each active block enforces, minus
// active allowances, always-allowed, excluded and protected hosts, rendered to the hosts
// section, the process watcher's matcher and the extension rules (whose version counter
// increases on every change).

// enforcementPlan is the rendered enforcement.
type enforcementPlan struct {
	// HostsDomains is the desired hosts section (sorted, capped by priority).
	HostsDomains []string
	// BlockDomains: the non-whitelist blocks' domains − allowance domains − always-allowed
	// hosts (extension blockDomains). ExcludedDomains: hosts under them that stay open.
	BlockDomains    []string
	ExcludedDomains []string
	// Whitelist is set while a whitelist-only block is active: exemptions from the
	// whitelist rule only (intersection across whitelist blocks, plus allowance domains
	// and always-allowed hosts).
	Whitelist *whitelistRules
	// Processes are the process watcher's targets.
	Processes []string
	// Until is the latest trusted endsAt among active blocks (0: none).
	Until int64
	// NextBlockEnd is the earliest trusted endsAt among active blocks (0: none).
	NextBlockEnd int64
	// Capped counts domains left out by the hosts cap (never expected).
	Capped int
}

// whitelistRules are ExtWhitelistRules before encoding.
type whitelistRules struct {
	AllowDomains      []string `json:"allowDomains"`
	AllowHostPatterns []string `json:"allowHostPatterns"`
}

// hostsState is what the engine knows about the hosts layer.
type hostsState struct {
	applied       []string
	appliedUntil  int64
	appliedValid  bool
	ok            bool
	status        string
	lastAppliedAt *int64
	lastVerifyAt  *int64
	lastFlush     *FlushInfo
	retryAtBoot   time.Duration
	lastTamper    int64
	overrideSeen  bool
	pendingTamper []string
}

// modeRank orders modes for the hosts cap and schedule weakening (§10.3, §10.10).
func modeRank(mode string) int {
	switch mode {
	case ModeStrict:
		return 1
	case ModeHardcore:
		return 2
	case ModeExam:
		return 3
	}
	return 0
}

// renderEnforcement computes the plan from the current state.
func (e *Engine) renderEnforcement() enforcementPlan {
	active := e.activeBlocks()
	var plan enforcementPlan
	allowDomains := map[string]bool{}
	var allowProcs []string
	for _, sid := range e.activeAllowanceServiceIDs() {
		if s := e.cat.Service(sid); s != nil {
			for _, d := range s.Domains {
				allowDomains[d] = true
			}
			for _, aid := range s.AppIDs {
				if a := e.cat.App(aid); a != nil {
					allowProcs = append(allowProcs, a.Processes.For(string(e.platform))...)
				}
			}
		}
	}
	explicit := map[string]bool{}
	excluded := map[string]bool{}
	var procs []string
	var wl []*blockRec
	for _, b := range active {
		plan.Until = max(plan.Until, b.EndsAt)
		if plan.NextBlockEnd == 0 || b.EndsAt < plan.NextBlockEnd {
			plan.NextBlockEnd = b.EndsAt
		}
		if b.WhitelistOnly {
			wl = append(wl, b)
			continue
		}
		for _, d := range b.Resolved.Domains {
			explicit[d] = true
		}
		for _, d := range b.Resolved.ExcludedDomains {
			excluded[d] = true
		}
		procs = append(procs, b.Resolved.Processes...)
	}
	wlDomains := map[string]bool{}
	if len(wl) > 0 {
		all := e.cat.AllDistractionTargets(e.platform)
		for _, d := range all.Domains {
			allowedByAll := true
			for _, b := range wl {
				if !catalog.IsDomainAllowedInWhitelist(d, b.WL.Domains, b.WL.HostPatterns) {
					allowedByAll = false
					break
				}
			}
			if !allowedByAll {
				wlDomains[d] = true
			}
		}
		for _, p := range e.allAppProcesses() {
			allowedByAll := true
			for _, b := range wl {
				if !containsProcess(b.WL.Processes, p, e.platform) {
					allowedByAll = false
					break
				}
			}
			if !allowedByAll {
				procs = append(procs, p)
			}
		}
		rules := &whitelistRules{AllowDomains: slices.Clone(wl[0].WL.Domains), AllowHostPatterns: slices.Clone(wl[0].WL.HostPatterns)}
		for _, b := range wl[1:] {
			rules.AllowDomains = slices.DeleteFunc(rules.AllowDomains, func(d string) bool { return !slices.Contains(b.WL.Domains, d) })
			rules.AllowHostPatterns = slices.DeleteFunc(rules.AllowHostPatterns, func(p string) bool { return !slices.Contains(b.WL.HostPatterns, p) })
		}
		for d := range allowDomains {
			rules.AllowDomains = append(rules.AllowDomains, d)
		}
		rules.AllowDomains = sortedUnique(append(rules.AllowDomains, e.cat.AlwaysAllowedHosts()...))
		rules.AllowHostPatterns = sortedUnique(rules.AllowHostPatterns)
		plan.Whitelist = rules
	}
	drop := func(d string) bool {
		return allowDomains[d] || e.cat.IsAlwaysAllowedHost(d) || excluded[d] || e.cat.IsProtectedDomain(d)
	}
	var blockDomains []string
	for d := range explicit {
		if !allowDomains[d] && !e.cat.IsAlwaysAllowedHost(d) && !e.cat.IsProtectedDomain(d) {
			blockDomains = append(blockDomains, d)
		}
	}
	plan.BlockDomains = sortedUnique(blockDomains)
	plan.ExcludedDomains = sortedUnique(mapKeys(excluded))
	desired := map[string]bool{}
	for d := range explicit {
		if !drop(d) {
			desired[d] = true
		}
	}
	for d := range wlDomains {
		if !drop(d) {
			desired[d] = true
		}
	}
	plan.HostsDomains, plan.Capped = e.capHosts(desired, active, wlDomains)
	plan.Processes = e.effectiveProcesses(procs, allowProcs)
	return plan
}

// effectiveProcesses removes allowance and protected processes (§10.8).
func (e *Engine) effectiveProcesses(procs, allowProcs []string) []string {
	var out []string
	for _, p := range procs {
		if containsProcess(allowProcs, p, e.platform) || e.cat.IsProtectedProcessName(p) || procwatch.IsProtected(p) {
			continue
		}
		if !containsProcess(out, p, e.platform) {
			out = append(out, p)
		}
	}
	slices.Sort(out)
	if out == nil {
		out = []string{}
	}
	return out
}

// allAppProcesses is every catalog app's process names on this platform (the process
// part of the whitelist rule, §10.8).
func (e *Engine) allAppProcesses() []string {
	var out []string
	for _, a := range e.cat.Snapshot().Apps {
		out = append(out, a.Processes.For(string(e.platform))...)
	}
	return out
}

func containsProcess(list []string, p string, pl catalog.Platform) bool {
	k := catalog.ProcessNameKey(p, pl)
	return slices.ContainsFunc(list, func(q string) bool { return catalog.ProcessNameKey(q, pl) == k })
}

func mapKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// capHosts orders the desired set and keeps at most hostsMaxDomains, by priority
// (§10.10): punishment > exam > hardcore > strict > normal blocks, catalog before
// custom domains, older blocks first; never alphabetically.
func (e *Engine) capHosts(desired map[string]bool, active []*blockRec, wlDomains map[string]bool) ([]string, int) {
	limit := limits().HostsMaxDomains
	if len(desired) <= limit {
		return sortedUnique(mapKeys(desired)), 0
	}
	blocks := slices.Clone(active)
	slices.SortStableFunc(blocks, func(a, b *blockRec) int {
		pa, pb := modeRank(a.Mode), modeRank(b.Mode)
		if a.Kind == KindPunishment {
			pa = 10
		}
		if b.Kind == KindPunishment {
			pb = 10
		}
		if pa != pb {
			return pb - pa
		}
		return int(a.Rank - b.Rank)
	})
	var ordered []string
	seen := map[string]bool{}
	take := func(d string) {
		if desired[d] && !seen[d] {
			seen[d] = true
			ordered = append(ordered, d)
		}
	}
	for _, b := range blocks {
		if b.WhitelistOnly {
			for _, d := range sortedUnique(mapKeys(wlDomains)) {
				take(d)
			}
			continue
		}
		custom := map[string]bool{}
		for _, c := range b.Targets.CustomDomains {
			for _, v := range e.cat.ExpandDomainVariants(c) {
				custom[v] = true
			}
		}
		for _, d := range b.Resolved.Domains {
			if !custom[d] {
				take(d)
			}
		}
		for _, d := range b.Resolved.Domains {
			take(d)
		}
	}
	capped := len(desired) - limit
	e.log.Warn("hosts section capped", "kept", limit, "dropped", capped)
	out := ordered[:limit]
	slices.Sort(out)
	return out, capped
}

// reconcile renders enforcement and brings every layer to it (§10.10, §11.3 step 5).
func (e *Engine) reconcile() {
	e.lastReconcile = e.bootNow
	e.enfDirty = false
	if e.isFrozen() {
		e.frozenReconcile()
		return
	}
	plan := e.renderEnforcement()
	e.enf = plan
	if cur := e.matcher.Load(); !slices.Equal(cur.Names(), plan.Processes) {
		m := procwatch.NewMatcher(plan.Processes)
		e.matcher.Store(&m)
	}
	if fp := e.extRulesFingerprint(); fp != e.enfFP {
		e.enfFP = fp
		e.bumpExtRules()
	}
	e.applyHosts(plan.HostsDomains, plan.Until)
	e.checkHostsPathOverride()
}

// extRulesFingerprint covers everything the extension rules payload shows.
func (e *Engine) extRulesFingerprint() string {
	type blk struct {
		ID, Kind, Mode, EndsAt string
		Domains                []string
		WL                     bool
	}
	v := struct {
		Block, Excluded []string
		WL              *whitelistRules
		Blocks          []blk
		Allowances      []RewardAllowance
		Penalties       bool
		Nuclear         bool
	}{Block: e.enf.BlockDomains, Excluded: e.enf.ExcludedDomains, WL: e.enf.Whitelist,
		Allowances: e.allowancesWire(e.wallOffsetMs()), Penalties: e.state.Settings.AttemptPenalties, Nuclear: e.nuclearActive()}
	for _, b := range e.sortedActive() {
		v.Blocks = append(v.Blocks, blk{b.ID, b.Kind, b.Mode, e.display(b.EndsAt), b.Resolved.Domains, b.WhitelistOnly})
	}
	raw, _ := json.Marshal(v)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// applyHosts writes the hosts section when it differs from what should be there.
func (e *Engine) applyHosts(domains []string, until int64) {
	desired := validHostsDomains(domains)
	h := &e.hosts
	if h.retryAtBoot > e.bootNow {
		return
	}
	_, header := e.o.Hosts.(HostsSectionHeader)
	if h.appliedValid && h.ok && slices.Equal(desired, h.applied) && (!header || h.appliedUntil == until) {
		ok, err := e.o.Hosts.Verify(desired)
		h.lastVerifyAt = ptr(e.now)
		if err == nil && ok {
			return
		}
		e.hostsTampered()
		if h.retryAtBoot > e.bootNow {
			return
		}
	}
	var err error
	switch {
	case len(desired) == 0:
		err = e.o.Hosts.Remove()
	default:
		if hh, ok := e.o.Hosts.(HostsSectionHeader); ok {
			err = hh.ApplyUntil(desired, time.UnixMilli(until).UTC())
		} else {
			err = e.o.Hosts.Apply(desired)
		}
	}
	if err != nil {
		h.ok = false
		h.status = classifyHostsErr(err)
		h.appliedValid = false
		e.countError("hosts_write")
		e.log.Warn("hosts write failed", "err", err, "entries", len(desired))
		return
	}
	changed := !h.appliedValid || !slices.Equal(desired, h.applied)
	h.applied, h.appliedValid, h.ok, h.status = desired, true, true, "ok"
	h.appliedUntil = until
	h.lastAppliedAt = ptr(e.now)
	e.state.HostsHash = hashDomains(desired)
	if changed {
		e.flushDNS()
	}
}

// validHostsDomains keeps the domains the hosts layer accepts (on Windows without the
// Defender-sensitive ones, left to the extension).
func validHostsDomains(domains []string) []string {
	kept, _ := hosts.HostsLayerDomains(domains)
	out := make([]string, 0, len(kept))
	for _, d := range kept {
		if v, err := hosts.ValidateDomain(d); err == nil {
			out = append(out, v)
		}
	}
	return sortedUnique(out)
}

func classifyHostsErr(err error) string {
	switch {
	case errors.Is(err, fs.ErrPermission):
		return "locked"
	case errors.Is(err, hosts.ErrUnsupportedEncoding), errors.Is(err, hosts.ErrCorrupt), errors.Is(err, hosts.ErrTooLarge),
		errors.Is(err, hosts.ErrInvalidPath):
		return "unwritable"
	}
	return "io_error"
}

// hashDomains is the SHA-256 of a section's sorted domain list (§10.12 step 9).
func hashDomains(domains []string) string {
	sum := sha256.Sum256([]byte(strings.Join(sortedUnique(domains), "\n")))
	return hex.EncodeToString(sum[:])
}

// flushDNS flushes the resolver cache after a hosts change.
func (e *Engine) flushDNS() {
	ctx, cancel := context.WithTimeout(context.Background(), hosts.FlushTimeout)
	defer cancel()
	err := e.o.DNS.FlushDNS(ctx)
	e.hosts.lastFlush = &FlushInfo{At: e.display(e.now), OK: err == nil, Method: "system"}
}

// onHostsChanged handles a hosts watcher notice (§10.10): when our section is no
// longer what it should be, re-apply (within ~1 s, or after the contention backoff) and
// log tamper_detected{hosts} at most once a minute while blocks are active.
func (e *Engine) onHostsChanged() {
	desired := validHostsDomains(e.enf.HostsDomains)
	ok, err := e.o.Hosts.Verify(desired)
	if err == nil && ok {
		return
	}
	e.hostsTampered()
	e.reconcile()
}

// hostsTampered records an external change of the section.
func (e *Engine) hostsTampered() {
	h := &e.hosts
	h.appliedValid = false
	delay := e.contention.Rewritten(time.UnixMilli(e.now))
	if delay > 0 {
		h.retryAtBoot = e.bootNow + delay
	}
	if e.hasActiveBlocks() && (h.lastTamper == 0 || e.now-h.lastTamper >= hostsTamperEventGap.Milliseconds()) {
		h.lastTamper = e.now
		h.pendingTamper = append(h.pendingTamper, "hosts")
	}
}

// checkHostsPathOverride reports a Windows DataBasePath override once while blocks are
// active (tamper_detected{hosts_path_overridden}).
func (e *Engine) checkHostsPathOverride() {
	if !e.o.HostsPathRedirected() {
		e.hosts.overrideSeen = false
		return
	}
	if !e.hosts.overrideSeen && e.hasActiveBlocks() {
		e.hosts.overrideSeen = true
		e.hosts.pendingTamper = append(e.hosts.pendingTamper, "hosts_path_overridden")
	}
}

// flushTamper writes the pending tamper_detected events (balanceCorrection 0).
func (e *Engine) flushTamper() {
	if len(e.hosts.pendingTamper) == 0 || e.isFrozen() {
		return
	}
	b := e.newBatch()
	for _, k := range e.hosts.pendingTamper {
		b.add(EvTamperDetected, TamperDetectedData{Kind: k})
	}
	if e.commitNow(b, "tamper_detected") {
		e.hosts.pendingTamper = nil
		e.tampers = append(e.tampers, e.now)
	}
}

// hostsStatus is ProtectionStatus.hosts.status.
func (e *Engine) hostsStatus() string {
	switch {
	case !e.hosts.ok && e.hosts.status != "" && e.hosts.status != "ok":
		return e.hosts.status
	case e.contention.Contested(time.UnixMilli(e.now)):
		return "contested"
	case e.o.HostsPathRedirected():
		return "path_overridden"
	}
	return "ok"
}

// protection is /v1/state.protection.
func (e *Engine) protection() ProtectionStatus {
	st := e.hostsStatus()
	return ProtectionStatus{
		Hosts: HostsProtection{
			OK:            e.hosts.ok && (st == "ok" || st == "path_overridden"),
			Status:        st,
			Entries:       len(e.hosts.applied),
			LastAppliedAt: e.displayPtr(e.hosts.lastAppliedAt),
		},
		ProcessWatcher:           WatcherProtection{OK: !e.watcherErr.Load()},
		Extensions:               nonNil(e.extensionsStatus()),
		BrowsersWithoutExtension: nonNil(e.browsersWithoutExtension()),
	}
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

// problems is health.problems / state.guardian.problems (codes only).
func (e *Engine) problems() []string {
	p := slices.Clone(e.startProblems)
	if !e.hosts.appliedValid && e.hosts.status != "" && e.hosts.status != "ok" {
		p = append(p, "hosts_write_failed")
	}
	switch e.hostsStatus() {
	case "contested":
		p = append(p, "hosts_contested")
	case "unwritable":
		p = append(p, "hosts_unwritable")
	case "locked":
		p = append(p, "hosts_locked")
	}
	if e.o.HostsPathRedirected() {
		p = append(p, "hosts_path_overridden")
	}
	if e.watcherErr.Load() {
		p = append(p, "process_watcher_failed")
	}
	switch e.mode {
	case ModeGuardianFrozen:
		p = append(p, "schema_too_new")
	case ModeGuardianSafe:
		p = append(p, "safe_mode")
	}
	if e.diskFull {
		p = append(p, "disk_full")
	}
	if e.trust() == TrustUnverified && e.state.Settings.ServerTimeCheck {
		p = append(p, "clock_unverified")
	}
	return sortedUnique(p)
}

// enforcementCoreNow is the v1 enforcement core for state.json (§11.5).
func (e *Engine) enforcementCoreNow() enforcementCore {
	snap := e.det.Snapshot()
	core := enforcementCore{V: 1, Clock: &snap, Items: []enforcementCoreItem{}}
	var wlPart []string
	if e.enf.Whitelist != nil {
		for _, d := range e.enf.HostsDomains {
			if !slices.Contains(e.enf.BlockDomains, d) {
				wlPart = append(wlPart, d)
			}
		}
	}
	for _, b := range e.activeBlocks() {
		it := enforcementCoreItem{
			ID: b.ID, EndsAtTrusted: fmtMs(b.EndsAt), Domains: nonNil(slices.Clone(b.Resolved.Domains)),
			ExcludedDomains: nonNil(slices.Clone(b.Resolved.ExcludedDomains)), Processes: nonNil(slices.Clone(b.Resolved.Processes)),
			Whitelist: b.WhitelistOnly, AllowDomains: []string{}, Kind: b.Kind, Mode: b.Mode,
		}
		if b.WhitelistOnly && b.WL != nil {
			it.Domains = nonNil(slices.Clone(wlPart))
			it.AllowDomains = slices.Clone(b.WL.Domains)
		}
		core.Items = append(core.Items, it)
	}
	return core
}
