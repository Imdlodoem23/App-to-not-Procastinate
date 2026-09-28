package engine

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/points"
)

// Everything survives a clean restart: blocks with their credit and resolution, the
// ledger, versions (strictly increasing), the log (seq continues), and idempotent
// replays return the original bytes.
func TestPersistenceRoundTrip(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	first := env.create(durationReq(ModeStrict, 90, "youtube", "instagram"))
	short := env.create(durationReq(ModeNormal, 10, "tiktok"))
	env.advance(20 * time.Minute)
	if _, err := e.ExtendBlock(bg, Request{}, first.ID, ExtendBlockRequest{AddMinutes: 15}); err != nil {
		t.Fatal(err)
	}
	idem := &Idempotency{Lookup: "k1", Scope: "app", Method: "POST", Path: "/v1/blocks", RequestHash: "h1", Req: "0123456789abcdef0123456789abcdef"}
	second, err := e.CreateBlock(bg, Request{Scope: "app", Idem: idem}, durationReq(ModeNormal, 60, "reddit"))
	if err != nil {
		t.Fatal(err)
	}
	if ev := env.eventsOf(EvBlockCreated); ev[len(ev)-1].Req == nil || *ev[len(ev)-1].Req != idem.Req {
		t.Fatal("events of an idempotent request must carry its req fingerprint")
	}
	env.advance(10 * time.Second)
	before := e.state
	beforeBlocks := map[string]blockRec{}
	for _, b := range before.Blocks {
		beforeBlocks[b.ID] = *b
	}
	lastSeq := before.LastEventSeq
	body0, _ := EncodeResponse(second)

	e = env.restart()
	for id, want := range beforeBlocks {
		got := e.block(id)
		if got == nil {
			t.Fatalf("block %s lost", id)
		}
		if got.Status != want.Status || got.EndsAt != want.EndsAt || got.CreditedMs != want.CreditedMs ||
			got.ExtendedMinutes != want.ExtendedMinutes || !reflect.DeepEqual(got.Resolved, want.Resolved) {
			t.Fatalf("block %s: %+v\nwant %+v", id, got, want)
		}
	}
	if e.block(short.ID).Status != StatusCompleted {
		t.Fatal("completed block not kept")
	}
	if !reflect.DeepEqual(e.state.Ledger.Balance, before.Ledger.Balance) || e.state.Ledger.XP != before.Ledger.XP {
		t.Fatalf("ledger %+v vs %+v", e.state.Ledger, before.Ledger)
	}
	if e.state.Versions.State <= before.Versions.State || e.state.Versions.ExtRules <= before.Versions.ExtRules {
		t.Fatalf("versions not strictly increasing: %+v → %+v", before.Versions, e.state.Versions)
	}
	started := env.eventsOf(EvGuardianStarted)
	if last := started[len(started)-1]; last.Seq != lastSeq+1 {
		t.Fatalf("seq %d after %d", last.Seq, lastSeq)
	}
	// The idempotent create replays byte for byte after the restart.
	_, err = e.CreateBlock(bg, Request{Scope: "app", Idem: idem}, durationReq(ModeNormal, 60, "reddit"))
	var rep *ReplayedResponse
	if !errors.As(err, &rep) || rep.Status != 201 || !bytes.Equal(rep.Body, body0) {
		t.Fatalf("replay: %v", err)
	}
	other := *idem
	other.RequestHash = "h2"
	if _, err := e.CreateBlock(bg, Request{Scope: "app", Idem: &other}, durationReq(ModeStrict, 90, "youtube")); apiCode(err) != "idempotency_conflict" {
		t.Fatalf("conflict: %v", err)
	}
	if n := len(e.activeBlocks()); n != 2 {
		t.Fatalf("%d active blocks after replays", n)
	}
	// Replaying the whole log rebuilds the same ledger (the state file is only a cache).
	evs := env.events()
	var pe []points.Event
	for _, ev := range evs {
		pe = append(pe, points.Event{Seq: ev.Seq, At: ev.At, Day: ev.Day, Type: ev.Type, Points: ev.Points, XP: ev.XP, Data: ev.Data})
	}
	rr := points.ReplayEvents(pe, points.DefaultPointRules(), points.InitialLedgerState())
	if rr.State.Balance != e.state.Ledger.Balance || len(rr.Mismatches) != 0 || len(rr.Malformed) != 0 {
		t.Fatalf("replay %+v vs %+v", rr, e.state.Ledger)
	}
}

// Losing state.json (and its previous generation) rebuilds everything from the log.
func TestRebuildFromLog(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	b := env.create(durationReq(ModeNormal, 60, "youtube"))
	env.advance(time.Minute)
	balance := e.state.Ledger.Balance
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"state.json", "state.prev.json"} {
		if err := os.Remove(filepath.Join(env.dir, n)); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
	}
	env.clk.ServiceRestart(time.Second)
	e = env.open()
	if rec := e.block(b.ID); rec == nil || rec.Status != StatusActive {
		t.Fatal("block not rebuilt from the log")
	}
	if e.state.Ledger.Balance != balance {
		t.Fatal("ledger not rebuilt")
	}
	if len(env.fh.Domains()) == 0 {
		t.Fatal("enforcement not re-applied")
	}
}

