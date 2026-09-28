package engine

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/points"
)

// Schedule tests (docs/ARCHITECTURE.md §5.3, §10.3, §8.8 «Schedules»). Helpers are
// prefixed sch so they never collide with the other feature files' tests. The test clock
// starts on Monday 2026-09-28 at 10:00 UTC (12:00 in Madrid).

// schIn is a valid enabled normal schedule blocking the services.
func schIn(name string, days []int, start, end, tz string, services ...string) ScheduleInput {
	t := emptyTargets()
	t.ServiceIDs = services
	return ScheduleInput{Name: name, Enabled: true, Days: days, Start: start, End: end, Timezone: tz, Targets: t, Allow: emptyAllow(), Mode: ModeNormal}
}

func schCreate(t *testing.T, env *testEnv, in ScheduleInput) Schedule {
	t.Helper()
	res, err := env.e.CreateSchedule(bg, Request{Scope: "app"}, in)
	if err != nil {
		t.Fatalf("CreateSchedule(%s): %v", in.Name, err)
	}
	return res.Schedule
}

// schForward moves real time with the machine awake, one engine step per chunk.
func schForward(env *testEnv, d, chunk time.Duration) {
	for d > 0 {
		s := min(chunk, d)
		env.clk.Advance(s)
		d -= s
		env.e.Step()
	}
}

// schForwardTo moves real time to the wall-clock instant at (UTC, no jumps pending).
func schForwardTo(env *testEnv, at time.Time, chunk time.Duration) {
	schForward(env, at.Sub(env.clk.Wall()), chunk)
}

// schBlocks returns the blocks (any status) of a schedule.
func schBlocks(e *Engine, id string) []*blockRec {
	var out []*blockRec
	for _, b := range e.state.Blocks {
		if b.ScheduleID != nil && *b.ScheduleID == id {
			out = append(out, b)
		}
	}
	return out
}

func schAt(h, m int) time.Time { return time.Date(2026, 9, 28, h, m, 0, 0, time.UTC) }

func TestSchedulesCreateListAndNext(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	s := schCreate(t, env, schIn("Tarde", []int{5, 1, 2, 3, 4}, "16:00", "19:00", "UTC", "youtube"))
	if !isIDOf(s.ID, "sch") || !slices.Equal(s.Days, []int{1, 2, 3, 4, 5}) || s.ActiveBlockID != nil {
		t.Fatalf("schedule %+v", s)
	}
	if s.NextOccurrence == nil || s.NextOccurrence.StartsAt != "2026-09-28T16:00:00.000Z" || s.NextOccurrence.EndsAt != "2026-09-28T19:00:00.000Z" {
		t.Fatalf("nextOccurrence %+v", s.NextOccurrence)
	}
	if s.CreatedAt != "2026-09-28T10:00:00.000Z" || s.UpdatedAt != s.CreatedAt {
		t.Fatalf("times %s %s", s.CreatedAt, s.UpdatedAt)
	}
	list, err := e.ListSchedules(bg)
	if err != nil || len(list.Schedules) != 1 || list.Schedules[0].ID != s.ID {
		t.Fatalf("list %+v %v", list, err)
	}
	st := env.state()
	if st.NextSchedule == nil || st.NextSchedule.ScheduleID != s.ID || st.NextSchedule.Name != "Tarde" || st.NextSchedule.StartsAt != s.NextOccurrence.StartsAt {
		t.Fatalf("nextSchedule %+v", st.NextSchedule)
	}
	evs := env.eventsOf(EvScheduleCreated)
	if len(evs) != 1 {
		t.Fatalf("schedule_created %d", len(evs))
	}
	if d := mustDecode[ScheduleData](t, evs[0]); d.Schedule.ID != s.ID || d.Schedule.CreatedAt != evs[0].At {
		t.Fatalf("event snapshot %+v", d.Schedule)
	}

	// Display times follow the wall clock; the schedule itself does not move.
	env.clk.JumpWall(2 * time.Hour)
	e.Step()
	list, _ = e.ListSchedules(bg)
	if got := list.Schedules[0].NextOccurrence.StartsAt; got != "2026-09-28T18:00:00.000Z" {
		t.Fatalf("display nextOccurrence after +2 h %s", got)
	}
	// A disabled schedule has no next occurrence and no nextSchedule.
	in := schIn("Tarde", []int{1, 2, 3, 4, 5}, "16:00", "19:00", "UTC", "youtube")
	in.Enabled = false
	res, err := e.UpdateSchedule(bg, Request{}, s.ID, in)
	if err != nil || res.Schedule.NextOccurrence != nil || res.Schedule.Enabled {
		t.Fatalf("disable %+v %v", res.Schedule, err)
	}
	if env.state().NextSchedule != nil {
		t.Fatal("nextSchedule of a disabled schedule")
	}
}

