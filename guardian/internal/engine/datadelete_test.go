package engine

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/points"
)

// Data deletion tests (docs/ARCHITECTURE.md §10.11, §8.8 «POST /v1/data/delete»).
// Helpers are prefixed dd so they never collide with the other feature files' tests.

// ddScrubHosts is a hosts layer that can scrub its backups.
type ddScrubHosts struct {
	*FakeHosts
	scrubs atomic.Int32
}

func (h *ddScrubHosts) ScrubBackups() error { h.scrubs.Add(1); return nil }

// ddPurgeHandler is a log handler that can purge the logs.
type ddPurgeHandler struct {
	slog.Handler
	purges atomic.Int32
}

func (h *ddPurgeHandler) PurgeLogs() error { h.purges.Add(1); return nil }

// ddOpen opens an Engine on env with modified options.
func ddOpen(t *testing.T, env *testEnv, mutate func(*Options)) *Engine {
	t.Helper()
	o := env.options()
	mutate(&o)
	e, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Open(); err != nil {
		t.Fatal(err)
	}
	env.e = e
	t.Cleanup(func() { _ = e.Stop() })
	return e
}

// ddStateEpoch reads the epoch of a state file and whether it mentions s.
func ddStateEpoch(t *testing.T, path, s string) (string, bool) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", filepath.Base(path), err)
	}
	var doc struct {
		Epoch string `json:"epoch"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("decode %s: %v", filepath.Base(path), err)
	}
	return doc.Epoch, bytes.Contains(raw, []byte(s))
}

func TestDataDeleteRefusals(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	epoch := e.state.Epoch
	for word, code := range map[string]string{
		"":                  "validation_failed",
		"BORRARLO":          "confirm_word_mismatch",
		"borrar\u0007":      "validation_failed",
		"BORRAR BORRAR BOR": "validation_failed", // 17 characters
		"eliminar":          "confirm_word_mismatch",
	} {
		if _, err := e.DeleteData(bg, Request{}, DeleteDataRequest{Confirm: word}); apiCode(err) != code {
			t.Errorf("confirm %q: %v, want %s", word, err, code)
		}
	}
	blocked := func(reason string) {
		t.Helper()
		_, err := e.DeleteData(bg, Request{}, DeleteDataRequest{Confirm: "BORRAR"})
		if apiCode(err) != "data_delete_blocked" || apiDetails(err)["reason"] != reason {
			t.Fatalf("want data_delete_blocked{%s}: %v %v", reason, err, apiDetails(err))
		}
	}
	// Completions awaiting a time check are the evidence resurrection needs (§10.2).
	e.state.Clock.Unverified = []unverifiedCompletion{{BlockID: "blk_0000000000000000000000", Seq: 1, Kind: KindManual, Mode: ModeNormal}}
	blocked("clock_unverified")
	e.state.Clock.Unverified = nil

	blk := env.create(durationReq(ModeNormal, 60, "youtube"))
	emg, err := e.RequestEmergency(bg, Request{Scope: "app"}, EmergencyRequest{BlockIDs: []string{blk.ID}, Phrase: points.DefaultEmergencyRules().Phrases.ES})
	switch {
	case errors.Is(err, ErrNotImplemented):
		t.Log("emergency.go is a stub: emergency_pending not exercised")
	case err != nil:
		t.Fatal(err)
	default:
		blocked("emergency_pending")
		if _, err := e.CancelEmergency(bg, Request{Scope: "app"}, emg.Emergency.ID); err != nil {
			t.Fatal(err)
		}
	}
	_, err = e.StartStudy(bg, Request{Scope: "app"}, StartStudyRequest{Task: "mates", PlannedMinutes: 30})
	switch {
	case errors.Is(err, ErrNotImplemented):
		t.Log("study.go is a stub: study_active not exercised")
	case err != nil:
		t.Fatal(err)
	default:
		blocked("study_active")
	}
	if e.state.Epoch != epoch || len(env.eventsOf(EvEpochStarted)) != 1 {
		t.Fatal("a refused deletion changed the epoch")
	}
}

// Everything that must survive does, everything else is gone, and the new epoch is
// rebuildable from its own events (§10.11).
func TestDataDeleteKeepsWhatMustSurvive(t *testing.T) {
	env := newTestEnv(t)
	sh := &ddScrubHosts{FakeHosts: env.fh}
	env.hosts = sh
	ph := &ddPurgeHandler{Handler: slog.NewTextHandler(io.Discard, nil)}
	e := ddOpen(t, env, func(o *Options) { o.Logger = slog.New(ph) })
	oldEpoch := e.state.Epoch

	// An ended block, an active block, and schedules in progress, inside the freeze and
	// far away.
	ended := env.create(durationReq(ModeNormal, 5, "reddit"))
	schForward(env, 6*time.Minute, 10*time.Second) // 10:06
	if e.block(ended.ID).Status != StatusCompleted {
		t.Fatal("setup: the short block did not complete")
	}
	active := env.create(durationReq(ModeStrict, 120, "youtube"))
	inProgress := schCreate(t, env, schIn("Ahora", []int{1}, "09:00", "13:00", "UTC", "instagram"))
	soon := schCreate(t, env, schIn("Pronto", []int{1}, "10:15", "11:00", "UTC", "twitch"))
	schCreate(t, env, schIn("Luego", []int{3}, "16:00", "17:00", "UTC", "tiktok"))
	occBlock := e.schActiveBlock(inProgress.ID)
	if occBlock == nil {
		t.Fatal("setup: no occurrence in progress")
	}

	// A negative balance and the attempt escalation (injected: tests do not earn
	// penalties here), effective whitelist extras, and pending changes.
	_ = e.exec(bg, func() {
		e.state.Ledger.Balance = -120
		e.state.Ledger.Escalation = points.Escalation{LastCountedAtMs: ptr(e.now), Index: 3}
		e.state.Settings.StudyWhitelist.ExtraDomains = []string{"example.org"}
	})
	s := setGet(t, env).Settings
	s.DailyGoalMinutes = 90
	setPut(t, env, s)
	s.DailyGoalMinutes = 30
	s.Timezone = ptr("Europe/Lisbon")
	s.StudyWhitelist.ExtraDomains = []string{"example.org", "example.com"}
	s.AttemptPenalties = false
	if res := setPut(t, env, s); len(res.Pending) != 4 {
		t.Fatalf("setup: pending %+v", res.Pending)
	}

	// Leftovers the deletion removes.
	for _, p := range []string{"quarantine/torn-20260928.jsonl", "backups/state.v1.json"} {
		path := filepath.Join(env.dir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(`{"reason":"example.org"}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	blockIdem := &Idempotency{Lookup: "b1", Scope: "app", Method: "POST", Path: "/v1/blocks", RequestHash: "h", Req: "0123456789abcdef0123456789abcdef"}
	if _, err := e.CreateBlock(bg, Request{Scope: "app", Idem: blockIdem}, durationReq(ModeNormal, 30, "netflix")); err != nil {
		t.Fatal(err)
	}

	idem := &Idempotency{Lookup: "d1", Scope: "app", Method: "POST", Path: "/v1/data/delete", RequestHash: "h", Req: "fedcba9876543210fedcba9876543210"}
	res, err := e.DeleteData(bg, Request{Scope: "app", Idem: idem}, DeleteDataRequest{Confirm: "  borrar "})
	if err != nil {
		t.Fatalf("DeleteData: %v", err)
	}
	if res.Epoch == oldEpoch || res.Epoch != e.state.Epoch || res.CarryOverBalance != -120 {
		t.Fatalf("response %+v (old epoch %s)", res, oldEpoch)
	}
	if len(res.KeptBlockIDs) != 3 || !slices.Contains(res.KeptBlockIDs, active.ID) || !slices.Contains(res.KeptBlockIDs, occBlock.ID) ||
		slices.Contains(res.KeptBlockIDs, ended.ID) {
		t.Fatalf("kept blocks %v", res.KeptBlockIDs)
	}
	if !slices.Equal(res.KeptScheduleIDs, []string{inProgress.ID, soon.ID}) || res.KeptPunishmentIDs == nil || len(res.KeptPunishmentIDs) != 0 {
		t.Fatalf("kept schedules %v, punishments %v", res.KeptScheduleIDs, res.KeptPunishmentIDs)
	}

	check := func(e *Engine, where string) {
		t.Helper()
		if e.state.Epoch != res.Epoch || e.state.Ledger.Balance != -120 || e.state.Ledger.Escalation.Index != 3 || e.state.Ledger.Escalation.LastCountedAtMs == nil {
			t.Fatalf("%s: epoch %s, ledger %+v", where, e.state.Epoch, e.state.Ledger)
		}
		if e.block(ended.ID) != nil || e.block(active.ID) == nil || e.block(active.ID).Status != StatusActive {
			t.Fatalf("%s: blocks not kept as they should", where)
		}
		list, _ := e.ListSchedules(bg)
		if len(list.Schedules) != 2 || list.Schedules[0].ID != inProgress.ID || list.Schedules[1].ID != soon.ID {
			t.Fatalf("%s: schedules %+v", where, list.Schedules)
		}
		got := setGet(t, env)
		if got.Settings.DailyGoalMinutes != 90 || !got.Settings.AttemptPenalties || *got.Settings.Timezone != "Europe/Madrid" ||
			len(got.Settings.StudyWhitelist.ExtraDomains) != 0 {
			t.Fatalf("%s: settings %+v", where, got.Settings)
		}
		if len(got.Pending) != 3 || setPendingOf(got, setPathGoal) == nil || setPendingOf(got, setPathTimezone) == nil ||
			setPendingOf(got, setPathPenalties) == nil || setPendingOf(got, setPathExtraDomains) != nil {
			t.Fatalf("%s: pending %+v", where, got.Pending)
		}
		e.Step()
		if n := len(schBlocks(e, inProgress.ID)); n != 1 {
			t.Fatalf("%s: the occurrence in progress was re-created (%d blocks)", where, n)
		}
	}
	check(e, "after the deletion")
	if p := setPendingOf(setGet(t, env), setPathGoal); setEffectiveIn(t, env, p) < msDuration(int64(limits().SettingsWeakeningDelayMs))-time.Minute {
		t.Fatal("the deletion restarted a pending delay")
	}

	// The epoch_started event carries what survives, in trusted time.
	evs := env.events()
	if len(evs) == 0 || evs[0].Type != EvEpochStarted {
		t.Fatalf("first event of the new epoch: %+v", evs)
	}
	d := mustDecode[EpochStartedData](t, evs[0])
	if d.Reason != "data_deleted" || d.PreviousEpoch == nil || *d.PreviousEpoch != oldEpoch || d.CarryOverBalance != -120 ||
		d.Escalation.Index != 3 || evs[0].Points != -120 || len(d.Kept.Settings.StudyWhitelist.ExtraDomains) != 0 ||
		len(d.Kept.PendingSettings) != 3 || !slices.Contains(d.Kept.MaterializedOccurrences, inProgress.ID+"@2026-09-28") {
		t.Fatalf("epoch_started %+v", d)
	}
	for _, p := range d.Kept.PendingSettings {
		if strings.HasPrefix(p.Field, "studyWhitelist.") {
			t.Fatalf("kept a study whitelist change: %+v", p)
		}
	}

	// Deleted: the old epoch, quarantine, schema backups, the idempotency cache.
	if _, err := os.Stat(filepath.Join(env.dir, "events", oldEpoch)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old epoch still on disk: %v", err)
	}
	for _, p := range []string{"quarantine/torn-20260928.jsonl", "backups/state.v1.json"} {
		if _, err := os.Stat(filepath.Join(env.dir, filepath.FromSlash(p))); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s survived: %v", p, err)
		}
	}
	if len(e.idem) != 1 || e.idem[0].Lookup != "d1" {
		t.Fatalf("idempotency cache after the deletion: %d records", len(e.idem))
	}
	if sh.scrubs.Load() != 1 || ph.purges.Load() != 1 {
		t.Fatalf("hosts backups scrubbed %d times, logs purged %d times", sh.scrubs.Load(), ph.purges.Load())
	}
	// Both state generations hold the new state only.
	for _, name := range []string{"state.json", "state.prev.json"} {
		ep, mentions := ddStateEpoch(t, filepath.Join(env.dir, name), "example.org")
		if ep != res.Epoch || mentions {
			t.Fatalf("%s: epoch %s, still mentions deleted data %v", name, ep, mentions)
		}
		if _, old := ddStateEpoch(t, filepath.Join(env.dir, name), oldEpoch); old {
			t.Fatalf("%s mentions the old epoch", name)
		}
	}
	// Enforcement follows the kept blocks.
	if hosts := env.fh.Domains(); !slices.Contains(hosts, "youtube.com") || slices.Contains(hosts, "reddit.com") {
		t.Fatalf("hosts after the deletion %v", hosts)
	}

	// A retry replays the stored response and starts no other epoch.
	_, err = e.DeleteData(bg, Request{Scope: "app", Idem: idem}, DeleteDataRequest{Confirm: "  borrar "})
	var rr *ReplayedResponse
	want, _ := EncodeResponse(res)
	if !errors.As(err, &rr) || rr.Status != 200 || !bytes.Equal(rr.Body, want) || e.state.Epoch != res.Epoch {
		t.Fatalf("replay: %v", err)
	}

	// The new epoch rebuilds from its own events.
	if err := e.Stop(); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"state.json", "state.prev.json"} {
		_ = os.Remove(filepath.Join(env.dir, n))
	}
	env.clk.ServiceRestart(time.Second)
	check(ddOpen(t, env, func(o *Options) { o.Logger = slog.New(ph) }), "rebuilt from the log")
}

