package engine

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/points"
)

// has-active (§13): 0 nothing, 10 normal/strict, 11 hardcore/exam/punishment, from
// state.json's enforcement core, with the service running or stopped.
func TestHasActiveCodes(t *testing.T) {
	env := newTestEnv(t)
	check := func(want ActiveLevel) {
		t.Helper()
		got, err := HasActiveWith(env.dir, env.clk)
		if err != nil || got != want {
			t.Fatalf("HasActive = %d, %v; want %d", got, err, want)
		}
	}
	check(ActiveNone) // no data directory at all
	e := env.open()
	check(ActiveNone)
	env.create(durationReq(ModeStrict, 30, "youtube"))
	check(ActiveNormal)
	env.create(durationReq(ModeHardcore, 60, "instagram"))
	check(ActiveStrong)
	// With the service stopped, a clock change does not end the blocks (the core's
	// clock snapshot is restored like a start).
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	env.clk.JumpWall(48 * time.Hour)
	check(ActiveStrong)
	env.clk.Advance(35 * time.Minute)
	check(ActiveStrong) // the hardcore block still has 25 min
	env.clk.Advance(30 * time.Minute)
	check(ActiveNone)
}

func TestHasActivePunishmentAndFallback(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	err := e.exec(bg, func() {
		e.timeStep()
		b := e.newBatch()
		e.addPunishmentEvents(b, nil, "mates", "abandoned", PunishmentPolicy{Level: "distractions", Minutes: 15})
		if err := e.commit(b); err != nil {
			t.Error(err)
		}
		e.afterTurn()
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := HasActiveWith(env.dir, env.clk); got != ActiveStrong {
		t.Fatalf("punishment: %d", got)
	}
	// state.json unreadable: state.prev.json answers.
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(env.dir, "state.json"), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := HasActiveWith(env.dir, env.clk); err != nil || got != ActiveStrong {
		t.Fatalf("fallback: %d %v", got, err)
	}
}

// A punishment block completes with punishment_ended{completed} in the same batch and
// earns nothing (§10.5); it cannot be extended.
func TestPunishmentBlockLifecycle(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	var blk Block
	var pun Punishment
	_ = e.exec(bg, func() {
		e.timeStep()
		b := e.newBatch()
		blk, pun = e.addPunishmentEvents(b, nil, "mates", "three_strikes", PunishmentPolicy{Level: "nuclear", Minutes: 15})
		if err := e.commit(b); err != nil {
			t.Error(err)
		}
		e.afterTurn()
	})
	started := env.eventsOf(EvPunishmentStarted)
	if len(started) != 1 || started[0].Points != -int64(points.DefaultPointRules().PunishmentPenalty) {
		t.Fatalf("punishment_started %v", types(started))
	}
	s := env.state()
	if !s.NuclearActive || len(s.Punishments) != 1 || s.Punishments[0].ID != pun.ID || s.Blocks[0].Kind != KindPunishment {
		t.Fatalf("state %+v", s)
	}
	if _, err := e.ExtendBlock(bg, Request{}, blk.ID, ExtendBlockRequest{AddMinutes: 5}); apiCode(err) != "not_extendable" {
		t.Fatalf("extend punishment: %v", err)
	}
	env.advance(16 * time.Minute)
	done := env.eventsOf(EvBlockCompleted)
	ended := env.eventsOf(EvPunishmentEnded)
	if len(done) != 1 || len(ended) != 1 || done[0].Points != 0 || ended[0].Seq != done[0].Seq+1 || !ended[0].TxEnd {
		t.Fatalf("completion batch %v", types(env.events()))
	}
	if p := e.punishment(pun.ID); p.Status != StatusCompleted || p.EndedAt == nil {
		t.Fatalf("punishment %+v", p)
	}
	if env.state().NuclearActive {
		t.Fatal("nuclear still active")
	}
}
