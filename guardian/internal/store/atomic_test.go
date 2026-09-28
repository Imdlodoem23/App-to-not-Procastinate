package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

func TestWriteAtomicSteps(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "x.json")
	ffs := newFaultFS()
	ffs.arm(1000, false, 0, nil)
	if err := writeAtomic(ffs, path, []byte("new"), filePerm); err != nil {
		t.Fatal(err)
	}
	want := []string{"open x.json" + tmpInfix, "write x.json" + tmpInfix, "sync x.json" + tmpInfix, "close x.json" + tmpInfix, "rename x.json", "syncdir " + filepath.Base(dir)}
	ops := ffs.opLog()
	if len(ops) != len(want) {
		t.Fatalf("ops = %q, want %d steps", ops, len(want))
	}
	for i := range ops {
		if !startsWith(ops[i], want[i]) {
			t.Fatalf("step %d = %q, want %q…", i, ops[i], want[i])
		}
	}
	if got := readFileT(t, path); string(got) != "new" {
		t.Fatalf("content %q", got)
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(path)
		if fi.Mode().Perm() != filePerm {
			t.Fatalf("mode %v, want %v", fi.Mode().Perm(), filePerm)
		}
	}
}

func startsWith(s, prefix string) bool { return len(s) >= len(prefix) && s[:len(prefix)] == prefix }

// Crash (and plain failure) at every step of writeAtomic: the target always holds the
// old or the new content, never a mix or nothing; a plain failure leaves no temporary
// file; a crash may leave one, which Open removes.
func TestWriteAtomicCrashAtEveryStep(t *testing.T) {
	old, updated := []byte(`{"gen":1}`), []byte(`{"gen":2,"more":"bytes"}`)
	for _, crash := range []bool{false, true} {
		for k := 1; ; k++ {
			dir := t.TempDir()
			path := filepath.Join(dir, "state.json")
			writeFileT(t, path, old)
			ffs := newFaultFS()
			ffs.arm(k, crash, 3, nil)
			err := writeAtomic(ffs, path, updated, filePerm)
			if !ffs.didFail() {
				if err != nil {
					t.Fatalf("crash=%v k=%d: unexpected error %v", crash, k, err)
				}
				if k < 6 {
					t.Fatalf("writeAtomic finished in %d steps, want 6", k-1)
				}
				break
			}
			if err == nil {
				t.Fatalf("crash=%v k=%d: failure not reported", crash, k)
			}
			got := readFileT(t, path)
			renamed := k >= 6 // the directory fsync is the only step after the rename
			switch {
			case renamed && !equalBytes(got, updated):
				t.Fatalf("crash=%v k=%d: content %q, want the new content", crash, k, got)
			case !renamed && !equalBytes(got, old):
				t.Fatalf("crash=%v k=%d: content %q, want the old content", crash, k, got)
			}
			if temps := tempsIn(t, dir); !crash && len(temps) > 0 {
				t.Fatalf("k=%d: temporary files left after a plain failure: %v", k, temps)
			}
		}
	}
}

func TestOpenRemovesStaleTemps(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	e.closeClean(s)
	for _, p := range []string{
		filepath.Join(e.dir, "state.json"+tmpInfix+"1-aa"),
		filepath.Join(e.dir, dirRun, "starts.json"+tmpInfix+"1-bb"),
		filepath.Join(e.dir, dirSecret, "."+keyFile+tmpInfix+"x"),
	} {
		writeFileT(t, p, []byte("junk"))
	}
	_, rep := e.open()
	if rep.RemovedTemps != 3 {
		t.Fatalf("RemovedTemps = %d, want 3", rep.RemovedTemps)
	}
	if temps := tempsIn(t, e.dir); len(temps) > 0 {
		t.Fatalf("left: %v", temps)
	}
}

type engineState struct {
	Gen     int    `json:"gen"`
	Balance int64  `json:"balance"`
	Note    string `json:"note"`
}

