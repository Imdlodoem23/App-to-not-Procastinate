package engine

// OWNER: settings teammate (docs/ARCHITECTURE.md §5.8 incl. delayed weakening, §4 time
// zone, §8.8 «Settings»).
//
// The effective settings live in e.state.Settings (the core reads them everywhere: local
// days, goal, serverTimeCheck, studyWhitelist snapshots, attemptPenalties). A PUT applies
// strengthening changes and punishment changes at once and turns weakening ones into
// pending changes keyed by path, each with a remaining delay (settingsWeakeningDelayMs)
// that only elapses on the boot clock while the guardian runs, plus downtime a network
// time check verified. So neither a clock jump nor an offline reboot applies a weakening
// change early, and a retried PUT never restarts a delay.

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

// Settings paths that can have a pending change (PENDING_SETTING_PATHS, in order).
const (
	setPathTimezone       = "timezone"
	setPathGoal           = "dailyGoalMinutes"
	setPathPenalties      = "attemptPenalties"
	setPathCloseBrowsers  = "closeBrowsersWithoutExtension"
	setPathServerTime     = "serverTimeCheck"
	setPathExtraDomains   = "studyWhitelist.extraDomains"
	setPathExtraProcesses = "studyWhitelist.extraProcesses"
)

var (
	// setPendingPaths is PENDING_SETTING_PATHS of domain.ts (the order of pending lists).
	setPendingPaths = []string{
		setPathTimezone, setPathGoal, setPathPenalties, setPathCloseBrowsers, setPathServerTime,
		setPathExtraDomains, setPathExtraProcesses,
	}
	// setPunishmentLevels is PUNISHMENT_LEVELS of domain.ts (the embedded data carries
	// only the default level).
	setPunishmentLevels = []string{"distractions", "whitelist", "nuclear"}
)

// settingsState is the persisted settings state (state.json "engine.settingsExt"): the
// pending weakening changes, in setPendingPaths order.
type settingsState struct {
	Pending []*setPending `json:"pending"`
}

// setPending is one pending weakening change.
type setPending struct {
	Field string `json:"field"`
	// Value is the JSON value the path takes when the delay has passed.
	Value json.RawMessage `json:"value"`
	// RemainingMs is the delay still to run: decremented by the boot-clock delta while
	// the guardian runs and by verified downtime; applied at ≤ 0.
	RemainingMs int64 `json:"remainingMs"`
	// StartedAt is the trusted time the delay (re)started: only changes that existed
	// when the previous run stopped are credited its verified downtime.
	StartedAt int64 `json:"startedAt"`
}

// SettingsResponse mirrors SettingsResponse.
type SettingsResponse struct {
	Settings GuardianSettings       `json:"settings"`
	Pending  []PendingSettingChange `json:"pending"`
}

// GetSettings is GET /v1/settings.
func (e *Engine) GetSettings(ctx context.Context) (SettingsResponse, error) {
	return run(e, ctx, cmdOpts{}, func() (SettingsResponse, error) { return e.settingsResponse(), nil })
}

// UpdateSettings is PUT /v1/settings (full GuardianSettings; weakening delayed).
func (e *Engine) UpdateSettings(ctx context.Context, r Request, s GuardianSettings) (SettingsResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem}, func() (SettingsResponse, error) { return e.updateSettings(s) })
}

func (e *Engine) settingsResponse() SettingsResponse {
	return SettingsResponse{Settings: setNormalized(e.state.Settings), Pending: nonNil(e.pendingSettingsWire(e.wallOffsetMs()))}
}

