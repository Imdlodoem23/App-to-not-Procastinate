package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

var updateGolden = flag.Bool("update", false, "rewrite the golden files in testdata/")

// Synthetic migrations (the real schema is still 1): v1→v2 moves engine.balance into
// engine.ledger.balance, v2→v3 adds engine.flags.
var testMigrations = map[int]Migration{
	1: func(doc map[string]any) (map[string]any, error) {
		eng, ok := doc["engine"].(map[string]any)
		if !ok {
			return nil, errors.New("engine is not an object")
		}
		eng["ledger"] = map[string]any{"balance": eng["balance"]}
		delete(eng, "balance")
		return doc, nil
	},
	2: func(doc map[string]any) (map[string]any, error) {
		eng := doc["engine"].(map[string]any)
		if _, ok := eng["flags"]; !ok {
			eng["flags"] = []any{}
		}
		return doc, nil
	},
}

// Golden test of the pure migration functions (§11.5).
func TestMigrationsGolden(t *testing.T) {
	in := readFileT(t, filepath.Join("testdata", "migrate", "state.v1.json"))
	doc, err := decodeMap(in)
	if err != nil {
		t.Fatal(err)
	}
	out, err := ApplyMigrations(doc, 1, 3, testMigrations)
	if err != nil {
		t.Fatal(err)
	}
	got, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	golden := filepath.Join("testdata", "migrate", "state.v3.golden.json")
	if *updateGolden {
		writeFileT(t, golden, got)
	}
	if want := readFileT(t, golden); !bytes.Equal(got, want) {
		t.Fatalf("migrated:\n%s\nwant:\n%s", got, want)
	}
	if _, err := ApplyMigrations(doc, 1, 4, testMigrations); err == nil {
		t.Fatal("a missing migration must fail")
	}
}

// A snapshot of an older schema is backed up, migrated and written back at Open.
func TestOpenMigratesOlderState(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	mustAppend(t, s, batchOf(1, "a"))
	type v1 struct {
		Balance int64 `json:"balance"`
		Big     int64 `json:"big"`
	}
	if err := s.SaveState(StateSnapshot{LastEventSeq: 2, Enforcement: map[string]any{"v": 1}, Engine: v1{Balance: -40, Big: 1 << 60}}); err != nil {
		t.Fatal(err)
	}
	original := readFileT(t, filepath.Join(e.dir, stateFile))
	e.closeClean(s)
	// Older backups exist: only the newest KeepStateBackups survive.
	for _, n := range []string{"state.v0.json", "state.v-1.json"} {
		writeFileT(t, filepath.Join(e.dir, dirBackups, n), []byte("{}"))
	}

	e.mod = func(o *Options) { o.SchemaVersion, o.Migrations = 3, testMigrations }
	s, rep := e.open()
	if rep.StateMigratedFrom != 1 || rep.StateSchemaVersion != 1 || rep.State != StateCurrent || rep.ReplayFrom != 2 {
		t.Fatalf("report %+v", rep)
	}
	if got := readFileT(t, filepath.Join(e.dir, dirBackups, "state.v1.json")); !bytes.Equal(got, original) {
		t.Fatal("backup is not the original snapshot")
	}
	var eng struct {
		Ledger struct {
			Balance int64 `json:"balance"`
		} `json:"ledger"`
		Big   int64 `json:"big"`
		Flags []any `json:"flags"`
	}
	ls, err := s.LoadState(&eng)
	if err != nil || ls.SchemaVersion != 3 || eng.Ledger.Balance != -40 || eng.Big != 1<<60 || eng.Flags == nil {
		t.Fatalf("migrated %+v %+v %v", ls, eng, err)
	}
	var head struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	_ = json.Unmarshal(readFileT(t, filepath.Join(e.dir, stateFile)), &head)
	if head.SchemaVersion != 3 {
		t.Fatalf("state.json schema %d after migration", head.SchemaVersion)
	}
	s, rep = e.reopen(s)
	if rep.StateMigratedFrom != 0 || rep.State != StateCurrent || rep.StateMACInvalid {
		t.Fatalf("second open %+v", rep)
	}
	e.closeClean(s)

	// Keep the newest three backups; other files are left alone.
	for _, v := range []string{"state.v1.json", "state.v2.json", "state.v5.json", "state.v7.json"} {
		writeFileT(t, filepath.Join(e.dir, dirBackups, v), []byte("{}"))
	}
	s, _ = e.open()
	if err := s.backupState(6, []byte("{}")); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Join(e.dir, dirBackups))
	var names []string
	for _, x := range entries {
		names = append(names, x.Name())
	}
	want := []string{"state.v-1.json", "state.v5.json", "state.v6.json", "state.v7.json"}
	if len(names) != len(want) {
		t.Fatalf("backups %v", names)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("backups %v, want %v", names, want)
		}
	}
}