// A positive balance is not carried; a store failure applies nothing (503 read_only).
func TestDataDeleteStoreFailure(t *testing.T) {
	env := newTestEnv(t)
	ffs := newFaultFS()
	env.fs = ffs
	e := env.open()
	blk := env.create(durationReq(ModeNormal, 60, "youtube"))
	_ = e.exec(bg, func() { e.state.Ledger.Balance = 250 })
	epoch := e.state.Epoch
	ffs.setFailAppend(true)
	_, err := e.DeleteData(bg, Request{}, DeleteDataRequest{Confirm: "DELETE"})
	ffs.setFailAppend(false)
	if apiCode(err) != "read_only" {
		t.Fatalf("store failure: %v", err)
	}
	if e.state.Epoch != epoch || e.state.Ledger.Balance != 250 || e.block(blk.ID) == nil {
		t.Fatal("a failed deletion changed the state")
	}
	if _, err := os.Stat(filepath.Join(env.dir, "events", epoch)); err != nil {
		t.Fatalf("the current epoch is gone after a failed deletion: %v", err)
	}
	env.create(durationReq(ModeNormal, 30, "reddit")) // the log still accepts appends
	res, err := e.DeleteData(bg, Request{}, DeleteDataRequest{Confirm: "DELETE"})
	if err != nil || res.CarryOverBalance != 0 || e.state.Ledger.Balance != 0 || len(res.KeptBlockIDs) != 2 {
		t.Fatalf("deletion after the failure: %+v %v", res, err)
	}
	if !strings.HasPrefix(res.Epoch, "ep_") || res.Epoch == epoch {
		t.Fatalf("epoch %s", res.Epoch)
	}
}

