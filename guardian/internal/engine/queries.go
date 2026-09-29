package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/points"
	"github.com/imdlodoem23/centrate/guardian/internal/procwatch"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// GET-style queries: health, the /v1/state aggregate, diagnostics, points and the event
// log page (with its long poll).

// Health is GET /v1/health.
func (e *Engine) Health(ctx context.Context) (HealthResponse, error) {
	return run(e, ctx, cmdOpts{}, func() (HealthResponse, error) {
		api := embedded.API()
		caps := slices.Clone(api.Capabilities)
		if e.o.TestHooks {
			caps = append(caps, "testhooks")
		}
		return HealthResponse{
			OK:             true,
			Name:           "centrate-guardian",
			Version:        e.o.Version,
			APIVersion:     api.APIVersion,
			Capabilities:   caps,
			SchemaVersion:  store.SchemaVersion,
			CatalogVersion: e.cat.Version(),
			RulesVersion:   points.RulesVersion(),
			StartedAt:      e.display(e.startedAt),
			ServerNow:      e.serverNow(),
			Mode:           e.mode,
			Problems:       nonNil(e.problems()),
		}, nil
	})
}

// State is GET /v1/state. The API layer answers 304 when If-None-Match names
// StateVersion.
func (e *Engine) State(ctx context.Context) (GuardianStateResponse, error) {
	return run(e, ctx, cmdOpts{}, func() (GuardianStateResponse, error) { return e.stateResponse(), nil })
}

// stateResponse builds the aggregate and keeps stateVersion honest: it increases
// whenever anything visible in the payload changed since the version was last served
// (§8.5), so a cached ETag never hides a change.
func (e *Engine) stateResponse() GuardianStateResponse {
	W := e.wallOffsetMs()
	r := GuardianStateResponse{
		Epoch:           e.state.Epoch,
		LastEventSeq:    e.state.LastEventSeq,
		Guardian:        GuardianInfo{Version: e.o.Version, APIVersion: embedded.API().APIVersion, Mode: e.mode, Problems: nonNil(e.problems())},
		Clock:           e.clockStatus(),
		Protection:      e.protection(),
		Blocks:          []Block{},
		Punishments:     []Punishment{},
		NuclearActive:   e.nuclearActive(),
		Study:           e.studyWire(W),
		Emergency:       e.emergencyWire(W),
		Allowances:      nonNil(e.allowancesWire(W)),
		RewardsLock:     strPtrOrNil(e.rewardsLock()),
		NextSchedule:    e.nextScheduleInfo(W),
		Limits:          e.limitsWire(W, false),
		Points:          e.pointsSummary(),
		PendingSettings: nonNil(e.pendingSettingsWire(W)),
		Recent: RecentInfo{
			EndedBlocks: e.recentEndedBlocks(),
			EndedStudy:  e.studyRecentEnded(W),
		},
	}
	for _, b := range e.sortedActive() {
		r.Blocks = append(r.Blocks, e.blockWire(b, W))
	}
	for _, p := range e.activePunishments() {
		r.Punishments = append(r.Punishments, punishmentWire(p, W))
	}
	raw, _ := json.Marshal(r)
	sum := sha256.Sum256(raw)
	fp := hex.EncodeToString(sum[:])
	if fp != e.stateFP {
		if e.stateFPVer == e.state.Versions.State {
			e.bumpState()
			e.markDirty(false)
		}
		e.stateFP, e.stateFPVer = fp, e.state.Versions.State
	}
	r.StateVersion = e.state.Versions.State
	r.ServerNow = e.serverNow()
	return r
}

// Points is GET /v1/points.
func (e *Engine) Points(ctx context.Context) (PointsResponse, error) {
	return run(e, ctx, cmdOpts{}, func() (PointsResponse, error) { return PointsResponse{Points: e.pointsSummary()}, nil })
}