func TestUnmigratableStateIsRebuilt(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	if err := s.SaveState(snapshot(s, 1)); err != nil {
		t.Fatal(err)
	}
	e.closeClean(s)
	e.mod = func(o *Options) { o.SchemaVersion = 2 } // no migration from 1
	_, rep := e.open()
	if rep.State != StateNone || len(rep.Warnings) == 0 || rep.Recovery != RecoveryRebuilt {
		t.Fatalf("report %+v", rep)
	}
}

// A snapshot of a newer schema freezes the store: nothing is written or repaired.
func TestFrozenOnNewerSchema(t *testing.T) {
	e := newEnv(t)
	e.mod = func(o *Options) { o.SchemaVersion, o.Migrations = 2, map[int]Migration{1: testMigrations[2]} }
	s := e.started()
	mustAppend(t, s, batchOf(2, "a"))
	enf := map[string]any{"v": 1, "items": []any{map[string]any{"id": "blk_x", "endsAtTrusted": testAt}}}
	if err := s.SaveState(StateSnapshot{LastEventSeq: 3, Enforcement: enf, Engine: map[string]any{"new": true}}); err != nil {
		t.Fatal(err)
	}
	seg := e.segments(s)[0]
	e.closeClean(s)
	withTorn := append(readFileT(t, seg), []byte(`{"v":1,"epoch":"torn`)...)
	writeFileT(t, seg, withTorn)
	stateBefore := readFileT(t, filepath.Join(e.dir, stateFile))

	e.mod = nil // this build writes schema 1
	s, rep := e.open()
	if !rep.Frozen || rep.FrozenReason != "schema_too_new" || rep.NeedEpoch != "" || rep.LastSeq != 3 {
		t.Fatalf("report %+v", rep)
	}
	var core map[string]any
	if err := json.Unmarshal(rep.FrozenEnforcement, &core); err != nil || core["v"] != float64(1) {
		t.Fatalf("frozen enforcement %s", rep.FrozenEnforcement)
	}
	if !bytes.Equal(readFileT(t, seg), withTorn) {
		t.Fatal("frozen mode truncated the log")
	}
	if _, err := s.AppendBatch(batchOf(1, "x")); !errors.Is(err, ErrFrozen) {
		t.Fatalf("append: %v", err)
	}
	if err := s.SaveState(StateSnapshot{}); !errors.Is(err, ErrFrozen) {
		t.Fatalf("save: %v", err)
	}
	if _, err := s.NewEpoch(EpochDataDeleted, []Event{epochStarted("data_deleted", "")}); !errors.Is(err, ErrFrozen) {
		t.Fatalf("new epoch: %v", err)
	}
	if _, err := s.LoadState(nil); !errors.Is(err, ErrFrozen) {
		t.Fatalf("load: %v", err)
	}
	if err := s.PutAnchor(Anchor{At: testAt}); !errors.Is(err, ErrFrozen) {
		t.Fatalf("anchor: %v", err)
	}
	if got := allEvents(t, s); len(got) != 3 || !s.Frozen() {
		t.Fatalf("reads in frozen mode: %d", len(got))
	}
	if err := s.SaveClock(map[string]int{"x": 1}); err != nil {
		t.Fatalf("the clock keeps being saved: %v", err)
	}
	e.closeClean(s)
	if !bytes.Equal(readFileT(t, filepath.Join(e.dir, stateFile)), stateBefore) {
		t.Fatal("frozen mode wrote state.json")
	}
}

// A line with a newer envelope version and a valid MAC freezes the store too.
func TestFrozenOnNewerEnvelope(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	mustAppend(t, s, batchOf(1, "a"))
	seg := e.segments(s)[0]
	epoch, lastMac := s.Epoch(), s.LastMac()
	e.closeClean(s)
	body := []byte(`{"v":2,"epoch":"` + epoch + `","seq":3,"at":"` + testAt + `","type":"future","txEnd":true,"data":{},"prevMac":"` + lastMac + `"}`)
	line, _ := seal(e.key(), body)
	full := append(readFileT(t, seg), append(line, '\n')...)
	writeFileT(t, seg, full)
	_, rep := e.open()
	if !rep.Frozen || rep.FrozenReason != "envelope_too_new" || rep.LastSeq != 2 || rep.Repair != nil {
		t.Fatalf("report %+v", rep)
	}
	if !bytes.Equal(readFileT(t, seg), full) {
		t.Fatal("frozen mode modified the log")
	}
}