func isIDOf(id, prefix string) bool {
	return len(id) == len(prefix)+23 && id[:len(prefix)+1] == prefix+"_"
}

func TestSchedulesValidation(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	ok := func() ScheduleInput { return schIn("Tarde", []int{1}, "16:00", "19:00", "Europe/Madrid", "youtube") }
	cases := []struct {
		name   string
		mutate func(*ScheduleInput)
		code   string
		path   string
	}{
		{"empty name", func(in *ScheduleInput) { in.Name = "" }, "validation_failed", "name"},
		{"control char name", func(in *ScheduleInput) { in.Name = "a\u0007" }, "validation_failed", "name"},
		{"no days", func(in *ScheduleInput) { in.Days = nil }, "validation_failed", "days"},
		{"day 8", func(in *ScheduleInput) { in.Days = []int{8} }, "validation_failed", "days[0]"},
		{"duplicate day", func(in *ScheduleInput) { in.Days = []int{2, 2} }, "validation_failed", "days[1]"},
		{"bad start", func(in *ScheduleInput) { in.Start = "24:00" }, "validation_failed", "start"},
		{"long end", func(in *ScheduleInput) { in.End = "19:00:00" }, "validation_failed", "end"},
		{"Local", func(in *ScheduleInput) { in.Timezone = "Local" }, "invalid_timezone", "timezone"},
		{"unknown zone", func(in *ScheduleInput) { in.Timezone = "Mars/Olympus_Mons" }, "invalid_timezone", "timezone"},
		{"empty zone", func(in *ScheduleInput) { in.Timezone = "" }, "invalid_timezone", "timezone"},
		{"bad mode", func(in *ScheduleInput) { in.Mode = "ultra" }, "validation_failed", "mode"},
		{"reason", func(in *ScheduleInput) { in.Reason = "x‮" }, "validation_failed", "reason"},
		{"same start and end", func(in *ScheduleInput) { in.End = "16:00" }, "validation_failed", "end"},
		{"window under 5 min", func(in *ScheduleInput) { in.End = "16:04" }, "validation_failed", "end"},
		{"overnight under 5 min", func(in *ScheduleInput) { in.Start, in.End = "23:58", "00:01" }, "validation_failed", "end"},
		{"no targets", func(in *ScheduleInput) { in.Targets = emptyTargets() }, "validation_failed", "targets"},
		{"exam not whitelist", func(in *ScheduleInput) { in.Mode = ModeExam; in.AcknowledgeNoEmergency = true }, "validation_failed", "whitelistOnly"},
		{"whitelist with targets", func(in *ScheduleInput) { in.WhitelistOnly = true }, "validation_failed", "targets"},
		{"allow without whitelist", func(in *ScheduleInput) { in.Allow.CustomDomains = []string{"example.com"} }, "validation_failed", "allow"},
		{"unknown service", func(in *ScheduleInput) { in.Targets.ServiceIDs = []string{"no-such-service"} }, "unknown_id", "targets.serviceIds[0]"},
		{"protected domain", func(in *ScheduleInput) { in.Targets.CustomDomains = []string{"update.microsoft.com"} }, "protected_target", "targets.customDomains[0]"},
		{"protected process", func(in *ScheduleInput) { in.Targets.CustomProcesses = []string{"svchost.exe"} }, "protected_target", "targets.customProcesses[0]"},
		{"allow distraction", func(in *ScheduleInput) {
			in.Targets = emptyTargets()
			in.WhitelistOnly = true
			in.Allow.CustomDomains = []string{"youtube.com"}
		}, "allow_distraction", "allow.customDomains[0]"},
		{"hardcore needs confirmation", func(in *ScheduleInput) { in.Mode = ModeHardcore }, "confirmation_required", ""},
	}
	for _, c := range cases {
		in := ok()
		c.mutate(&in)
		_, err := e.CreateSchedule(bg, Request{}, in)
		if c.code == "" {
			if err == nil {
				t.Errorf("%s: accepted", c.name)
			}
			continue
		}
		if apiCode(err) != c.code {
			t.Errorf("%s: code %q (%v), want %s", c.name, apiCode(err), err, c.code)
			continue
		}
		if c.path != "" && apiDetails(err)["path"] != c.path {
			t.Errorf("%s: path %v, want %s", c.name, apiDetails(err)["path"], c.path)
		}
	}
	if list, _ := e.ListSchedules(bg); len(list.Schedules) != 0 {
		t.Fatalf("refused schedules were stored: %d", len(list.Schedules))
	}
	// Exam schedules are whitelist-only and acknowledged; overnight windows are fine.
	exam := ok()
	exam.Mode, exam.WhitelistOnly, exam.Targets, exam.AcknowledgeNoEmergency = ModeExam, true, emptyTargets(), true
	exam.Start, exam.End = "22:00", "01:00"
	if _, err := e.CreateSchedule(bg, Request{}, exam); err != nil {
		t.Fatalf("exam overnight schedule: %v", err)
	}
	// At most maxSchedules.
	for i := 1; i < limits().MaxSchedules; i++ {
		schCreate(t, env, schIn(fmt.Sprintf("S%d", i), []int{2}, "16:00", "17:00", "UTC", "youtube"))
	}
	_, err := e.CreateSchedule(bg, Request{}, ok())
	if apiCode(err) != "validation_failed" || apiDetails(err)["issue"] != "length" || apiDetails(err)["limit"] != limits().MaxSchedules {
		t.Fatalf("schedule %d: %v %v", limits().MaxSchedules+1, err, apiDetails(err))
	}
}