// Stopping the service for more than 60 s during a block costs like an emergency
// (§10.12 step 9); a planned stop does not, and a reboot never does.
func TestStoppedServiceCheck(t *testing.T) {
	cases := []struct {
		name    string
		planned bool
		down    time.Duration
		penalty bool
	}{
		{"short crash restart", false, 20 * time.Second, false},
		{"long stop", false, 5 * time.Minute, true},
		{"planned stop", true, 5 * time.Minute, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			env := newTestEnv(t)
			e := env.open()
			// Earn something first so the penalty base is visible.
			env.create(durationReq(ModeNormal, 30, "tiktok"))
			env.advance(31 * time.Minute)
			env.create(durationReq(ModeNormal, 60, "youtube"))
			balance := e.state.Ledger.Balance
			if c.planned {
				// The running guardian writes it on an OS shutdown (the installer's
				// store.WritePlannedStop is the same file, stamped with the real clock).
				if err := e.st.MarkPlannedStop("update"); err != nil {
					t.Fatal(err)
				}
			}
			if err := e.Stop(); err != nil {
				t.Fatal(err)
			}
			env.clk.ServiceRestart(c.down)
			e = env.open()
			tam := env.eventsOf(EvTamperDetected)
			if !c.penalty {
				if len(tam) != 0 {
					t.Fatalf("penalized: %v", types(tam))
				}
				return
			}
			if len(tam) != 1 {
				t.Fatalf("%d tamper events", len(tam))
			}
			d := mustDecode[TamperDetectedData](t, tam[0])
			pen := points.EmergencyPenalty(balance, points.DefaultPointRules())
			if d.Kind != "service_stopped" || d.BalanceCorrection != -pen || !d.VoidStreak || tam[0].Points != -pen {
				t.Fatalf("tamper %+v points %d, want −%d", d, tam[0].Points, pen)
			}
			if e.state.Ledger.Balance != balance-pen {
				t.Fatal("balance not corrected")
			}
			if a, ok, _ := env.anchor.Load(); !ok || a.Balance != e.state.Ledger.Balance {
				t.Fatal("anchor not updated after the penalty")
			}
		})
	}
}

// Editing the section while the guardian was stopped (same boot, block active) costs
// once as hosts_changed_while_stopped.
func TestHostsChangedWhileStopped(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	env.create(durationReq(ModeNormal, 60, "youtube"))
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	env.fh.Tamper([]string{"youtube.com"})
	env.clk.ServiceRestart(10 * time.Second)
	env.open()
	tam := env.eventsOf(EvTamperDetected)
	if len(tam) != 1 || mustDecode[TamperDetectedData](t, tam[0]).Kind != "hosts_changed_while_stopped" {
		t.Fatalf("tamper %v", types(tam))
	}
}

// The log survives a failed append: nothing is applied, the answer is 503 read_only,
// and the order of a successful commit is events → hosts → (response) → state.json
// (§11.3).
func TestCommitOrderUnderStoreFailure(t *testing.T) {
	env := newTestEnv(t)
	ffs := newFaultFS()
	env.fs = ffs
	e := env.open()
	e.Step() // the first time check (a visible trust change) happens here
	applies := env.fh.Applies()
	v0 := e.state.Versions
	seq0 := e.state.LastEventSeq
	ffs.setFailAppend(true)
	_, err := e.CreateBlock(bg, Request{}, durationReq(ModeNormal, 30, "youtube"))
	if apiCode(err) != "read_only" || apiDetails(err)["reason"] != "io_error" {
		t.Fatalf("got %v %v", err, apiDetails(err))
	}
	if len(e.activeBlocks()) != 0 || env.fh.Applies() != applies || e.state.LastEventSeq != seq0 || e.state.Versions != v0 {
		t.Fatalf("a failed append applied something: blocks %d, applies %d→%d, seq %d→%d, versions %+v→%+v",
			len(e.activeBlocks()), applies, env.fh.Applies(), seq0, e.state.LastEventSeq, v0, e.state.Versions)
	}
	if len(env.eventsOf(EvBlockCreated)) != 0 {
		t.Fatal("the failed batch reached the log")
	}
	ffs.setFailAppend(false)

	// Record the durable order of a successful create.
	var order []string
	env.fh.OnApply = func() { order = append(order, ffs.takeOps()...); order = append(order, "hosts") }
	ffs.mu.Lock()
	ffs.recordOrder = true
	ffs.mu.Unlock()
	if _, err := e.CreateBlock(bg, Request{}, durationReq(ModeNormal, 30, "youtube")); err != nil {
		t.Fatal(err)
	}
	order = append(order, ffs.takeOps()...)
	env.fh.OnApply = nil
	want := []string{"append", "hosts", "state"}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("commit order %v, want %v", order, want)
	}
}

// A torn state write never loses the committed block: the log is the write-ahead log.
func TestCrashAfterAppendReplays(t *testing.T) {
	env := newTestEnv(t)
	ffs := newFaultFS()
	env.fs = ffs
	e := env.open()
	ffs.mu.Lock()
	ffs.failState = true
	ffs.mu.Unlock()
	b := env.create(durationReq(ModeNormal, 30, "youtube"))
	e.crash()
	ffs.mu.Lock()
	ffs.failState = false
	ffs.mu.Unlock()
	env.clk.ServiceRestart(time.Second)
	e = env.open()
	if rec := e.block(b.ID); rec == nil || rec.Status != StatusActive {
		t.Fatal("the committed block was lost with the state write")
	}
}
