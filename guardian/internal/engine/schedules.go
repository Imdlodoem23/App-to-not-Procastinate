package engine

// OWNER: schedules teammate (docs/ARCHITECTURE.md §5.3, §10.3, §8.8 «Schedules»).
//
// A schedule is a weekly rule («de lunes a viernes de 16:00 a 19:00») evaluated in its own
// IANA zone with the embedded tzdata, in trusted time: a wall-clock change can neither skip
// nor repeat an occurrence. Each occurrence materializes once as an independent block of
// kind schedule (never refused for budgets) and its key (<scheduleId>@<localDate>) is
// remembered for 8 days, also across epochs, so it is never created twice. PUT and DELETE
// are refused while an occurrence is in progress, and weakening edits (a delete included)
// are refused within scheduleFreezeMinutes of the next start.

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
)

// Rules of §10.3 that the generated data does not carry.
const (
	// schHorizonDays: nextOccurrence looks this many days ahead and materialized
	// occurrence keys are remembered this long.
	schHorizonDays = 8
	schHorizonMs   = int64(schHorizonDays * 24 * time.Hour / time.Millisecond)
	// schMinRemainingMs: an occurrence activated with less than this left creates no
	// block (nothing meaningful left); it still counts as materialized.
	schMinRemainingMs = int64(time.Minute / time.Millisecond)
	// schClockTimeMaxLen is the length cap of clockTime in guardian-api.ts.
	schClockTimeMaxLen = 5
	// schZoneMaxLen is the length cap of the timezone schema in guardian-api.ts.
	schZoneMaxLen = 64
	// schDaysMax is the number of ISO weekdays.
	schDaysMax = 7
)

var (
	// schClockTimeRE is CLOCK_TIME_RE of guardian-api.ts ("HH:MM", 00:00–23:59).
	schClockTimeRE = regexp.MustCompile(`^(?:[01]\d|2[0-3]):[0-5]\d$`)
	// schZoneRE is TIMEZONE_RE of guardian-api.ts.
	schZoneRE = regexp.MustCompile(`^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+){1,2})$`)
)

// schedulesState is the persisted schedules state (state.json "engine.schedules"): the
// schedules in creation order and the materialized occurrences.
type schedulesState struct {
	List []*scheduleRec `json:"list"`
	// Materialized maps occurrence keys (<scheduleId>@<localDate>) to when they were
	// materialized. An entry is written after the occurrence's block is committed (or when
	// it had too little left to create one) and kept for schHorizonDays, even when the
	// block is later cancelled: an occurrence is never re-created.
	Materialized map[string]schOccMark `json:"materialized"`
}

// scheduleRec is a Schedule in trusted time, without the derived fields.
type scheduleRec struct {
	ID            string         `json:"id"`
	Name          string         `json:"name"`
	Enabled       bool           `json:"enabled"`
	Days          []int          `json:"days"`
	Start         string         `json:"start"`
	End           string         `json:"end"`
	Timezone      string         `json:"timezone"`
	Targets       TargetSpec     `json:"targets"`
	WhitelistOnly bool           `json:"whitelistOnly"`
	Allow         WhitelistAllow `json:"allow"`
	Mode          string         `json:"mode"`
	Reason        string         `json:"reason"`
	CreatedAt     int64          `json:"createdAt"`
	UpdatedAt     int64          `json:"updatedAt"`
}

// schOccMark records a materialized occurrence.
type schOccMark struct {
	// At is the trusted time it was materialized (0: carried by epoch_started, unknown).
	At int64 `json:"at"`
	// StartsAt and EndsAt are the occurrence's trusted window (0: unknown).
	StartsAt int64 `json:"startsAt"`
	EndsAt   int64 `json:"endsAt"`
}

// schOcc is one occurrence of a schedule (trusted times).
type schOcc struct {
	Key   string
	Date  schDate
	Start int64
	End   int64
}

// schDate is a local calendar date.
type schDate struct {
	Y int
	M time.Month
	D int
}

func (d schDate) String() string { return fmt.Sprintf("%04d-%02d-%02d", d.Y, int(d.M), d.D) }

// addDays returns the date n days later (normalized through UTC noon: no DST involved).
func (d schDate) addDays(n int) schDate {
	t := time.Date(d.Y, d.M, d.D+n, 12, 0, 0, 0, time.UTC)
	y, m, dd := t.Date()
	return schDate{y, m, dd}
}