// The custom-host budget is shared by enabled schedules (§5.2).
func TestSchedulesCustomHostBudget(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	domains := func(prefix string) []string {
		out := make([]string, limits().MaxCustomDomains)
		for i := range out {
			out[i] = fmt.Sprintf("%s%d.example.org", prefix, i)
		}
		return out
	}
	withDomains := func(name, prefix string) ScheduleInput {
		in := schIn(name, []int{3}, "08:00", "09:00", "UTC")
		in.Targets.CustomDomains = domains(prefix)
		return in
	}
	per := e.customHostCount(domains("a"))
	n := limits().MaxScheduleCustomHosts / per
	for i := range n {
		schCreate(t, env, withDomains(fmt.Sprintf("S%d", i), fmt.Sprintf("s%d-", i)))
	}
	over := withDomains("over", "over-")
	_, err := e.CreateSchedule(bg, Request{}, over)
	d := apiDetails(err)
	if apiCode(err) != "too_many_targets" || d["kind"] != "custom_hosts" || d["current"] != n*per || d["requested"] != per || d["limit"] != limits().MaxScheduleCustomHosts {
		t.Fatalf("over budget: %v %v", err, d)
	}
	// Disabled schedules do not count; enabling one is checked (without itself).
	over.Enabled = false
	s := schCreate(t, env, over)
	over.Enabled = true
	if _, err := e.UpdateSchedule(bg, Request{}, s.ID, over); apiCode(err) != "too_many_targets" {
		t.Fatalf("enabling over budget: %v", err)
	}
	// Replacing a schedule's own domains is within budget.
	list, _ := e.ListSchedules(bg)
	first := withDomains("S0", "renamed-")
	if _, err := e.UpdateSchedule(bg, Request{}, list.Schedules[0].ID, first); err != nil {
		t.Fatalf("replacing own domains: %v", err)
	}
}

