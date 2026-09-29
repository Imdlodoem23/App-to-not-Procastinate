package engine

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// Settings tests (docs/ARCHITECTURE.md §5.8, §4, §8.8 «Settings»). Helpers are prefixed
// set so they never collide with the other feature files' tests.

func setGet(t *testing.T, env *testEnv) SettingsResponse {
	t.Helper()
	res, err := env.e.GetSettings(bg)
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	return res
}

func setPut(t *testing.T, env *testEnv, s GuardianSettings) SettingsResponse {
	t.Helper()
	res, err := env.e.UpdateSettings(bg, Request{Scope: "app"}, s)
	if err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}
	return res
}

// setPendingOf returns the pending change of a path, or nil.
func setPendingOf(res SettingsResponse, path string) *PendingSettingChange {
	for i := range res.Pending {
		if res.Pending[i].Field == path {
			return &res.Pending[i]
		}
	}
	return nil
}

// setEffectiveIn is the delay left until effectiveAt (display time), measured on the
// engine's display clock.
func setEffectiveIn(t *testing.T, env *testEnv, p *PendingSettingChange) time.Duration {
	t.Helper()
	if p == nil {
		t.Fatal("no pending change")
	}
	ms, ok := parseMs(p.EffectiveAt)
	if !ok {
		t.Fatalf("effectiveAt %q", p.EffectiveAt)
	}
	return msDuration(ms - (env.e.now + env.e.wallOffsetMs()))
}

// setForward moves real time with the machine awake in coarse steps (each step is one
// engine tick; the pending delay runs on the boot clock, so step size does not matter).
func setForward(env *testEnv, d time.Duration) { schForward(env, d, 10*time.Minute) }