// isoWeekday is the ISO weekday (Monday 1 … Sunday 7) of the date.
func (d schDate) isoWeekday() int {
	w := int(time.Date(d.Y, d.M, d.D, 12, 0, 0, 0, time.UTC).Weekday())
	if w == 0 {
		return 7
	}
	return w
}

// ScheduleInput mirrors ScheduleInput.
type ScheduleInput struct {
	Name                   string         `json:"name"`
	Enabled                bool           `json:"enabled"`
	Days                   []int          `json:"days"`
	Start                  string         `json:"start"`
	End                    string         `json:"end"`
	Timezone               string         `json:"timezone"`
	Targets                TargetSpec     `json:"targets"`
	WhitelistOnly          bool           `json:"whitelistOnly"`
	Allow                  WhitelistAllow `json:"allow"`
	Mode                   string         `json:"mode"`
	Reason                 string         `json:"reason"`
	AcknowledgeNoEmergency bool           `json:"acknowledgeNoEmergency"`
}

// ScheduleResponse mirrors ScheduleResponse.
type ScheduleResponse struct {
	Schedule Schedule `json:"schedule"`
}

// ListSchedulesResponse mirrors ListSchedulesResponse.
type ListSchedulesResponse struct {
	Schedules []Schedule `json:"schedules"`
}

// ListSchedules is GET /v1/schedules.
func (e *Engine) ListSchedules(ctx context.Context) (ListSchedulesResponse, error) {
	return run(e, ctx, cmdOpts{}, func() (ListSchedulesResponse, error) { return e.listSchedules() })
}

func (e *Engine) listSchedules() (ListSchedulesResponse, error) {
	W := e.wallOffsetMs()
	out := []Schedule{}
	for _, s := range e.state.Schedules.List {
		out = append(out, e.scheduleWire(s, W))
	}
	return ListSchedulesResponse{Schedules: out}, nil
}

// CreateSchedule is POST /v1/schedules (idempotent, 201).
func (e *Engine) CreateSchedule(ctx context.Context, r Request, in ScheduleInput) (ScheduleResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem, status: 201}, func() (ScheduleResponse, error) {
		return e.createSchedule(in)
	})
}

func (e *Engine) createSchedule(in ScheduleInput) (ScheduleResponse, error) {
	rec, err := e.schValidate(in)
	if err != nil {
		return ScheduleResponse{}, err
	}
	l := limits()
	if len(e.state.Schedules.List) >= l.MaxSchedules {
		ae := issueErr("", "length", fmt.Sprintf("at most %d schedules", l.MaxSchedules))
		ae.Details["limit"] = l.MaxSchedules
		return ScheduleResponse{}, ae
	}
	if err := e.schFinalChecks(rec, "", in.AcknowledgeNoEmergency); err != nil {
		return ScheduleResponse{}, err
	}
	rec.ID = newID("sch")
	rec.CreatedAt, rec.UpdatedAt = e.now, e.now
	b := e.newBatch()
	b.add(EvScheduleCreated, ScheduleData{Schedule: e.scheduleWire(rec, 0)})
	if err := e.commit(b); err != nil {
		return ScheduleResponse{}, err
	}
	// An occurrence already in progress starts now (late activation, §10.3).
	e.activateSchedules(e.now)
	return e.schResponse(rec.ID)
}

// schResponse is the response of a committed create or update (display time).
func (e *Engine) schResponse(id string) (ScheduleResponse, error) {
	s := e.schedule(id)
	if s == nil {
		return ScheduleResponse{}, apiErr("internal", "the schedule was not applied", nil)
	}
	return ScheduleResponse{Schedule: e.scheduleWire(s, e.wallOffsetMs())}, nil
}

// UpdateSchedule is PUT /v1/schedules/{id} (full replace, with the guards of §8.8).
func (e *Engine) UpdateSchedule(ctx context.Context, r Request, id string, in ScheduleInput) (ScheduleResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem}, func() (ScheduleResponse, error) {
		return e.updateSchedule(id, in)
	})
}