// Occurrences run in trusted time: a wall-clock change neither skips nor repeats one, and
// each materializes exactly once as an independent schedule block.
func TestSchedulesActivationInTrustedTime(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	s := schCreate(t, env, schIn("Mañana", []int{1}, "10:30", "11:30", "UTC", "youtube"))
	schForwardTo(env, schAt(10, 29), time.Minute)
	if len(schBlocks(e, s.ID)) != 0 {
		t.Fatal("activated before the start")
	}
	// Moving the wall clock past the window does not end or skip it.
	env.clk.JumpWall(3 * time.Hour)
	e.Step()
	if len(schBlocks(e, s.ID)) != 0 {
		t.Fatal("a wall-clock jump activated the occurrence")
	}
	env.clk.JumpWall(-3 * time.Hour)
	e.Step()
	env.advance(62 * time.Second)
	blocks := schBlocks(e, s.ID)
	if len(blocks) != 1 {
		t.Fatalf("occurrence blocks %d", len(blocks))
	}
	b := blocks[0]
	start := schAt(10, 30).UnixMilli()
	if b.Kind != KindSchedule || b.Mode != ModeNormal || b.EndsAt != schAt(11, 30).UnixMilli() || b.StartsAt < start || b.StartsAt > start+2000 {
		t.Fatalf("block %+v", b)
	}
	created := env.eventsOf(EvBlockCreated)
	if d := mustDecode[BlockCreatedData](t, created[len(created)-1]); d.Source != "schedule" || d.Block.ScheduleID == nil || *d.Block.ScheduleID != s.ID {
		t.Fatalf("block_created %+v", d)
	}
	list, _ := e.ListSchedules(bg)
	if got := list.Schedules[0]; got.ActiveBlockID == nil || *got.ActiveBlockID != b.ID || got.NextOccurrence == nil || got.NextOccurrence.StartsAt != "2026-10-05T10:30:00.000Z" {
		t.Fatalf("schedule while active %+v", got)
	}
	if !slices.Contains(env.fh.Domains(), "youtube.com") {
		t.Fatal("the occurrence is not enforced")
	}
	// Jumps back and forth while it runs never create it again.
	env.clk.JumpWall(-time.Hour)
	env.advance(10 * time.Second)
	env.clk.JumpWall(time.Hour)
	env.advance(10 * time.Second)
	schForwardTo(env, schAt(11, 31), 30*time.Second)
	if b.Status != StatusCompleted || len(schBlocks(e, s.ID)) != 1 {
		t.Fatalf("status %s, blocks %d", b.Status, len(schBlocks(e, s.ID)))
	}
	// A restart does not re-create the occurrence.
	env.clk.ServiceRestart(time.Second)
	e = env.restart()
	e.Step()
	if len(schBlocks(e, s.ID)) != 1 {
		t.Fatal("restart re-created the occurrence")
	}
	if len(e.materializedOccurrences()) != 1 || e.materializedOccurrences()[0] != s.ID+"@2026-09-28" {
		t.Fatalf("materialized %v", e.materializedOccurrences())
	}
}

// A late activation enforces only the remaining time; a window missed entirely while the
// machine was off enforces nothing.
func TestSchedulesLateActivationAndMissedWindow(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	late := schCreate(t, env, schIn("Tarde", []int{1}, "10:30", "11:30", "UTC", "youtube"))
	missed := schCreate(t, env, schIn("Corto", []int{1}, "10:05", "10:20", "UTC", "instagram"))
	schForwardTo(env, schAt(10, 3), time.Minute)
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	env.clk.RebootAfter(42 * time.Minute) // off from 10:03 to 10:45
	e = env.open()
	e.Step()
	if n := len(schBlocks(e, missed.ID)); n != 0 {
		t.Fatalf("missed window created %d blocks", n)
	}
	blocks := schBlocks(e, late.ID)
	if len(blocks) != 1 {
		t.Fatalf("late activation: %d blocks", len(blocks))
	}
	if b := blocks[0]; b.StartsAt < schAt(10, 45).UnixMilli() || b.EndsAt != schAt(11, 30).UnixMilli() {
		t.Fatalf("late block %s–%s", fmtMs(b.StartsAt), fmtMs(b.EndsAt))
	}
	// Less than a minute left: materialized, but no block.
	short := schCreate(t, env, schIn("Casi", []int{1}, "10:00", "10:46", "UTC", "reddit"))
	if len(schBlocks(e, short.ID)) != 0 || !slices.Contains(e.materializedOccurrences(), short.ID+"@2026-09-28") {
		t.Fatalf("occurrence with under a minute left: blocks %d, materialized %v", len(schBlocks(e, short.ID)), e.materializedOccurrences())
	}
}

// Overnight windows run into the next day; yesterday's occurrence activates after
// midnight (local time of the schedule's zone).
func TestSchedulesOvernight(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	night := schCreate(t, env, schIn("Noche", []int{1}, "23:00", "01:00", "Europe/Madrid", "youtube"))
	// Monday 23:00 in Madrid (CEST) is 21:00 UTC.
	if night.NextOccurrence == nil || night.NextOccurrence.StartsAt != "2026-09-28T21:00:00.000Z" || night.NextOccurrence.EndsAt != "2026-09-28T23:00:00.000Z" {
		t.Fatalf("overnight next %+v", night.NextOccurrence)
	}
	schForwardTo(env, schAt(22, 30), 5*time.Minute) // Tuesday 00:30 in Madrid
	if blocks := schBlocks(e, night.ID); len(blocks) != 1 || blocks[0].EndsAt != schAt(23, 0).UnixMilli() {
		t.Fatalf("overnight blocks %d", len(blocks))
	}
	// Created on Tuesday 00:30 local: Monday's overnight occurrence is in progress.
	res, err := e.CreateSchedule(bg, Request{}, schIn("Tarde noche", []int{1}, "23:30", "01:30", "Europe/Madrid", "reddit"))
	if err != nil {
		t.Fatal(err)
	}
	blocks := schBlocks(e, res.Schedule.ID)
	if len(blocks) != 1 || res.Schedule.ActiveBlockID == nil || *res.Schedule.ActiveBlockID != blocks[0].ID || blocks[0].EndsAt != schAt(23, 30).UnixMilli() {
		t.Fatalf("yesterday's occurrence: %d blocks, response %+v", len(blocks), res.Schedule)
	}
	if !slices.Contains(e.materializedOccurrences(), res.Schedule.ID+"@2026-09-28") {
		t.Fatalf("key of the occurrence date: %v", e.materializedOccurrences())
	}
}