func snapshot(s *Store, gen int) StateSnapshot {
	return StateSnapshot{
		LastEventSeq: s.LastSeq(),
		Enforcement:  map[string]any{"v": 1, "items": []any{}, "gen": gen},
		Engine:       engineState{Gen: gen, Balance: int64(gen * 10), Note: "<b>&co"},
	}
}

// Crash at every step of SaveState (two atomic writes: state.prev.json then
// state.json): the next Open recovers generation 1 or 2, never nothing.
func TestSaveStateCrashAtEveryStep(t *testing.T) {
	for k := 1; ; k++ {
		e := newEnv(t)
		ffs := newFaultFS()
		e.fs = ffs
		s := e.started()
		mustAppend(t, s, batchOf(2, "a"))
		if err := s.SaveState(snapshot(s, 1)); err != nil {
			t.Fatal(err)
		}
		mustAppend(t, s, batchOf(1, "b"))
		ffs.arm(k, true, 5, nil)
		err := s.SaveState(snapshot(s, 2))
		if !ffs.didFail() {
			if err != nil {
				t.Fatal(err)
			}
			if k < 12 {
				t.Fatalf("SaveState finished in %d steps, want 12", k-1)
			}
			break
		}
		if err == nil || ReadOnlyReason(err) != ReasonIOError {
			t.Fatalf("k=%d: err = %v", k, err)
		}
		_ = s.Close()
		ffs.disarm()
		e.fs = nil
		s2, rep := e.open()
		var got engineState
		ls, err := s2.LoadState(&got)
		if err != nil {
			t.Fatalf("k=%d: LoadState: %v (report %+v)", k, err, rep)
		}
		if got.Gen != 1 && got.Gen != 2 {
			t.Fatalf("k=%d: generation %d", k, got.Gen)
		}
		if rep.StateMACInvalid || rep.StateCorrupt {
			t.Fatalf("k=%d: a crash must not look like tampering: %+v", k, rep)
		}
		if got.Gen == 1 && ls.LastEventSeq != 3 || got.Gen == 2 && ls.LastEventSeq != 4 {
			t.Fatalf("k=%d: gen %d lastEventSeq %d", k, got.Gen, ls.LastEventSeq)
		}
		if rep.ReplayFrom != ls.LastEventSeq || rep.LastSeq != 4 {
			t.Fatalf("k=%d: replay from %d, last %d", k, rep.ReplayFrom, rep.LastSeq)
		}
		if temps := tempsIn(t, e.dir); len(temps) > 0 {
			t.Fatalf("k=%d: temporary files left after Open: %v", k, temps)
		}
		e.closeClean(s2)
	}
}

func TestSaveStateKeepsPreviousGeneration(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	for gen := 1; gen <= 3; gen++ {
		mustAppend(t, s, batchOf(1, "g"))
		if err := s.SaveState(snapshot(s, gen)); err != nil {
			t.Fatal(err)
		}
	}
	cur := readFileT(t, filepath.Join(e.dir, stateFile))
	prev := readFileT(t, filepath.Join(e.dir, statePrevFile))
	var c, p struct {
		Engine engineState `json:"engine"`
	}
	if err := json.Unmarshal(cur, &c); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(prev, &p); err != nil {
		t.Fatal(err)
	}
	if c.Engine.Gen != 3 || p.Engine.Gen != 2 {
		t.Fatalf("state gen %d, prev gen %d", c.Engine.Gen, p.Engine.Gen)
	}
	// SaveStateAll writes both generations equal (data deletion).
	if err := s.SaveStateAll(snapshot(s, 4)); err != nil {
		t.Fatal(err)
	}
	if !equalBytes(readFileT(t, filepath.Join(e.dir, stateFile)), readFileT(t, filepath.Join(e.dir, statePrevFile))) {
		t.Fatal("SaveStateAll: generations differ")
	}
	// The top-level enforcement core is readable without the key (has-active).
	enf, err := ReadEnforcement(e.dir)
	if err != nil {
		t.Fatal(err)
	}
	var core map[string]any
	if err := json.Unmarshal(enf, &core); err != nil || core["gen"] != float64(4) {
		t.Fatalf("enforcement %s (%v)", enf, err)
	}
}