func (e *Engine) updateSchedule(id string, in ScheduleInput) (ScheduleResponse, error) {
	old := e.schedule(id)
	if old == nil {
		return ScheduleResponse{}, notFound("schedule")
	}
	rec, err := e.schValidate(in)
	if err != nil {
		return ScheduleResponse{}, err
	}
	if err := e.schGuards(old, rec); err != nil {
		return ScheduleResponse{}, err
	}
	if err := e.schFinalChecks(rec, id, in.AcknowledgeNoEmergency); err != nil {
		return ScheduleResponse{}, err
	}
	rec.ID = id
	rec.CreatedAt, rec.UpdatedAt = old.CreatedAt, e.now
	b := e.newBatch()
	b.add(EvScheduleUpdated, ScheduleData{Schedule: e.scheduleWire(rec, 0)})
	if err := e.commit(b); err != nil {
		return ScheduleResponse{}, err
	}
	e.activateSchedules(e.now)
	return e.schResponse(id)
}

// DeleteSchedule is DELETE /v1/schedules/{id} (204).
func (e *Engine) DeleteSchedule(ctx context.Context, r Request, id string) error {
	_, err := run(e, ctx, cmdOpts{write: true, idem: r.Idem}, func() (struct{}, error) {
		return struct{}{}, e.deleteSchedule(id)
	})
	return err
}

func (e *Engine) deleteSchedule(id string) error {
	old := e.schedule(id)
	if old == nil {
		return notFound("schedule")
	}
	// Deleting counts as weakening (nil: no replacement).
	if err := e.schGuards(old, nil); err != nil {
		return err
	}
	b := e.newBatch()
	b.add(EvScheduleDeleted, ScheduleDeletedData{ScheduleID: id})
	return e.commit(b)
}

// ---------------------------------------------------------------------------------------
// Validation and guards
// ---------------------------------------------------------------------------------------

// schZoneIssue validates an IANA zone name like the timezone schema of guardian-api.ts,
// plus loadability by the embedded tzdata (422 invalid_timezone through issueErr).
func schZoneIssue(path, tz string) *APIError {
	if n := catalog.UTF16Len(tz); n < 1 || n > schZoneMaxLen {
		return issueErr(path, "length", fmt.Sprintf("length in [1, %d]", schZoneMaxLen))
	}
	if !schZoneRE.MatchString(tz) {
		return issueErr(path, "pattern", "IANA time zone")
	}
	if tz == "Local" {
		return issueErr(path, "rule", `"Local" is not allowed`)
	}
	if _, ok := loadLocation(tz); !ok {
		return issueErr(path, "rule", "unknown IANA time zone")
	}
	return nil
}

// schValidate validates a ScheduleInput in the order of scheduleInputSchema (shape, then
// the refinements), then the semantic checks shared with blocks (unknown ids, protected
// custom domains, distractions in allow). It returns the schedule without id and times.
func (e *Engine) schValidate(in ScheduleInput) (*scheduleRec, *APIError) {
	l := limits()
	in.Targets = in.Targets.normalized()
	in.Allow = in.Allow.normalized()
	if issue := catalog.TextFieldIssue(catalog.FieldScheduleName, in.Name); issue != "" {
		return nil, issueErr("name", issue, "invalid schedule name")
	}
	if len(in.Days) < 1 || len(in.Days) > schDaysMax {
		return nil, issueErr("days", "length", fmt.Sprintf("between 1 and %d items", schDaysMax))
	}
	for i, d := range in.Days {
		p := fmt.Sprintf("days[%d]", i)
		if d < 1 || d > schDaysMax {
			return nil, issueErr(p, "enum", "an ISO weekday (1 = Monday … 7 = Sunday)")
		}
		if slices.Index(in.Days, d) != i {
			return nil, issueErr(p, "duplicate", "duplicate")
		}
	}
	for _, f := range []struct{ path, v string }{{"start", in.Start}, {"end", in.End}} {
		if catalog.UTF16Len(f.v) > schClockTimeMaxLen {
			return nil, issueErr(f.path, "length", fmt.Sprintf("length in [0, %d]", schClockTimeMaxLen))
		}
		if !schClockTimeRE.MatchString(f.v) {
			return nil, issueErr(f.path, "pattern", "HH:MM")
		}
	}
	if err := schZoneIssue("timezone", in.Timezone); err != nil {
		return nil, err
	}
	if err := e.validateTargetsShape(in.Targets, in.Allow); err != nil {
		return nil, err
	}
	if !slices.Contains(blockModes, in.Mode) {
		return nil, issueErr("mode", "enum", "unknown mode")
	}
	if issue := catalog.TextFieldIssue(catalog.FieldReason, in.Reason); issue != "" {
		return nil, issueErr("reason", issue, "invalid reason")
	}
	if in.Start == in.End {
		return nil, issueErr("end", "rule", "end must differ from start")
	}
	if schWindowMinutes(in.Start, in.End) < l.BlockMinMinutes {
		return nil, issueErr("end", "rule", fmt.Sprintf("window shorter than %d min", l.BlockMinMinutes))
	}
	if err := targetRules(in.Targets, in.WhitelistOnly, in.Allow, in.Mode); err != nil {
		return nil, err
	}
	if err := e.validateSemanticTargets(in.Targets, in.Allow); err != nil {
		return nil, err
	}
	days := slices.Clone(in.Days)
	slices.Sort(days)
	return &scheduleRec{
		Name: in.Name, Enabled: in.Enabled, Days: days, Start: in.Start, End: in.End, Timezone: in.Timezone,
		Targets: in.Targets, WhitelistOnly: in.WhitelistOnly, Allow: in.Allow, Mode: in.Mode, Reason: in.Reason,
	}, nil
}