// DST: a start inside the spring-forward gap moves to the first valid instant; a start
// inside the fall-back overlap takes the earliest instant; a window swallowed by the gap
// has no occurrence.
func TestSchedulesDST(t *testing.T) {
	madrid, _ := loadLocation("Europe/Madrid")
	ny, _ := loadLocation("America/New_York")
	utc := func(s string) int64 {
		tm, err := time.Parse(time.RFC3339, s)
		if err != nil {
			t.Fatal(err)
		}
		return tm.UnixMilli()
	}
	cases := []struct {
		name       string
		loc        *time.Location
		date       schDate
		start, end string
		ok         bool
		wantStart  string
		wantEnd    string
	}{
		{"madrid gap", madrid, schDate{2026, time.March, 29}, "02:30", "04:00", true, "2026-03-29T01:00:00Z", "2026-03-29T02:00:00Z"},
		{"madrid overlap", madrid, schDate{2026, time.October, 25}, "02:30", "03:30", true, "2026-10-25T00:30:00Z", "2026-10-25T02:30:00Z"},
		{"madrid swallowed", madrid, schDate{2026, time.March, 29}, "02:00", "02:45", false, "", ""},
		{"madrid overnight into gap", madrid, schDate{2026, time.March, 28}, "23:00", "02:30", true, "2026-03-28T22:00:00Z", "2026-03-29T01:00:00Z"},
		{"new york gap", ny, schDate{2026, time.March, 8}, "02:30", "05:00", true, "2026-03-08T07:00:00Z", "2026-03-08T09:00:00Z"},
		{"new york overlap", ny, schDate{2026, time.November, 1}, "01:30", "03:00", true, "2026-11-01T05:30:00Z", "2026-11-01T08:00:00Z"},
		{"plain day", madrid, schDate{2026, time.September, 28}, "16:00", "19:00", true, "2026-09-28T14:00:00Z", "2026-09-28T17:00:00Z"},
	}
	for _, c := range cases {
		s := &scheduleRec{ID: "sch_x", Days: []int{c.date.isoWeekday()}, Start: c.start, End: c.end}
		occ, ok := schOccurrenceOn(s, c.loc, c.date, true)
		if ok != c.ok {
			t.Errorf("%s: ok %v", c.name, ok)
			continue
		}
		if !ok {
			continue
		}
		if occ.Start != utc(c.wantStart) || occ.End != utc(c.wantEnd) {
			t.Errorf("%s: %s–%s, want %s–%s", c.name, fmtMs(occ.Start), fmtMs(occ.End), c.wantStart, c.wantEnd)
		}
		if occ.Key != "sch_x@"+c.date.String() {
			t.Errorf("%s: key %s", c.name, occ.Key)
		}
	}
	// A day not in the schedule has no occurrence.
	s := &scheduleRec{ID: "sch_x", Days: []int{2}, Start: "10:00", End: "11:00"}
	if _, ok := schOccurrenceOn(s, madrid, schDate{2026, time.September, 28}, true); ok {
		t.Fatal("occurrence on a day not in the schedule")
	}
}