func setJSON(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestSettingsStrengtheningAppliesAtOnce(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	got := setGet(t, env)
	if got.Settings.Timezone == nil || *got.Settings.Timezone != "Europe/Madrid" || got.Settings.DailyGoalMinutes != 60 ||
		!got.Settings.AttemptPenalties || !got.Settings.ServerTimeCheck || got.Settings.CloseBrowsersWithoutExtension ||
		got.Settings.StudyWhitelist.ExtraDomains == nil || len(got.Pending) != 0 {
		t.Fatalf("first-start settings %+v", got)
	}
	s := got.Settings
	s.DailyGoalMinutes = 90
	s.CloseBrowsersWithoutExtension = true
	s.Punishment = PunishmentPolicy{Level: "nuclear", Minutes: 30}
	res := setPut(t, env, s)
	if len(res.Pending) != 0 || setJSON(t, res.Settings) != setJSON(t, s) {
		t.Fatalf("strengthening not applied at once: %+v", res)
	}
	evs := env.eventsOf(EvSettingsChanged)
	if len(evs) != 1 {
		t.Fatalf("settings_changed %d", len(evs))
	}
	if d := mustDecode[SettingsChangedData](t, evs[0]); d.Settings.DailyGoalMinutes != 90 || len(d.Pending) != 0 {
		t.Fatalf("event %+v", d)
	}
	// Punishment changes apply at once in both directions («el usuario lo elige»).
	s.Punishment = PunishmentPolicy{Level: "distractions", Minutes: 15}
	if res := setPut(t, env, s); res.Settings.Punishment != s.Punishment || len(res.Pending) != 0 {
		t.Fatalf("punishment change %+v", res)
	}
	// A retried PUT changes nothing and writes nothing.
	setPut(t, env, s)
	if n := len(env.eventsOf(EvSettingsChanged)); n != 2 {
		t.Fatalf("settings_changed after a retry %d", n)
	}
	if env.e.goalMinutes() != 90 {
		t.Fatal("the core does not see the new goal")
	}
}

func TestSettingsWeakeningWaits(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	delay := msDuration(int64(limits().SettingsWeakeningDelayMs))
	s := setGet(t, env).Settings
	s.DailyGoalMinutes = 30
	res := setPut(t, env, s)
	p := setPendingOf(res, setPathGoal)
	if res.Settings.DailyGoalMinutes != 60 || p == nil || string(p.Value) != "30" || setEffectiveIn(t, env, p) != delay {
		t.Fatalf("lowering the goal: %+v", res)
	}
	// Retries never postpone it: the same effectiveAt an hour later.
	first := p.EffectiveAt
	setForward(env, time.Hour)
	res = setPut(t, env, s)
	if p := setPendingOf(res, setPathGoal); p == nil || p.EffectiveAt != first {
		t.Fatalf("a retry moved effectiveAt: %+v (was %s)", p, first)
	}
	if n := len(env.eventsOf(EvSettingsChanged)); n != 1 {
		t.Fatalf("a retry wrote settings_changed (%d)", n)
	}
	// A value between the pending and the effective one keeps the remaining delay.
	s.DailyGoalMinutes = 45
	res = setPut(t, env, s)
	if p := setPendingOf(res, setPathGoal); p == nil || string(p.Value) != "45" || p.EffectiveAt != first {
		t.Fatalf("a weaker-than-effective, stronger-than-pending value: %+v", p)
	}
	// A value weaker than the pending one restarts the delay.
	s.DailyGoalMinutes = 20
	res = setPut(t, env, s)
	if p := setPendingOf(res, setPathGoal); p == nil || string(p.Value) != "20" || setEffectiveIn(t, env, p) != delay {
		t.Fatalf("a weaker value did not restart the delay: %+v", p)
	}
	// Setting the effective value again cancels it.
	s.DailyGoalMinutes = 60
	if res := setPut(t, env, s); len(res.Pending) != 0 || res.Settings.DailyGoalMinutes != 60 {
		t.Fatalf("cancel %+v", res)
	}
	// Switches: true → false waits, in the same PUT as an immediate punishment change.
	s.AttemptPenalties = false
	s.ServerTimeCheck = false
	s.Punishment = PunishmentPolicy{Level: "whitelist", Minutes: 120}
	res = setPut(t, env, s)
	if !res.Settings.AttemptPenalties || !res.Settings.ServerTimeCheck || res.Settings.Punishment != s.Punishment ||
		len(res.Pending) != 2 || res.Pending[0].Field != setPathPenalties || res.Pending[1].Field != setPathServerTime {
		t.Fatalf("switches %+v", res)
	}
	// Events and pending entries carry trusted time; responses display time.
	env.clk.JumpWall(2 * time.Hour)
	e.Step()
	evs := env.eventsOf(EvSettingsChanged)
	ev := mustDecode[SettingsChangedData](t, evs[len(evs)-1])
	disp := setPendingOf(setGet(t, env), setPathPenalties)
	trusted, _ := parseMs(ev.Pending[0].EffectiveAt)
	shown, _ := parseMs(disp.EffectiveAt)
	if shown-trusted != 2*3600*1000 {
		t.Fatalf("display effectiveAt %s, trusted %s", disp.EffectiveAt, ev.Pending[0].EffectiveAt)
	}
	if st := env.state(); len(st.PendingSettings) != 2 || st.PendingSettings[0].EffectiveAt != disp.EffectiveAt {
		t.Fatalf("/v1/state.pendingSettings %+v", st.PendingSettings)
	}
	// 24 h of running time later they apply (the guardian writes settings_changed).
	setForward(env, delay-10*time.Minute)
	if !setGet(t, env).Settings.AttemptPenalties {
		t.Fatal("applied early")
	}
	setForward(env, 20*time.Minute)
	got := setGet(t, env)
	if got.Settings.AttemptPenalties || got.Settings.ServerTimeCheck || len(got.Pending) != 0 {
		t.Fatalf("after 24 h %+v", got)
	}
	if e.trust() != TrustDisabled {
		t.Fatalf("trust with the check off: %s", e.trust())
	}
	// Turning a switch back on is strengthening: at once.
	s = got.Settings
	s.AttemptPenalties, s.ServerTimeCheck = true, true
	if res := setPut(t, env, s); !res.Settings.AttemptPenalties || !res.Settings.ServerTimeCheck || len(res.Pending) != 0 {
		t.Fatalf("switch back on %+v", res)
	}
}

// Study whitelist extras: additions wait (the pending value is the full list), removals
// apply at once and also leave the pending list.
func TestSettingsWhitelistExtras(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	delay := msDuration(int64(limits().SettingsWeakeningDelayMs))
	s := setGet(t, env).Settings
	s.StudyWhitelist.ExtraDomains = []string{"example.com", "example.org"}
	s.StudyWhitelist.ExtraProcesses = []string{"anki.exe"}
	res := setPut(t, env, s)
	if len(res.Settings.StudyWhitelist.ExtraDomains) != 0 || len(res.Pending) != 2 ||
		string(setPendingOf(res, setPathExtraDomains).Value) != `["example.com","example.org"]` ||
		string(setPendingOf(res, setPathExtraProcesses).Value) != `["anki.exe"]` {
		t.Fatalf("additions %+v", res)
	}
	setForward(env, delay+10*time.Minute)
	got := setGet(t, env)
	if !slices.Equal(got.Settings.StudyWhitelist.ExtraDomains, []string{"example.com", "example.org"}) || len(got.Pending) != 0 {
		t.Fatalf("after the delay %+v", got)
	}
	// Remove example.org (at once) and add example.net (waits).
	s = got.Settings
	s.StudyWhitelist.ExtraDomains = []string{"example.com", "example.net"}
	res = setPut(t, env, s)
	p := setPendingOf(res, setPathExtraDomains)
	if !slices.Equal(res.Settings.StudyWhitelist.ExtraDomains, []string{"example.com"}) || p == nil ||
		string(p.Value) != `["example.com","example.net"]` || setEffectiveIn(t, env, p) != delay {
		t.Fatalf("mixed change %+v", res)
	}
	setForward(env, time.Hour)
	// Adding a new entry restarts the delay; dropping a waiting one keeps it.
	s.StudyWhitelist.ExtraDomains = []string{"example.com", "example.net", "example.edu"}
	res = setPut(t, env, s)
	if p := setPendingOf(res, setPathExtraDomains); p == nil || setEffectiveIn(t, env, p) != delay {
		t.Fatalf("a new addition must restart the delay: %+v", p)
	}
	setForward(env, time.Hour)
	s.StudyWhitelist.ExtraDomains = []string{"example.com", "example.edu"}
	res = setPut(t, env, s)
	if p := setPendingOf(res, setPathExtraDomains); p == nil || string(p.Value) != `["example.com","example.edu"]` || setEffectiveIn(t, env, p) != delay-time.Hour {
		t.Fatalf("removing a waiting entry: %+v", p)
	}
	// Back to the effective list: the pending change is cancelled.
	s.StudyWhitelist.ExtraDomains = []string{"example.com"}
	if res := setPut(t, env, s); setPendingOf(res, setPathExtraDomains) != nil {
		t.Fatalf("cancel %+v", res.Pending)
	}
}

func TestSettingsValidation(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	ok := setGet(t, env).Settings
	cases := []struct {
		name   string
		mutate func(*GuardianSettings)
		code   string
		path   string
	}{
		{"goal too low", func(s *GuardianSettings) { s.DailyGoalMinutes = 10 }, "validation_failed", "dailyGoalMinutes"},
		{"goal too high", func(s *GuardianSettings) { s.DailyGoalMinutes = 601 }, "validation_failed", "dailyGoalMinutes"},
		{"level", func(s *GuardianSettings) { s.Punishment.Level = "extreme" }, "validation_failed", "punishment.level"},
		{"minutes", func(s *GuardianSettings) { s.Punishment.Minutes = 5 }, "validation_failed", "punishment.minutes"},
		{"Local", func(s *GuardianSettings) { s.Timezone = ptr("Local") }, "invalid_timezone", "timezone"},
		{"unknown zone", func(s *GuardianSettings) { s.Timezone = ptr("Nowhere/Town") }, "invalid_timezone", "timezone"},
		{"bad domain", func(s *GuardianSettings) { s.StudyWhitelist.ExtraDomains = []string{"Not A Domain"} }, "validation_failed", "studyWhitelist.extraDomains[0]"},
		{"duplicate domain", func(s *GuardianSettings) { s.StudyWhitelist.ExtraDomains = []string{"example.com", "example.com"} }, "validation_failed", "studyWhitelist.extraDomains[1]"},
		{"protected process", func(s *GuardianSettings) { s.StudyWhitelist.ExtraProcesses = []string{"svchost.exe"} }, "protected_target", "studyWhitelist.extraProcesses[0]"},
		{"distraction domain", func(s *GuardianSettings) { s.StudyWhitelist.ExtraDomains = []string{"example.com", "youtube.com"} }, "allow_distraction", "studyWhitelist.extraDomains[1]"},
		{"parent of a distraction", func(s *GuardianSettings) { s.StudyWhitelist.ExtraDomains = []string{"googleapis.com"} }, "allow_distraction", "studyWhitelist.extraDomains[0]"},
	}
	for _, c := range cases {
		s := ok.Clone()
		c.mutate(&s)
		_, err := e.UpdateSettings(bg, Request{}, s)
		if apiCode(err) != c.code || apiDetails(err)["path"] != c.path {
			t.Errorf("%s: %v %v", c.name, err, apiDetails(err))
		}
	}
	if n := len(env.eventsOf(EvSettingsChanged)); n != 0 {
		t.Fatalf("refused updates wrote %d events", n)
	}
}

// The time zone: the first set while detection failed applies at once; every later
// change, back to null included, waits.
func TestSettingsTimezone(t *testing.T) {
	env := newTestEnv(t)
	o := env.options()
	o.DetectTimezone = func() string { return "" }
	e, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Open(); err != nil {
		t.Fatal(err)
	}
	env.e = e
	t.Cleanup(func() { _ = e.Stop() })
	s := setGet(t, env).Settings
	if s.Timezone != nil {
		t.Fatalf("undetected zone %v", *s.Timezone)
	}
	s.Timezone = ptr("Europe/Lisbon")
	if res := setPut(t, env, s); res.Settings.Timezone == nil || *res.Settings.Timezone != "Europe/Lisbon" || len(res.Pending) != 0 {
		t.Fatalf("first set %+v", res)
	}
	if e.localDay(e.now) != "2026-09-28" || e.location().String() != "Europe/Lisbon" {
		t.Fatal("local days do not follow the zone")
	}
	s.Timezone = ptr("Pacific/Auckland")
	res := setPut(t, env, s)
	if *res.Settings.Timezone != "Europe/Lisbon" || string(setPendingOf(res, setPathTimezone).Value) != `"Pacific/Auckland"` {
		t.Fatalf("a later change must wait: %+v", res)
	}
	s.Timezone = nil
	res = setPut(t, env, s)
	if p := setPendingOf(res, setPathTimezone); p == nil || string(p.Value) != "null" {
		t.Fatalf("back to null must wait: %+v", res.Pending)
	}
	setForward(env, msDuration(int64(limits().SettingsWeakeningDelayMs))+10*time.Minute)
	if got := setGet(t, env); got.Settings.Timezone != nil || len(got.Pending) != 0 {
		t.Fatalf("after the delay %+v", got)
	}
}

// §15: FakeClock.Reboot + JumpWall never applies a pending weakening change early. The
// delay runs on the boot clock while the guardian runs; downtime counts only when a
// network time check verified it, and only for changes pending at the stop.
func TestSettingsDelayIgnoresClockAndOfflineReboots(t *testing.T) {
	delay := msDuration(int64(limits().SettingsWeakeningDelayMs))
	lowerGoal := func(t *testing.T, env *testEnv, goal int) {
		t.Helper()
		s := setGet(t, env).Settings
		s.DailyGoalMinutes = goal
		setPut(t, env, s)
	}
	remaining := func(env *testEnv, path string) time.Duration {
		for _, p := range env.e.state.SettingsExt.Pending {
			if p.Field == path {
				return msDuration(p.RemainingMs)
			}
		}
		return -1
	}

	t.Run("bios jump and offline reboot", func(t *testing.T) {
		env := newTestEnv(t)
		env.open()
		lowerGoal(t, env, 30)
		setForward(env, time.Hour)
		if err := env.e.Stop(); err != nil {
			t.Fatal(err)
		}
		env.net.SetOffline(true)
		env.clk.RebootAfter(0)
		env.clk.JumpWall(48 * time.Hour)
		env.open()
		setForward(env, 10*time.Minute)
		if got := setGet(t, env); got.Settings.DailyGoalMinutes != 60 || setPendingOf(got, setPathGoal) == nil {
			t.Fatalf("applied early after a clock jump: %+v", got)
		}
		if r := remaining(env, setPathGoal); r < delay-time.Hour-11*time.Minute || r > delay-time.Hour-9*time.Minute {
			t.Fatalf("remaining %v", r)
		}
		// The network comes back: the calibration moves the clock back and verifies
		// nothing more than the few seconds the machine was really off.
		env.net.SetOffline(false)
		setForward(env, 10*time.Minute)
		if got := setGet(t, env); got.Settings.DailyGoalMinutes != 60 {
			t.Fatalf("applied after the calibration: %+v", got)
		}
		if r := remaining(env, setPathGoal); r < delay-time.Hour-21*time.Minute || r > delay-time.Hour-19*time.Minute {
			t.Fatalf("remaining after calibration %v", r)
		}
	})

	t.Run("verified downtime counts", func(t *testing.T) {
		env := newTestEnv(t)
		env.open()
		lowerGoal(t, env, 30)
		if err := env.e.Stop(); err != nil {
			t.Fatal(err)
		}
		env.net.SetOffline(true)
		env.clk.RebootAfter(30 * time.Hour)
		env.open()
		setForward(env, 10*time.Minute)
		// Unverified downtime never counts.
		if got := setGet(t, env); got.Settings.DailyGoalMinutes != 60 {
			t.Fatalf("unverified downtime applied it: %+v", got)
		}
		// A change made after the restart is not credited the downtime before it. (The
		// PUT carries the pending goal: sending the effective value would cancel it.)
		s := setGet(t, env).Settings
		s.DailyGoalMinutes = 30
		s.AttemptPenalties = false
		setPut(t, env, s)
		env.net.SetOffline(false)
		setForward(env, 10*time.Minute)
		got := setGet(t, env)
		if got.Settings.DailyGoalMinutes != 30 || setPendingOf(got, setPathGoal) != nil {
			t.Fatalf("verified downtime not credited: %+v", got)
		}
		if !got.Settings.AttemptPenalties || remaining(env, setPathPenalties) < delay-11*time.Minute {
			t.Fatalf("a change made after the restart was credited: %v", remaining(env, setPathPenalties))
		}
	})

	t.Run("same-boot restart", func(t *testing.T) {
		env := newTestEnv(t)
		env.open()
		lowerGoal(t, env, 30)
		if err := env.e.Stop(); err != nil {
			t.Fatal(err)
		}
		env.clk.ServiceRestart(2 * time.Hour)
		env.open()
		setForward(env, 10*time.Minute) // the calibration 60 s after the start verifies the stop
		if r := remaining(env, setPathGoal); r < delay-2*time.Hour-11*time.Minute || r > delay-2*time.Hour-9*time.Minute {
			t.Fatalf("remaining after a verified 2 h stop %v", r)
		}
	})

	t.Run("server time check off", func(t *testing.T) {
		env := newTestEnv(t)
		env.open()
		s := setGet(t, env).Settings
		s.ServerTimeCheck = false
		setPut(t, env, s)
		setForward(env, delay+10*time.Minute)
		if setGet(t, env).Settings.ServerTimeCheck {
			t.Fatal("serverTimeCheck still on")
		}
		lowerGoal(t, env, 30)
		if err := env.e.Stop(); err != nil {
			t.Fatal(err)
		}
		calls := env.net.Calls()
		env.clk.RebootAfter(30 * time.Hour)
		env.open()
		setForward(env, 10*time.Minute)
		if got := setGet(t, env); got.Settings.DailyGoalMinutes != 60 || env.net.Calls() != calls {
			t.Fatalf("downtime counted with the check off: %+v (network calls %d → %d)", got, calls, env.net.Calls())
		}
	})
}

// Pending changes survive restarts and a rebuild from the log (where the delay restarts
// from the change: the safe side).
func TestSettingsPersistence(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	s := setGet(t, env).Settings
	s.DailyGoalMinutes = 30
	s.StudyWhitelist.ExtraDomains = []string{"example.com"}
	setPut(t, env, s)
	setForward(env, 3*time.Hour)
	before := setGet(t, env)
	env.clk.ServiceRestart(time.Second)
	e = env.restart()
	after := setGet(t, env)
	if setJSON(t, after.Settings) != setJSON(t, before.Settings) || len(after.Pending) != 2 {
		t.Fatalf("after restart %+v", after)
	}
	if got := setEffectiveIn(t, env, setPendingOf(after, setPathGoal)); got > msDuration(int64(limits().SettingsWeakeningDelayMs))-3*time.Hour+time.Minute {
		t.Fatalf("the restart restarted the delay: %v", got)
	}
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"state.json", "state.prev.json"} {
		_ = os.Remove(filepath.Join(env.dir, n))
	}
	env.clk.ServiceRestart(time.Second)
	env.open()
	rebuilt := setGet(t, env)
	if rebuilt.Settings.DailyGoalMinutes != 60 || len(rebuilt.Pending) != 2 || string(setPendingOf(rebuilt, setPathGoal).Value) != "30" {
		t.Fatalf("rebuilt from the log %+v", rebuilt)
	}
}

func TestWindowsZones(t *testing.T) {
	for key, name := range windowsZones {
		if _, ok := loadLocation(name); !ok {
			t.Errorf("%s → %s: not in the embedded tzdata", key, name)
		}
	}
	if got := windowsZoneIANA("Romance Standard Time"); got != "Europe/Paris" {
		t.Fatalf("Romance Standard Time → %q", got)
	}
	if got := windowsZoneIANA("Martian Standard Time"); got != "" {
		t.Fatalf("unknown key → %q", got)
	}
}