// schFinalChecks are the checks after the guards: the custom-host budget of enabled
// schedules (§5.2; exclude is the schedule being replaced) and the no-emergency
// confirmation of hardcore and exam schedules.
func (e *Engine) schFinalChecks(rec *scheduleRec, exclude string, acknowledged bool) *APIError {
	l := limits()
	if rec.Enabled {
		if requested := e.customHostCount(rec.Targets.CustomDomains); requested > 0 {
			current := 0
			for _, s := range e.state.Schedules.List {
				if s.Enabled && s.ID != exclude {
					current += e.customHostCount(s.Targets.CustomDomains)
				}
			}
			if current+requested > l.MaxScheduleCustomHosts {
				return apiErr("too_many_targets", "too many custom hosts across enabled schedules",
					map[string]any{"limit": l.MaxScheduleCustomHosts, "current": current, "requested": requested, "kind": "custom_hosts"})
			}
		}
	}
	if (rec.Mode == ModeHardcore || rec.Mode == ModeExam) && !acknowledged {
		return apiErr("confirmation_required", "the schedule needs an explicit confirmation", map[string]any{"needs": []string{"no_emergency"}})
	}
	return nil
}

// schGuards are the guards of PUT (nw is the replacement) and DELETE (nw nil), evaluated
// in trusted time (§8.8, §10.3): no change while an occurrence is in progress, and no
// weakening change within the freeze before the next start.
func (e *Engine) schGuards(old, nw *scheduleRec) *APIError {
	if blk := e.schActiveBlock(old.ID); blk != nil {
		return apiErr("schedule_in_progress", "the schedule has an occurrence in progress",
			map[string]any{"blockId": blk.ID, "endsAt": e.display(blk.EndsAt)})
	}
	next := e.schNext(old)
	if next == nil || next.Start-e.now > int64(limits().ScheduleFreezeMinutes)*msPerMinute {
		return nil
	}
	if nw == nil || schWeakening(old, nw, next) {
		return apiErr("schedule_starting_soon", "the schedule starts soon: weakening changes wait until it ends",
			map[string]any{"startsAt": e.display(next.Start)})
	}
	return nil
}

// schWeakening reports whether replacing old by nw weakens the next occurrence next
// (§10.3): disabling; removing a target id, custom entry or day; changing the time zone;
// a window that does not contain the old window of next's date; a lower mode rank;
// whitelistOnly true → false; adding allow entries. Renaming and the reason are neutral.
func schWeakening(old, nw *scheduleRec, next *schOcc) bool {
	if old.Enabled && !nw.Enabled {
		return true
	}
	ot, nt := old.Targets, nw.Targets
	for _, p := range [][2][]string{
		{ot.ServiceIDs, nt.ServiceIDs}, {ot.CategoryIDs, nt.CategoryIDs}, {ot.AppIDs, nt.AppIDs},
		{ot.CustomDomains, nt.CustomDomains}, {ot.CustomProcesses, nt.CustomProcesses},
	} {
		if !schSubset(p[0], p[1]) {
			return true
		}
	}
	if !schSubset(old.Days, nw.Days) || old.Timezone != nw.Timezone || modeRank(nw.Mode) < modeRank(old.Mode) {
		return true
	}
	if old.WhitelistOnly && !nw.WhitelistOnly {
		return true
	}
	if !schSubset(nw.Allow.CustomDomains, old.Allow.CustomDomains) || !schSubset(nw.Allow.CustomProcesses, old.Allow.CustomProcesses) {
		return true
	}
	loc, ok := loadLocation(nw.Timezone)
	if !ok {
		return true
	}
	occ, ok := schOccurrenceOn(nw, loc, next.Date, true)
	return !ok || occ.Start > next.Start || occ.End < next.End
}