func (e *Engine) updateSettings(s GuardianSettings) (SettingsResponse, error) {
	s = setNormalized(s)
	if err := e.setValidate(s); err != nil {
		return SettingsResponse{}, err
	}
	delay := setDelayMs()
	cur := setNormalized(e.state.Settings)
	next := setNormalized(cur)
	pend := map[string]*setPending{}
	for _, p := range e.state.SettingsExt.Pending {
		c := *p
		pend[p.Field] = &c
	}
	// put makes value pending for path. The delay (re)starts for a new pending change or
	// when weaker says the value is weaker than the pending one; otherwise the value is
	// replaced and the remaining delay kept (an identical value changes nothing).
	put := func(path string, value any, weaker func(pending json.RawMessage) bool) {
		raw := setRaw(value)
		p := pend[path]
		if p == nil || weaker(p.Value) {
			pend[path] = &setPending{Field: path, Value: raw, RemainingMs: delay, StartedAt: e.now}
			return
		}
		p.Value = raw
	}

	// Punishment changes apply at once («el usuario lo elige en Ajustes»).
	next.Punishment = s.Punishment

	// Time zone: any change waits, except the first set while detection failed.
	switch {
	case setSameZone(s.Timezone, cur.Timezone):
		delete(pend, setPathTimezone)
	case cur.Timezone == nil:
		next.Timezone = ptr(*s.Timezone)
		delete(pend, setPathTimezone)
	default:
		put(setPathTimezone, s.Timezone, func(p json.RawMessage) bool {
			var v *string
			return json.Unmarshal(p, &v) != nil || !setSameZone(v, s.Timezone)
		})
	}

	// Daily goal: lowering waits.
	switch {
	case s.DailyGoalMinutes == cur.DailyGoalMinutes:
		delete(pend, setPathGoal)
	case s.DailyGoalMinutes > cur.DailyGoalMinutes:
		next.DailyGoalMinutes = s.DailyGoalMinutes
		delete(pend, setPathGoal)
	default:
		put(setPathGoal, s.DailyGoalMinutes, func(p json.RawMessage) bool {
			var v int
			return json.Unmarshal(p, &v) != nil || s.DailyGoalMinutes < v
		})
	}

	// Switches: true → false waits.
	for _, f := range []struct {
		path     string
		req      bool
		cur, out *bool
	}{
		{setPathPenalties, s.AttemptPenalties, &cur.AttemptPenalties, &next.AttemptPenalties},
		{setPathCloseBrowsers, s.CloseBrowsersWithoutExtension, &cur.CloseBrowsersWithoutExtension, &next.CloseBrowsersWithoutExtension},
		{setPathServerTime, s.ServerTimeCheck, &cur.ServerTimeCheck, &next.ServerTimeCheck},
	} {
		switch {
		case f.req == *f.cur:
			delete(pend, f.path)
		case f.req:
			*f.out = true
			delete(pend, f.path)
		default:
			put(f.path, false, func(p json.RawMessage) bool {
				var v bool
				return json.Unmarshal(p, &v) != nil || v
			})
		}
	}

	// Study whitelist extras: removals apply at once (also from the pending list, whose
	// value is the requested full list), additions wait.
	for _, f := range []struct {
		path     string
		req      []string
		cur, out *[]string
	}{
		{setPathExtraDomains, s.StudyWhitelist.ExtraDomains, &cur.StudyWhitelist.ExtraDomains, &next.StudyWhitelist.ExtraDomains},
		{setPathExtraProcesses, s.StudyWhitelist.ExtraProcesses, &cur.StudyWhitelist.ExtraProcesses, &next.StudyWhitelist.ExtraProcesses},
	} {
		kept := slices.DeleteFunc(slices.Clone(*f.cur), func(v string) bool { return !slices.Contains(f.req, v) })
		*f.out = nonNil(kept)
		if schSubset(f.req, kept) {
			delete(pend, f.path)
			continue
		}
		req := f.req
		put(f.path, req, func(p json.RawMessage) bool {
			var v []string
			return json.Unmarshal(p, &v) != nil || !schSubset(req, v)
		})
	}

	pending := setOrdered(pend)
	if !setChanged(cur, next, e.state.SettingsExt.Pending, pending) {
		return e.settingsResponse(), nil
	}
	b := e.newBatch()
	b.add(EvSettingsChanged, SettingsChangedData{Settings: next, Pending: setWire(pending, b.at, 0)})
	if err := e.commit(b); err != nil {
		return SettingsResponse{}, err
	}
	return e.settingsResponse(), nil
}