func TestSaveStateValidation(t *testing.T) {
	e := newEnv(t)
	s, _ := e.open()
	if err := s.SaveState(StateSnapshot{}); !errors.Is(err, ErrNoEpoch) {
		t.Fatalf("before the first epoch: %v", err)
	}
	if _, err := s.NewEpoch(EpochInstall, []Event{epochStarted("install", "")}); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveState(StateSnapshot{LastEventSeq: 2}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("ahead of the log: %v", err)
	}
	if err := s.SaveState(StateSnapshot{LastEventSeq: 1, Engine: json.RawMessage(`{bad`)}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("bad raw JSON: %v", err)
	}
	if _, err := s.LoadState(nil); !errors.Is(err, ErrNoState) {
		t.Fatalf("fresh LoadState: %v", err)
	}
}

func TestStateMACTamperFallsBackToPrevious(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	mustAppend(t, s, batchOf(1, "a"))
	if err := s.SaveState(snapshot(s, 1)); err != nil {
		t.Fatal(err)
	}
	mustAppend(t, s, batchOf(1, "b"))
	if err := s.SaveState(snapshot(s, 2)); err != nil {
		t.Fatal(err)
	}
	e.closeClean(s)
	p := filepath.Join(e.dir, stateFile)
	raw := readFileT(t, p)
	edited := []byte(string(raw))
	i := indexOf(edited, `"balance":20`)
	if i < 0 {
		t.Fatalf("balance not found in %s", raw)
	}
	edited[i+len(`"balance":`)] = '9'
	writeFileT(t, p, edited)

	s2, rep := e.open()
	if !rep.StateMACInvalid || rep.State != StatePrevious || rep.Recovery != RecoveryBackupSnapshot {
		t.Fatalf("report %+v", rep)
	}
	var got engineState
	if _, err := s2.LoadState(&got); err != nil || got.Gen != 1 {
		t.Fatalf("LoadState gen %d, %v", got.Gen, err)
	}
	if rep.ReplayFrom != 2 || rep.LastSeq != 3 {
		t.Fatalf("replay from %d of %d", rep.ReplayFrom, rep.LastSeq)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatalf("tampered state.json still in place: %v", err)
	}
	if len(rep.Quarantined) != 1 || !reflect.DeepEqual(readFileT(t, filepath.Join(e.dir, filepath.FromSlash(rep.Quarantined[0]))), edited) {
		t.Fatalf("quarantined %v", rep.Quarantined)
	}
	// The next save does not rotate the tampered file into state.prev.json.
	if err := s2.SaveState(snapshot(s2, 3)); err != nil {
		t.Fatal(err)
	}
	var prev struct {
		Engine engineState `json:"engine"`
	}
	_ = json.Unmarshal(readFileT(t, filepath.Join(e.dir, statePrevFile)), &prev)
	if prev.Engine.Gen != 1 {
		t.Fatalf("prev gen %d, want 1", prev.Engine.Gen)
	}
}

func indexOf(b []byte, sub string) int {
	for i := 0; i+len(sub) <= len(b); i++ {
		if string(b[i:i+len(sub)]) == sub {
			return i
		}
	}
	return -1
}

func TestStateAheadOfLogIsStale(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	mustAppend(t, s, batchOf(2, "a"))
	seg := e.segments(s)[0]
	before := readFileT(t, seg)
	mustAppend(t, s, batchOf(1, "b"))
	if err := s.SaveState(snapshot(s, 1)); err != nil {
		t.Fatal(err)
	}
	e.closeClean(s)
	writeFileT(t, seg, before) // the log lost its last batch (rollback)
	_, rep := e.open()
	if !rep.StateStale || rep.State != StateNone || rep.ReplayFrom != 0 || rep.Recovery != RecoveryRebuilt {
		t.Fatalf("report %+v", rep)
	}
}