// schSubset reports whether every element of a is in b.
func schSubset[T comparable](a, b []T) bool {
	for _, v := range a {
		if !slices.Contains(b, v) {
			return false
		}
	}
	return true
}

// schClockMinutes is "HH:MM" in minutes after midnight (valid input only).
func schClockMinutes(t string) int {
	h, _ := strconv.Atoi(t[:2])
	m, _ := strconv.Atoi(t[3:5])
	return h*60 + m
}

// schWindowMinutes is scheduleWindowMinutes of guardian-api.ts: the window length in
// minutes, wrapping to the next day when end <= start.
func schWindowMinutes(start, end string) int {
	d := schClockMinutes(end) - schClockMinutes(start)
	if d <= 0 {
		d += 24 * 60
	}
	return d
}

// ---------------------------------------------------------------------------------------
// Occurrences
// ---------------------------------------------------------------------------------------

// schWallInstant is the trusted instant (Unix ms) of a local wall time in loc: in a DST
// gap the first valid instant after it (the transition), in a DST overlap the earliest
// of the two instants (§10.3).
func schWallInstant(d schDate, minutes int, loc *time.Location) int64 {
	naive := time.Date(d.Y, d.M, d.D, minutes/60, minutes%60, 0, 0, time.UTC)
	var offs []int
	for _, probe := range []time.Duration{-26 * time.Hour, 0, 26 * time.Hour} {
		if _, off := naive.Add(probe).In(loc).Zone(); !slices.Contains(offs, off) {
			offs = append(offs, off)
		}
	}
	best, found, maxOff := int64(0), false, offs[0]
	for _, off := range offs {
		maxOff = max(maxOff, off)
		t := naive.Add(-time.Duration(off) * time.Second)
		if _, o := t.In(loc).Zone(); o == off {
			if ms := t.UnixMilli(); !found || ms < best {
				best, found = ms, true
			}
		}
	}
	if found {
		return best
	}
	// A gap: the instant read with the largest offset still lies before the transition
	// that skipped this wall time; the zone in effect there ends at that transition.
	t := naive.Add(-time.Duration(maxOff) * time.Second)
	if _, end := t.In(loc).ZoneBounds(); !end.IsZero() {
		return end.UnixMilli()
	}
	return time.Date(d.Y, d.M, d.D, minutes/60, minutes%60, 0, 0, loc).UnixMilli()
}

// schOccurrenceOn is the occurrence of s that starts on the local date d (checkDays:
// only if d is one of its days). ok is false when there is none or when DST leaves an
// empty window.
func schOccurrenceOn(s *scheduleRec, loc *time.Location, d schDate, checkDays bool) (schOcc, bool) {
	if checkDays && !slices.Contains(s.Days, d.isoWeekday()) {
		return schOcc{}, false
	}
	sm, em := schClockMinutes(s.Start), schClockMinutes(s.End)
	endDate := d
	if em <= sm {
		endDate = d.addDays(1)
	}
	start := schWallInstant(d, sm, loc)
	end := schWallInstant(endDate, em, loc)
	if end <= start {
		return schOcc{}, false
	}
	return schOcc{Key: s.ID + "@" + d.String(), Date: d, Start: start, End: end}, true
}

// schOccurrences lists the occurrences of s starting on the local dates from..to days
// around the local date of T, in order.
func schOccurrences(s *scheduleRec, loc *time.Location, T int64, from, to int) []schOcc {
	y, m, dd := time.UnixMilli(T).In(loc).Date()
	base := schDate{y, m, dd}
	var out []schOcc
	for i := from; i <= to; i++ {
		if occ, ok := schOccurrenceOn(s, loc, base.addDays(i), true); ok {
			out = append(out, occ)
		}
	}
	return out
}

// schNext is the next occurrence of an enabled schedule that has not started yet (the
// earliest start after T within schHorizonDays), or nil.
func (e *Engine) schNext(s *scheduleRec) *schOcc {
	if !s.Enabled {
		return nil
	}
	loc, ok := loadLocation(s.Timezone)
	if !ok {
		return nil
	}
	T := e.now
	for _, occ := range schOccurrences(s, loc, T, -1, schHorizonDays) {
		if occ.Start <= T || occ.Start > T+schHorizonMs {
			continue
		}
		if _, done := e.state.Schedules.Materialized[occ.Key]; done {
			continue
		}
		return &occ
	}
	return nil
}