// Regression: a data deletion keeps the credit already earned by the active blocks (the
// kept wire snapshots carry none), also across a restart, so the completion pays every
// minute and the clean bonus (§10.11 «nothing is re-charged», §10.9).
func TestDataDeleteKeepsBlockCredit(t *testing.T) {
	rules := points.DefaultPointRules()
	env := newTestEnv(t)
	e := env.open()
	env.advance(10 * time.Second)
	blk := env.create(durationReq(ModeStrict, 60, "youtube"))
	env.advance(50 * time.Minute)
	before := e.block(blk.ID).CreditedMs
	if before < 49*60_000 {
		t.Fatalf("credited %d ms before the deletion", before)
	}
	if _, err := e.DeleteData(bg, Request{}, DeleteDataRequest{Confirm: "BORRAR"}); err != nil {
		t.Fatal(err)
	}
	if got := e.block(blk.ID).CreditedMs; got != before {
		t.Fatalf("credited %d ms after the deletion, want %d", got, before)
	}
	e = env.restart()
	if got := e.block(blk.ID).CreditedMs; got != before {
		t.Fatalf("credited %d ms after a restart, want %d", got, before)
	}
	env.advance(11 * time.Minute)
	done := env.eventsOf(EvBlockCompleted)
	if len(done) != 1 {
		t.Fatalf("%d completions", len(done))
	}
	d := mustDecode[BlockCompletedData](t, done[0])
	want := int64(60*rules.BlockPointsPerMinute + rules.CleanSessionBonus)
	if d.CreditedMinutes != 60 || done[0].Points != want {
		t.Fatalf("credited %d minutes, points %d, want 60 and %d", d.CreditedMinutes, done[0].Points, want)
	}
}
