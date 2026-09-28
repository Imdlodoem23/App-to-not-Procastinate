package engine

import (
	"slices"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/points"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// Modes (§5.2): hardcore and exam are never emergency-eligible; exam is whitelist-only
// and snapshots the study whitelist plus settings extras plus allow.
func TestBlockModes(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	n := env.create(durationReq(ModeNormal, 30, "youtube"))
	s := env.create(durationReq(ModeStrict, 30, "youtube"))
	h := env.create(durationReq(ModeHardcore, 30, "youtube"))
	exam := durationReq(ModeExam, 120)
	exam.WhitelistOnly = true
	exam.Allow.CustomDomains = []string{"myuniversity.edu"}
	x := env.create(exam)
	for _, c := range []struct {
		b    Block
		elig bool
	}{{n, true}, {s, true}, {h, false}, {x, false}} {
		if c.b.EmergencyEligible != c.elig {
			t.Fatalf("%s emergencyEligible %v", c.b.Mode, c.b.EmergencyEligible)
		}
	}
	rec := e.block(x.ID)
	if !rec.WhitelistOnly || rec.WL == nil || !slices.Contains(rec.WL.Domains, "myuniversity.edu") || len(rec.Resolved.Domains) != 0 {
		t.Fatalf("exam snapshot %+v", rec.WL)
	}
	for _, d := range e.cat.StudyWhitelistDomains() {
		if !slices.Contains(rec.WL.Domains, d) {
			t.Fatalf("exam allow set lacks the study site %s", d)
		}
	}
	if e.enf.Whitelist == nil {
		t.Fatal("an exam block must set the whitelist rule")
	}
}

// Points (§6.1): +1 per credited minute for manual blocks, the clean bonus only from 25
// minutes, nothing for non-earning kinds.
func TestCompletionPointsRules(t *testing.T) {
	rules := points.DefaultPointRules()
	env := newTestEnv(t)
	e := env.open()
	short := env.create(durationReq(ModeNormal, 20, "youtube"))
	env.advance(21 * time.Minute)
	if got, want := *e.block(short.ID).PointsDelta, int64(20*rules.BlockPointsPerMinute); got != want {
		t.Fatalf("20-min block: %d points, want %d (no clean bonus below %d min)", got, want, rules.CleanSessionMinMinutes)
	}
	long := env.create(durationReq(ModeNormal, 25, "youtube"))
	env.advance(26 * time.Minute)
	if got, want := *e.block(long.ID).PointsDelta, int64(25*rules.BlockPointsPerMinute+rules.CleanSessionBonus); got != want {
		t.Fatalf("25-min block: %d points, want %d", got, want)
	}
}

// Three unclean starts within 5 min: safe mode, writes answer 503 read_only{safe_mode},
// enforcement goes on.
func TestSafeMode(t *testing.T) {
	env := newTestEnv(t)
	env.open()
	env.create(durationReq(ModeNormal, 60, "youtube"))
	for i := 0; i < 3; i++ {
		env.e.crash()
		env.clk.ServiceRestart(5 * time.Second)
		env.open()
	}
	e := env.e
	if e.mode != ModeGuardianSafe {
		t.Fatalf("mode %s", e.mode)
	}
	_, err := e.CreateBlock(bg, Request{}, durationReq(ModeNormal, 30, "tiktok"))
	if apiCode(err) != "read_only" || apiDetails(err)["reason"] != "safe_mode" {
		t.Fatalf("write in safe mode: %v", err)
	}
	h, _ := e.Health(bg)
	if h.Mode != ModeGuardianSafe || !slices.Contains(h.Problems, "safe_mode") {
		t.Fatalf("health %+v", h)
	}
	if len(env.fh.Domains()) == 0 {
		t.Fatal("safe mode stopped enforcing")
	}
}

// A newer schema (a downgrade): frozen mode enforces the v1 core until each item ends,
// never writes, and answers writes with read_only{schema_too_new} (§11.5).
func TestFrozenMode(t *testing.T) {
	env := newTestEnv(t)
	o := env.options()
	o.SchemaVersion = store.SchemaVersion + 1
	newer, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	if err := newer.Open(); err != nil {
		t.Fatal(err)
	}
	env.e = newer
	env.create(durationReq(ModeStrict, 30, "youtube"))
	want := env.fh.Domains()
	if err := newer.Stop(); err != nil {
		t.Fatal(err)
	}
	env.fh.Tamper(nil)
	env.clk.ServiceRestart(time.Second)
	e := env.open()
	if e.mode != ModeGuardianFrozen {
		t.Fatalf("mode %s", e.mode)
	}
	if !slices.Equal(env.fh.Domains(), want) {
		t.Fatal("frozen mode does not enforce the core")
	}
	if _, err := e.CreateBlock(bg, Request{}, durationReq(ModeNormal, 30, "tiktok")); apiCode(err) != "read_only" || apiDetails(err)["reason"] != "schema_too_new" {
		t.Fatalf("write when frozen: %v", err)
	}
	if got, _ := HasActiveWith(env.dir, env.clk); got != ActiveNormal {
		t.Fatalf("has-active when frozen: %d", got)
	}
	env.advance(31 * time.Minute)
	if len(env.fh.Domains()) != 0 {
		t.Fatal("frozen items did not expire")
	}
}