// schedule returns the schedule with that id, or nil.
func (e *Engine) schedule(id string) *scheduleRec {
	for _, s := range e.state.Schedules.List {
		if s.ID == id {
			return s
		}
	}
	return nil
}

// schActiveBlock is the active block of the schedule's occurrence in progress, or nil.
func (e *Engine) schActiveBlock(id string) *blockRec {
	for _, b := range e.state.Blocks {
		if b.Status == StatusActive && b.Kind == KindSchedule && b.ScheduleID != nil && *b.ScheduleID == id {
			return b
		}
	}
	return nil
}

// scheduleWire converts a schedule (offsetMs: the wall offset for API responses, 0 in
// events) with its derived nextOccurrence and activeBlockId.
func (e *Engine) scheduleWire(s *scheduleRec, offsetMs int64) Schedule {
	w := Schedule{
		ID: s.ID, Name: s.Name, Enabled: s.Enabled, Days: cloneList(s.Days), Start: s.Start, End: s.End,
		Timezone: s.Timezone, Targets: s.Targets.normalized(), WhitelistOnly: s.WhitelistOnly,
		Allow: s.Allow.normalized(), Mode: s.Mode, Reason: s.Reason,
		CreatedAt: fmtMs(s.CreatedAt + offsetMs), UpdatedAt: fmtMs(s.UpdatedAt + offsetMs),
	}
	if next := e.schNext(s); next != nil {
		w.NextOccurrence = &NextOccurrence{StartsAt: fmtMs(next.Start + offsetMs), EndsAt: fmtMs(next.End + offsetMs)}
	}
	if s.ID != "" {
		if b := e.schActiveBlock(s.ID); b != nil {
			w.ActiveBlockID = ptr(b.ID)
		}
	}
	return w
}

// schRecFromWire reads a trusted-time Schedule snapshot (events, epoch_started.kept).
func schRecFromWire(w Schedule) (*scheduleRec, error) {
	created, ok1 := parseMs(w.CreatedAt)
	updated, ok2 := parseMs(w.UpdatedAt)
	if !ok1 || !ok2 {
		return nil, fmt.Errorf("schedule %s: invalid timestamp", w.ID)
	}
	if !schClockTimeRE.MatchString(w.Start) || !schClockTimeRE.MatchString(w.End) {
		return nil, fmt.Errorf("schedule %s: invalid window", w.ID)
	}
	days := cloneList(w.Days)
	slices.Sort(days)
	return &scheduleRec{
		ID: w.ID, Name: w.Name, Enabled: w.Enabled, Days: slices.Compact(days), Start: w.Start, End: w.End,
		Timezone: w.Timezone, Targets: w.Targets.normalized(), WhitelistOnly: w.WhitelistOnly,
		Allow: w.Allow.normalized(), Mode: w.Mode, Reason: w.Reason, CreatedAt: created, UpdatedAt: updated,
	}, nil
}

// schMark records a materialized occurrence.
func (e *Engine) schMark(occ schOcc, T int64) {
	st := &e.state.Schedules
	if st.Materialized == nil {
		st.Materialized = map[string]schOccMark{}
	}
	st.Materialized[occ.Key] = schOccMark{At: T, StartsAt: occ.Start, EndsAt: occ.End}
	e.markDirty(false)
}

// schHasOccurrenceBlock reports whether an active block of the schedule already enforces
// the occurrence ending at endMs: the occurrence was materialized but its mark was lost
// (a crash between the append and state.json). A block whose deadlines a calibration
// moved (created while the trusted clock ran ahead) no longer matches, so a forgotten
// occurrence still happens (§4).
func (e *Engine) schHasOccurrenceBlock(id string, endMs int64) bool {
	return slices.ContainsFunc(e.state.Blocks, func(b *blockRec) bool {
		return b.Status == StatusActive && b.Kind == KindSchedule && b.ScheduleID != nil && *b.ScheduleID == id &&
			b.OriginalEndsAt == endMs
	})
}

// schKeySchedule is the schedule id of an occurrence key.
func schKeySchedule(key string) string {
	id, _, _ := strings.Cut(key, "@")
	return id
}