// PUT and DELETE guards (§8.8): no change while in progress, no weakening change or
// delete within the freeze before the next start; strengthening edits always pass.
func TestSchedulesGuards(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	base := func() ScheduleInput {
		in := schIn("Guardia", []int{1, 2}, "10:15", "11:00", "UTC", "youtube", "instagram")
		in.Mode = ModeStrict
		return in
	}
	s := schCreate(t, env, base())
	// Outside the freeze a weakening edit is fine.
	weaker := base()
	weaker.Days = []int{1}
	if _, err := e.UpdateSchedule(bg, Request{}, s.ID, weaker); err != nil {
		t.Fatalf("weakening outside the freeze: %v", err)
	}
	if _, err := e.UpdateSchedule(bg, Request{}, s.ID, base()); err != nil {
		t.Fatal(err)
	}
	schForwardTo(env, schAt(10, 6), time.Minute) // 9 min before the start
	soon := func(name string, err error) {
		t.Helper()
		if apiCode(err) != "schedule_starting_soon" || apiDetails(err)["startsAt"] != "2026-09-28T10:15:00.000Z" {
			t.Errorf("%s: %v %v", name, err, apiDetails(err))
		}
	}
	soon("delete", e.DeleteSchedule(bg, Request{}, s.ID))
	for name, mutate := range map[string]func(*ScheduleInput){
		"remove a day":       func(in *ScheduleInput) { in.Days = []int{1} },
		"disable":            func(in *ScheduleInput) { in.Enabled = false },
		"lower mode":         func(in *ScheduleInput) { in.Mode = ModeNormal },
		"remove a service":   func(in *ScheduleInput) { in.Targets.ServiceIDs = []string{"youtube"} },
		"later start":        func(in *ScheduleInput) { in.Start = "10:20" },
		"earlier end":        func(in *ScheduleInput) { in.End = "10:50" },
		"other zone":         func(in *ScheduleInput) { in.Timezone = "Europe/London" },
		"to whitelist":       func(in *ScheduleInput) { in.Targets = emptyTargets(); in.WhitelistOnly = true },
		"moved to other day": func(in *ScheduleInput) { in.Days = []int{2, 3} },
	} {
		in := base()
		mutate(&in)
		_, err := e.UpdateSchedule(bg, Request{}, s.ID, in)
		soon(name, err)
	}
	// Strengthening and neutral edits pass, applied one on top of the other.
	in := base()
	for _, step := range []struct {
		name   string
		mutate func(*ScheduleInput)
	}{
		{"rename", func(in *ScheduleInput) { in.Name = "Otro nombre" }},
		{"reason", func(in *ScheduleInput) { in.Reason = "Examen el jueves" }},
		{"add a service", func(in *ScheduleInput) { in.Targets.ServiceIDs = append(in.Targets.ServiceIDs, "reddit") }},
		{"add a category", func(in *ScheduleInput) { in.Targets.CategoryIDs = []string{"social"} }},
		{"add a day", func(in *ScheduleInput) { in.Days = []int{1, 2, 3} }},
		{"stricter mode", func(in *ScheduleInput) { in.Mode = ModeHardcore; in.AcknowledgeNoEmergency = true }},
		{"longer window", func(in *ScheduleInput) { in.Start, in.End = "10:10", "11:30" }},
		{"custom domain", func(in *ScheduleInput) { in.Targets.CustomDomains = []string{"example.com"} }},
	} {
		step.mutate(&in)
		if _, err := e.UpdateSchedule(bg, Request{}, s.ID, in); err != nil {
			t.Fatalf("%s: %v", step.name, err)
		}
	}
	// In progress: nothing changes until the occurrence ends.
	schForwardTo(env, schAt(10, 12), time.Minute)
	blk := e.schActiveBlock(s.ID)
	if blk == nil || blk.Mode != ModeHardcore || blk.StartsAt != schAt(10, 10).UnixMilli() {
		t.Fatalf("the occurrence did not start as edited: %+v", blk)
	}
	in.Name = "Solo renombrar"
	_, err := e.UpdateSchedule(bg, Request{}, s.ID, in)
	if apiCode(err) != "schedule_in_progress" || apiDetails(err)["blockId"] != blk.ID || apiDetails(err)["endsAt"] != e.display(blk.EndsAt) {
		t.Fatalf("update in progress: %v %v", err, apiDetails(err))
	}
	if err := e.DeleteSchedule(bg, Request{}, s.ID); apiCode(err) != "schedule_in_progress" {
		t.Fatalf("delete in progress: %v", err)
	}
	// After the end, the next start (Tuesday) is far: delete is allowed; the ended
	// occurrence's block stays in history, independent of the schedule.
	schForwardTo(env, schAt(11, 31), time.Minute)
	if err := e.DeleteSchedule(bg, Request{}, s.ID); err != nil {
		t.Fatalf("delete after the end: %v", err)
	}
	if e.block(blk.ID) == nil || e.block(blk.ID).Status != StatusCompleted {
		t.Fatal("the occurrence block changed with its schedule")
	}
	if len(e.materializedOccurrences()) != 0 {
		t.Fatalf("keys of a deleted schedule kept: %v", e.materializedOccurrences())
	}
	if err := e.DeleteSchedule(bg, Request{}, s.ID); apiCode(err) != "not_found" {
		t.Fatalf("delete twice: %v", err)
	}
	if _, err := e.UpdateSchedule(bg, Request{}, "sch_0000000000000000000000", base()); apiCode(err) != "not_found" {
		t.Fatalf("update unknown: %v", err)
	}
	if n := len(env.eventsOf(EvScheduleDeleted)); n != 1 {
		t.Fatalf("schedule_deleted %d", n)
	}
}