// Diagnostics is GET /v1/diagnostics: no domains, reasons, tasks or usernames.
func (e *Engine) Diagnostics(ctx context.Context) (DiagnosticsResponse, error) {
	return run(e, ctx, cmdOpts{}, func() (DiagnosticsResponse, error) {
		st := e.st.Stats()
		var stateBytes int64
		if fi, err := os.Stat(e.o.DataDir + string(os.PathSeparator) + "state.json"); err == nil {
			stateBytes = fi.Size()
		}
		bootName, awakeName := "unknown", "unknown"
		if n, ok := e.o.Clock.(clockNames); ok {
			bootName, awakeName = n.BootClockName(), n.AwakeClockName()
		}
		errs := []DiagnosticsError{}
		for _, d := range e.errCounts {
			errs = append(errs, *d)
		}
		slices.SortFunc(errs, func(a, b DiagnosticsError) int { return strings.Compare(a.Code, b.Code) })
		return DiagnosticsResponse{
			Guardian: DiagnosticsGuardian{
				Version: e.o.Version, Commit: e.o.Commit, GoVersion: runtime.Version(), OS: runtime.GOOS, Arch: runtime.GOARCH,
				ServiceManager: e.o.ServiceManager, PID: os.Getpid(), Port: e.o.Port, StartedAt: e.display(e.startedAt),
				UptimeMs: (e.bootNow - e.startBoot).Milliseconds(), Mode: e.mode,
			},
			State: DiagnosticsState{
				SchemaVersion: store.SchemaVersion, Epoch: st.Epoch, LastEventSeq: st.LastSeq, Integrity: e.integrity,
				StateBytes: stateBytes, EventsBytes: st.LogBytes,
			},
			Clock: DiagnosticsClock{
				WallOffsetMs: e.wallOffsetMs(), Trust: e.trust(), BootClock: bootName, AwakeClock: awakeName,
				Jumps24h: len(e.state.Clock.Jumps), LastCalibration: e.cal.last,
			},
			Hosts: DiagnosticsHosts{
				Path: sanitizePath(e.o.HostsPath), PathOverridden: e.o.HostsPathRedirected(), Status: e.hostsStatus(),
				Entries: len(e.hosts.applied), LastWriteAt: e.displayPtr(e.hosts.lastAppliedAt),
				LastVerifyAt: e.displayPtr(e.hosts.lastVerifyAt), Tamper24h: len(e.tampers), LastFlush: e.hosts.lastFlush,
			},
			ProcessWatcher: DiagnosticsWatcher{IntervalMs: e.o.ProcessInterval.Milliseconds(), LastScanMs: 0, Kills24h: len(e.kills)},
			Extensions:     nonNil(e.extensionsStatus()),
			CatalogVersion: e.cat.Version(),
			RulesVersion:   points.RulesVersion(),
			Errors:         errs,
		}, nil
	})
}

var (
	winProfileRE   = regexp.MustCompile(`(?i)^[a-z]:\\users\\[^\\]+`)
	posixProfileRE = regexp.MustCompile(`^/(?:home|Users)/[^/]+`)
)

// sanitizePath replaces a user-profile prefix with %USERPROFILE% (Windows) or ~, so
// diagnostics never carry a username (§8.8).
func sanitizePath(p string) string {
	if winProfileRE.MatchString(p) {
		return winProfileRE.ReplaceAllString(p, "%USERPROFILE%")
	}
	return posixProfileRE.ReplaceAllString(p, "~")
}

// Events is GET /v1/events (§8.8). It reads the store directly (the store is safe for
// concurrent use), so a long poll never occupies the engine goroutine: with waitMs > 0
// and nothing after the cursor it waits for the next commit, the timeout or ctx.
func (e *Engine) Events(ctx context.Context, q EventsQuery) (EventsResponse, error) {
	l := limits()
	after := int64(0)
	if q.After != nil {
		after = *q.After
	}
	limit := l.EventsPageDefault
	if q.Limit != nil {
		limit = *q.Limit
	}
	wait := 0
	if q.WaitMs != nil {
		wait = *q.WaitMs
	}
	if after < 0 || limit < 1 || limit > l.EventsPageMax || wait < 0 || wait > l.LongPollMaxMs {
		return EventsResponse{}, badQuery("after, limit or waitMs out of range")
	}
	e.lifeMu.Lock()
	st, opened := e.st, e.opened
	e.lifeMu.Unlock()
	if !opened || st == nil {
		return EventsResponse{}, ErrNotOpen
	}
	var timer <-chan time.Time
	if wait > 0 {
		t := time.NewTimer(time.Duration(wait) * time.Millisecond)
		defer t.Stop()
		timer = t.C
	}
	for {
		woke := e.eventsNotify.wait()
		page, err := st.ReadEvents(q.Epoch, after, limit)
		if err != nil {
			return EventsResponse{}, apiErr("internal", "the event log could not be read", nil)
		}
		if len(page.Events) > 0 || page.Reset || timer == nil {
			return eventsResponse(page)
		}
		select {
		case <-woke:
		case <-timer:
			return eventsResponse(page)
		case <-ctx.Done():
			return EventsResponse{}, ctx.Err()
		}
	}
}

func eventsResponse(p store.Page) (EventsResponse, error) {
	out := EventsResponse{Epoch: p.Epoch, Reset: p.Reset, Events: []json.RawMessage{}, LastSeq: p.LastSeq, HasMore: p.HasMore}
	for _, ev := range p.Events {
		raw, err := ev.WireJSON()
		if err != nil {
			return EventsResponse{}, apiErr("internal", "an event could not be encoded", nil)
		}
		out.Events = append(out.Events, raw)
	}
	return out, nil
}

// Matcher returns the process watcher's current matcher (safe for concurrent use).
func (e *Engine) Matcher() procwatch.Matcher { return *e.matcher.Load() }