// schKeyMark rebuilds the mark of an occurrence key carried by epoch_started (stamp
// unknown) from its schedule; without the schedule (or with an empty window) its start
// is the key's date at 00:00 UTC, an estimate good enough for pruning. The zero mark
// when the key is malformed.
func (e *Engine) schKeyMark(key string) schOccMark {
	id, date, ok := strings.Cut(key, "@")
	if !ok {
		return schOccMark{}
	}
	t, err := time.Parse(time.DateOnly, date)
	if err != nil {
		return schOccMark{}
	}
	y, m, d := t.Date()
	if s := e.schedule(id); s != nil {
		if loc, ok := loadLocation(s.Timezone); ok {
			if occ, ok := schOccurrenceOn(s, loc, schDate{y, m, d}, false); ok {
				return schOccMark{StartsAt: occ.Start, EndsAt: occ.End}
			}
		}
	}
	return schOccMark{StartsAt: t.UnixMilli()}
}

// schOccurrenceCancelled reports whether the block of a materialized occurrence (its
// schedule's block with that original end) was cancelled by an emergency.
func (e *Engine) schOccurrenceCancelled(key string, endMs int64) bool {
	id := schKeySchedule(key)
	return slices.ContainsFunc(e.state.Blocks, func(b *blockRec) bool {
		return b.Status == StatusCancelledEmergency && b.ScheduleID != nil && *b.ScheduleID == id && b.OriginalEndsAt == endMs
	})
}

// ---------------------------------------------------------------------------------------
// Hooks the core calls
// ---------------------------------------------------------------------------------------

// activateSchedules materializes the occurrences in progress (§10.3): each enabled
// schedule's occurrences of yesterday (overnight windows) and today in its zone, in
// trusted time, each at most once. A late activation enforces only the remaining time;
// a window missed entirely enforces nothing.
func (e *Engine) activateSchedules(T int64) {
	st := &e.state.Schedules
	for _, s := range st.List {
		if !s.Enabled {
			continue
		}
		loc, ok := loadLocation(s.Timezone)
		if !ok {
			continue
		}
		for _, occ := range schOccurrences(s, loc, T, -1, 0) {
			if T < occ.Start || T >= occ.End {
				continue
			}
			if _, done := st.Materialized[occ.Key]; done {
				continue
			}
			if e.schHasOccurrenceBlock(s.ID, occ.End) || occ.End-T < schMinRemainingMs {
				e.schMark(occ, T)
				continue
			}
			sid := s.ID
			b := e.newBatch()
			blk := e.newBlockSnapshot(blockSpec{
				Kind: KindSchedule, Mode: s.Mode, Targets: s.Targets, WhitelistOnly: s.WhitelistOnly,
				Allow: s.Allow, Reason: s.Reason, StartsAt: T, EndsAt: occ.End, ScheduleID: &sid,
			})
			e.addBlockCreated(b, blk, "schedule")
			if !e.commitNow(b, "schedule occurrence") {
				return // retried on the next tick
			}
			e.schMark(occ, T)
		}
	}
	e.schPrune(T)
}

// schPrune forgets materialized occurrences older than the horizon and those of
// schedules that no longer exist.
func (e *Engine) schPrune(T int64) {
	st := &e.state.Schedules
	if len(st.Materialized) == 0 {
		return
	}
	ids := make(map[string]bool, len(st.List))
	for _, s := range st.List {
		ids[s.ID] = true
	}
	cut := T - schHorizonMs
	for k, m := range st.Materialized {
		if m.StartsAt == 0 || m.StartsAt < cut || !ids[schKeySchedule(k)] {
			delete(st.Materialized, k)
		}
	}
}

// nextScheduleInfo is /v1/state.nextSchedule: the earliest next occurrence among the
// enabled schedules, or nil.
func (e *Engine) nextScheduleInfo(offsetMs int64) *NextScheduleInfo {
	var best *schOcc
	var bestS *scheduleRec
	for _, s := range e.state.Schedules.List {
		if n := e.schNext(s); n != nil && (best == nil || n.Start < best.Start) {
			best, bestS = n, s
		}
	}
	if best == nil {
		return nil
	}
	return &NextScheduleInfo{
		ScheduleID: bestS.ID, Name: bestS.Name,
		StartsAt: fmtMs(best.Start + offsetMs), EndsAt: fmtMs(best.End + offsetMs),
	}
}