// The weakening rules of §10.3, one by one.
func TestSchedulesWeakeningRules(t *testing.T) {
	base := func() *scheduleRec {
		t := emptyTargets()
		t.ServiceIDs = []string{"youtube"}
		t.CustomDomains = []string{"example.com"}
		return &scheduleRec{ID: "sch_x", Enabled: true, Days: []int{1}, Start: "10:00", End: "11:00", Timezone: "UTC",
			Targets: t, Allow: emptyAllow(), Mode: ModeStrict}
	}
	wl := func() *scheduleRec {
		s := base()
		s.Targets, s.WhitelistOnly, s.Allow.CustomDomains = emptyTargets(), true, []string{"example.org"}
		return s
	}
	utc, _ := loadLocation("UTC")
	next, _ := schOccurrenceOn(base(), utc, schDate{2026, time.September, 28}, true)
	cases := []struct {
		name     string
		old      func() *scheduleRec
		mutate   func(*scheduleRec)
		weakened bool
	}{
		{"identical", base, func(*scheduleRec) {}, false},
		{"rename", base, func(s *scheduleRec) { s.Name, s.Reason = "x", "y" }, false},
		{"remove custom domain", base, func(s *scheduleRec) { s.Targets.CustomDomains = nil }, true},
		{"add custom process", base, func(s *scheduleRec) { s.Targets.CustomProcesses = []string{"game.exe"} }, false},
		{"whitelist off", wl, func(s *scheduleRec) {
			s.WhitelistOnly = false
			s.Allow = emptyAllow()
			s.Targets.ServiceIDs = []string{"youtube"}
		}, true},
		{"add allow", wl, func(s *scheduleRec) { s.Allow.CustomDomains = []string{"example.org", "example.net"} }, true},
		{"remove allow", wl, func(s *scheduleRec) { s.Allow.CustomDomains = nil }, false},
		{"exam from strict whitelist", wl, func(s *scheduleRec) { s.Mode = ModeExam }, false},
		{"contains old window", base, func(s *scheduleRec) { s.Start, s.End = "09:00", "12:00" }, false},
		{"overnight containing", base, func(s *scheduleRec) { s.Start, s.End = "09:00", "01:00" }, false},
		{"shifted window", base, func(s *scheduleRec) { s.Start, s.End = "10:30", "11:30" }, true},
	}
	for _, c := range cases {
		old := c.old()
		nw := c.old()
		c.mutate(nw)
		if got := schWeakening(old, nw, &next); got != c.weakened {
			t.Errorf("%s: weakening %v, want %v", c.name, got, c.weakened)
		}
	}
}

// Schedules and materialized occurrences survive restarts and a rebuild from the log,
// and an occurrence whose mark was lost (a crash after the append) is not duplicated.
func TestSchedulesPersistence(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	s := schCreate(t, env, schIn("Ahora", []int{1}, "09:00", "12:00", "UTC", "youtube"))
	if len(schBlocks(e, s.ID)) != 1 {
		t.Fatal("in-progress occurrence not activated at creation")
	}
	e.state.Schedules.Materialized = nil // the mark is lost; the block is committed
	e.Step()
	if len(schBlocks(e, s.ID)) != 1 || len(e.materializedOccurrences()) != 1 {
		t.Fatal("a lost mark duplicated the occurrence")
	}
	env.clk.ServiceRestart(time.Second)
	e = env.restart()
	e.Step()
	if list, _ := e.ListSchedules(bg); len(list.Schedules) != 1 || list.Schedules[0].ActiveBlockID == nil {
		t.Fatalf("after restart %+v", list)
	}
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"state.json", "state.prev.json"} {
		_ = os.Remove(filepath.Join(env.dir, n))
	}
	env.clk.ServiceRestart(time.Second)
	e = env.open()
	e.Step()
	list, _ := e.ListSchedules(bg)
	if len(list.Schedules) != 1 || list.Schedules[0].Name != "Ahora" || len(schBlocks(e, s.ID)) != 1 {
		t.Fatalf("rebuilt from the log: %+v, blocks %d", list.Schedules, len(schBlocks(e, s.ID)))
	}
}