// setValidate validates PUT /v1/settings like settingsRequestSchema (in field order),
// then the study whitelist extras with findAllowDistraction.
func (e *Engine) setValidate(s GuardianSettings) *APIError {
	l := limits()
	r := embedded.Rules()
	if s.Timezone != nil {
		if err := schZoneIssue(setPathTimezone, *s.Timezone); err != nil {
			return err
		}
	}
	if g := s.DailyGoalMinutes; g < r.Points.DailyGoalMinMinutes || g > r.Points.DailyGoalMaxMinutes {
		return issueErr(setPathGoal, "range", "daily goal out of range")
	}
	if !slices.Contains(setPunishmentLevels, s.Punishment.Level) {
		return issueErr("punishment.level", "enum", "unknown punishment level")
	}
	if m, pm := s.Punishment.Minutes, r.Study.PunishmentMinutes; m < pm.Min || m > pm.Max {
		return issueErr("punishment.minutes", "range", "punishment minutes out of range")
	}
	wl := s.StudyWhitelist
	if err := e.checkDomains(setPathExtraDomains, wl.ExtraDomains, l.MaxWhitelistExtraDomains); err != nil {
		return err
	}
	if err := e.checkProcesses(setPathExtraProcesses, wl.ExtraProcesses, l.MaxWhitelistExtraProcesses); err != nil {
		return err
	}
	if a := e.cat.FindAllowDistraction(
		catalog.AllowEntries{Domains: wl.ExtraDomains, Processes: wl.ExtraProcesses},
		catalog.AllowPaths{Domains: setPathExtraDomains, Processes: setPathExtraProcesses}, e.platform); a != nil {
		d := map[string]any{"path": a.Path, "reason": a.Reason, "serviceId": nilIfEmpty(a.ServiceID), "appId": nilIfEmpty(a.AppID)}
		return apiErr("allow_distraction", "a whitelist entry is a distraction", d)
	}
	return nil
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

// setDelayMs is settingsWeakeningDelayMs.
func setDelayMs() int64 { return int64(limits().SettingsWeakeningDelayMs) }

// setNormalized is a deep copy of s whose lists are never nil.
func setNormalized(s GuardianSettings) GuardianSettings {
	out := s.Clone()
	out.StudyWhitelist.ExtraDomains = nonNil(out.StudyWhitelist.ExtraDomains)
	out.StudyWhitelist.ExtraProcesses = nonNil(out.StudyWhitelist.ExtraProcesses)
	return out
}

func setSameZone(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// setRaw is the JSON value of a pending change.
func setRaw(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		panic("engine: encode a settings value: " + err.Error())
	}
	return raw
}

// setOrdered lists the pending changes in setPendingPaths order.
func setOrdered(m map[string]*setPending) []*setPending {
	out := []*setPending{}
	for _, path := range setPendingPaths {
		if p := m[path]; p != nil {
			out = append(out, p)
		}
	}
	return out
}

// setChanged reports whether a PUT changed the effective settings or the pending list.
func setChanged(cur, next GuardianSettings, before, after []*setPending) bool {
	a, _ := json.Marshal(cur)
	b, _ := json.Marshal(next)
	if !bytes.Equal(a, b) || len(before) != len(after) {
		return true
	}
	for i := range before {
		x, y := before[i], after[i]
		if x.Field != y.Field || !bytes.Equal(x.Value, y.Value) || x.RemainingMs != y.RemainingMs {
			return true
		}
	}
	return false
}

// setWire converts pending changes: effectiveAt = atMs + remaining, shifted by offsetMs
// (the wall offset in API responses, 0 in events).
func setWire(list []*setPending, atMs, offsetMs int64) []PendingSettingChange {
	out := []PendingSettingChange{}
	for _, p := range list {
		out = append(out, PendingSettingChange{
			Field:       p.Field,
			Value:       bytes.Clone(p.Value),
			EffectiveAt: fmtMs(atMs + max(0, p.RemainingMs) + offsetMs),
		})
	}
	return out
}

// setAssign sets path to the JSON value raw.
func setAssign(s *GuardianSettings, path string, raw json.RawMessage) error {
	var dst any
	switch path {
	case setPathTimezone:
		var v *string
		if err := json.Unmarshal(raw, &v); err != nil {
			return err
		}
		s.Timezone = v
		return nil
	case setPathGoal:
		dst = &s.DailyGoalMinutes
	case setPathPenalties:
		dst = &s.AttemptPenalties
	case setPathCloseBrowsers:
		dst = &s.CloseBrowsersWithoutExtension
	case setPathServerTime:
		dst = &s.ServerTimeCheck
	case setPathExtraDomains:
		dst = &s.StudyWhitelist.ExtraDomains
	case setPathExtraProcesses:
		dst = &s.StudyWhitelist.ExtraProcesses
	default:
		return errUnknownSettingsPath
	}
	return json.Unmarshal(raw, dst)
}

var errUnknownSettingsPath = &APIError{Code: "internal", Message: "unknown settings path"}

// setPendingFromWire rebuilds pending changes from a settings_changed or epoch_started
// list: remaining = effectiveAt − atMs (clamped to the delay; the full delay when atMs is
// unknown). A change that did not restart keeps the StartedAt of prev.
func setPendingFromWire(list []PendingSettingChange, atMs int64, prev []*setPending) []*setPending {
	delay := setDelayMs()
	m := map[string]*setPending{}
	for _, w := range list {
		if !slices.Contains(setPendingPaths, w.Field) || len(w.Value) == 0 {
			continue
		}
		rem := delay
		if ea, ok := parseMs(w.EffectiveAt); ok && atMs > 0 {
			rem = min(max(ea-atMs, 0), delay)
		}
		p := &setPending{Field: w.Field, Value: bytes.Clone(w.Value), RemainingMs: rem, StartedAt: atMs - (delay - rem)}
		for _, o := range prev {
			if o.Field == w.Field && rem <= o.RemainingMs {
				p.StartedAt = o.StartedAt
			}
		}
		m[w.Field] = p
	}
	return setOrdered(m)
}

// ---------------------------------------------------------------------------------------
// Hooks the core calls
// ---------------------------------------------------------------------------------------

// applyPendingSettings decrements every pending change by dBootMs (real time, suspend
// included) and applies the ones that reach 0 (settings_changed).
func (e *Engine) applyPendingSettings(dBootMs int64) {
	list := e.state.SettingsExt.Pending
	if len(list) == 0 {
		return
	}
	due := false
	for _, p := range list {
		if dBootMs > 0 {
			p.RemainingMs -= dBootMs
		}
		due = due || p.RemainingMs <= 0
	}
	if !due {
		return
	}
	next := setNormalized(e.state.Settings)
	rest := []*setPending{}
	for _, p := range list {
		if p.RemainingMs > 0 {
			rest = append(rest, p)
			continue
		}
		if err := setAssign(&next, p.Field, p.Value); err != nil {
			e.log.Warn("pending settings change dropped", "field", p.Field, "err", err)
		}
	}
	next = setNormalized(next)
	b := e.newBatch()
	b.add(EvSettingsChanged, SettingsChangedData{Settings: next, Pending: setWire(rest, b.at, 0)})
	e.commitNow(b, "pending settings")
}

// pendingSettingsWire is /v1/state.pendingSettings (effectiveAt = now + remainingMs,
// display time). The estimate is rounded up to the second: the trusted clock may run a
// few ppm apart from the boot clock the delay runs on, and a millisecond drift must not
// change the /v1/state payload (and its stateVersion) on every tick.
func (e *Engine) pendingSettingsWire(offsetMs int64) []PendingSettingChange {
	out := setWire(e.state.SettingsExt.Pending, e.now, offsetMs)
	for i, p := range e.state.SettingsExt.Pending {
		ms := e.now + max(0, p.RemainingMs) + offsetMs
		out[i].EffectiveAt = fmtMs(ceilDiv(ms, 1000) * 1000)
	}
	return out
}

// creditVerifiedDowntime subtracts downtime a network time check verified (§5.8) from the
// changes that were already pending when the previous run stopped; the next step applies
// those that reach 0.
func (e *Engine) creditVerifiedDowntime(ms int64) {
	if ms <= 0 {
		return
	}
	for _, p := range e.state.SettingsExt.Pending {
		if p.StartedAt <= e.cal.stopT {
			p.RemainingMs -= ms
		}
	}
	e.markDirty(true)
}

// keptPending are the pending changes an epoch keeps (a data deletion drops the
// studyWhitelist ones, §10.11 step 2), in trusted time.
func (e *Engine) keptPending(dataDeletion bool) []PendingSettingChange {
	var keep []*setPending
	for _, p := range e.state.SettingsExt.Pending {
		if dataDeletion && strings.HasPrefix(p.Field, "studyWhitelist.") {
			continue
		}
		keep = append(keep, p)
	}
	return setWire(keep, e.now, 0)
}

// restoreKeptPending replaces the pending changes with epoch_started.kept. A live epoch
// start (e.now is the event's time) keeps every remaining delay exactly; an epoch replayed
// from the log at startup, before the clock is restored, restarts them (the safe side).
func (e *Engine) restoreKeptPending(list []PendingSettingChange) {
	e.state.SettingsExt.Pending = setPendingFromWire(list, e.now, e.state.SettingsExt.Pending)
}

// applySettingsChanged is the reducer of settings_changed: the effective settings and the
// pending list.
func (e *Engine) applySettingsChanged(ev *storeEvent) error {
	var d SettingsChangedData
	if err := json.Unmarshal(ev.Data, &d); err != nil {
		return err
	}
	e.state.Settings = setNormalized(d.Settings)
	e.state.SettingsExt.Pending = setPendingFromWire(d.Pending, atMs(ev), e.state.SettingsExt.Pending)
	return nil
}

// detectOSZone returns the OS IANA zone, or "" when it cannot be told. POSIX systems
// name it through the TZ variable or the /etc/localtime link into a zoneinfo tree;
// Windows maps the registry TimeZoneKeyName through the CLDR windowsZones table
// (settings_windows.go).
func detectOSZone() string {
	if runtime.GOOS == "windows" {
		return windowsOSZone()
	}
	if tz := strings.TrimPrefix(os.Getenv("TZ"), ":"); tz != "" && !filepath.IsAbs(tz) {
		if _, ok := loadLocation(tz); ok {
			return tz
		}
	}
	target, err := os.Readlink("/etc/localtime")
	if err != nil {
		return ""
	}
	i := strings.LastIndex(target, "zoneinfo/")
	if i < 0 {
		return ""
	}
	name := target[i+len("zoneinfo/"):]
	name = strings.TrimPrefix(name, "posix/")
	if _, ok := loadLocation(name); !ok {
		return ""
	}
	return name
}