// forgetOccurrencesAfter runs in the calibration correction of §4, before the batch that
// moves back by Δ every block created at or after fromMs (restoredT). It forgets the
// materialized occurrences stamped at or after fromMs whose start is after the corrected
// T: they were materialized while the trusted clock ran ahead, so the real occurrence
// still happens. Marks carried by an epoch (unknown stamp) are judged by their start
// alone: a materialized occurrence can only start after T if T was ahead when it was
// materialized.
//
// It also forgets, when stamped at or after fromMs, an occurrence whose window has not
// ended at the corrected T: its block moves back by Δ with the correction and would end
// Δ before the window does, so the remainder is materialized again by the next step
// (a late activation until the window's end). An occurrence whose block an emergency
// cancelled is never re-created.
func (e *Engine) forgetOccurrencesAfter(fromMs, T int64) {
	for k, m := range e.state.Schedules.Materialized {
		ahead := m.StartsAt > T && (m.At == 0 || m.At >= fromMs)
		running := m.At != 0 && m.At >= fromMs && m.EndsAt > T && !e.schOccurrenceCancelled(k, m.EndsAt)
		if ahead || running {
			delete(e.state.Schedules.Materialized, k)
		}
	}
	e.markDirty(true)
}

// keptSchedules are the schedules an epoch keeps (trusted time): all of them, or for a
// data deletion those in progress or inside the pre-start freeze (§10.11 step 2).
func (e *Engine) keptSchedules(dataDeletion bool) []Schedule {
	freeze := int64(limits().ScheduleFreezeMinutes) * msPerMinute
	out := []Schedule{}
	for _, s := range e.state.Schedules.List {
		if dataDeletion && e.schActiveBlock(s.ID) == nil {
			if next := e.schNext(s); next == nil || next.Start-e.now > freeze {
				continue
			}
		}
		out = append(out, e.scheduleWire(s, 0))
	}
	return out
}

// materializedOccurrences are the occurrence keys of the last schHorizonDays (sorted).
func (e *Engine) materializedOccurrences() []string {
	e.schPrune(e.now)
	out := make([]string, 0, len(e.state.Schedules.Materialized))
	for k := range e.state.Schedules.Materialized {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// restoreKeptSchedules replaces the schedules with epoch_started.kept (entries with
// invalid timestamps are dropped). Marks already known keep their stamps; the others get
// their start from the schedule.
func (e *Engine) restoreKeptSchedules(list []Schedule, materialized []string) {
	st := &e.state.Schedules
	st.List = []*scheduleRec{}
	for _, w := range list {
		rec, err := schRecFromWire(w)
		if err != nil || e.schedule(rec.ID) != nil {
			continue
		}
		st.List = append(st.List, rec)
	}
	prev := st.Materialized
	st.Materialized = map[string]schOccMark{}
	for _, k := range materialized {
		if m, ok := prev[k]; ok {
			st.Materialized[k] = m
			continue
		}
		st.Materialized[k] = e.schKeyMark(k)
	}
}

// ---------------------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------------------

func (e *Engine) applyScheduleCreated(ev *storeEvent) error {
	d, err := decode[ScheduleData](ev)
	if err != nil {
		return err
	}
	rec, err := schRecFromWire(d.Schedule)
	if err != nil {
		return fmt.Errorf("seq %d: %w", ev.Seq, err)
	}
	if e.schedule(rec.ID) != nil {
		return fmt.Errorf("seq %d: schedule %s exists", ev.Seq, rec.ID)
	}
	e.state.Schedules.List = append(e.state.Schedules.List, rec)
	return nil
}

func (e *Engine) applyScheduleUpdated(ev *storeEvent) error {
	d, err := decode[ScheduleData](ev)
	if err != nil {
		return err
	}
	rec, err := schRecFromWire(d.Schedule)
	if err != nil {
		return fmt.Errorf("seq %d: %w", ev.Seq, err)
	}
	cur := e.schedule(rec.ID)
	if cur == nil {
		return fmt.Errorf("seq %d: unknown schedule %s", ev.Seq, rec.ID)
	}
	*cur = *rec
	return nil
}

func (e *Engine) applyScheduleDeleted(ev *storeEvent) error {
	d, err := decode[ScheduleDeletedData](ev)
	if err != nil {
		return err
	}
	st := &e.state.Schedules
	n := len(st.List)
	st.List = slices.DeleteFunc(st.List, func(s *scheduleRec) bool { return s.ID == d.ScheduleID })
	if len(st.List) == n {
		return fmt.Errorf("seq %d: unknown schedule %s", ev.Seq, d.ScheduleID)
	}
	for k := range st.Materialized {
		if schKeySchedule(k) == d.ScheduleID {
			delete(st.Materialized, k)
		}
	}
	return nil
}