// An occurrence materialized while the trusted clock ran ahead (a BIOS clock jump plus
// an offline reboot) is forgotten by the calibration correction, so the real occurrence
// still happens (§4).
func TestSchedulesForgottenAfterCalibration(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	s := schCreate(t, env, schIn("Luego", []int{1}, "13:30", "14:00", "UTC", "youtube"))
	// Its real window includes the correction: the block created while the clock ran
	// ahead moves back by Δ, and the rest of the window is materialized again.
	long := schCreate(t, env, schIn("Largo", []int{1}, "10:02", "14:00", "UTC", "reddit"))
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	env.net.SetOffline(true)
	env.clk.RebootAfter(5 * time.Minute)
	env.clk.JumpWall(3*time.Hour + 30*time.Minute) // real 10:05:20, wall 13:35:20
	e = env.open()
	e.Step()
	first := schBlocks(e, s.ID)
	if len(first) != 1 {
		t.Fatalf("occurrence while the clock ran ahead: %d blocks", len(first))
	}
	env.net.SetOffline(false)
	schForward(env, 5*time.Minute, 10*time.Second) // the calibration retry answers
	if e.trust() != TrustVerified {
		t.Fatal("no calibration")
	}
	if slices.Contains(e.materializedOccurrences(), s.ID+"@2026-09-28") {
		t.Fatal("the occurrence materialized ahead was not forgotten")
	}
	if n := len(schBlocks(e, s.ID)); n != 1 {
		t.Fatalf("blocks after the correction %d", n)
	}
	longBlocks := schBlocks(e, long.ID)
	if len(longBlocks) != 2 || longBlocks[1].EndsAt != schAt(14, 0).UnixMilli() || longBlocks[1].Status != StatusActive ||
		longBlocks[0].EndsAt >= schAt(14, 0).UnixMilli()-3*3600*1000 {
		t.Fatalf("the rest of the window in progress: %d blocks", len(longBlocks))
	}
	schForward(env, schAt(13, 31).Sub(env.clk.Real()), 5*time.Minute)
	blocks := schBlocks(e, s.ID)
	if len(blocks) != 2 || blocks[1].EndsAt != schAt(14, 0).UnixMilli() || blocks[1].Status != StatusActive {
		t.Fatalf("the real occurrence did not happen: %d blocks", len(blocks))
	}
}

// An occurrence cancelled by an emergency is never re-created, and its schedule can be
// edited again (nothing is in progress any more).
func TestSchedulesCancelledOccurrenceNotRecreated(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	s := schCreate(t, env, schIn("Ahora", []int{1}, "09:00", "13:00", "UTC", "youtube"))
	blk := e.schActiveBlock(s.ID)
	if blk == nil {
		t.Fatal("no occurrence in progress")
	}
	res, err := e.RequestEmergency(bg, Request{Scope: "app"}, EmergencyRequest{BlockIDs: []string{blk.ID}, Phrase: points.DefaultEmergencyRules().Phrases.ES})
	if errors.Is(err, ErrNotImplemented) {
		t.Skip("emergency.go is a stub")
	}
	if err != nil {
		t.Fatal(err)
	}
	schForward(env, msDuration(int64(res.Emergency.CountdownMinutes)*msPerMinute)+2*time.Second, 10*time.Second)
	if _, err := e.ConfirmEmergency(bg, Request{Scope: "app"}, res.Emergency.ID, ConfirmEmergencyRequest{Acknowledge: true}); err != nil {
		t.Fatal(err)
	}
	if blk.Status != StatusCancelledEmergency {
		t.Fatalf("block %s", blk.Status)
	}
	schForward(env, 30*time.Minute, time.Minute)
	if n := len(schBlocks(e, s.ID)); n != 1 {
		t.Fatalf("the cancelled occurrence was re-created (%d blocks)", n)
	}
	in := schIn("Ahora", []int{1}, "09:00", "13:00", "UTC", "youtube", "reddit")
	if _, err := e.UpdateSchedule(bg, Request{}, s.ID, in); err != nil {
		t.Fatalf("edit after the cancellation: %v", err)
	}
	e.Step()
	if n := len(schBlocks(e, s.ID)); n != 1 {
		t.Fatalf("an edit re-created the cancelled occurrence (%d blocks)", n)
	}
}
