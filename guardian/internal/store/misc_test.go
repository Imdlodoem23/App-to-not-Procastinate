package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWriteAtomicExported(t *testing.T) {
	p := filepath.Join(t.TempDir(), "client.json")
	if err := WriteAtomic(p, []byte(`{"v":1}`), filePerm); err != nil {
		t.Fatal(err)
	}
	if err := WriteAtomic(p, []byte(`{"v":2}`), filePerm); err != nil {
		t.Fatal(err)
	}
	if got := readFileT(t, p); string(got) != `{"v":2}` {
		t.Fatalf("%s", got)
	}
	err := WriteAtomic(filepath.Join(t.TempDir(), "missing", "x"), nil, filePerm)
	if ReadOnlyReason(err) != ReasonIOError {
		t.Fatalf("err %v", err)
	}
}

func TestTimeFormat(t *testing.T) {
	ts := time.Date(2026, 9, 27, 18, 42, 0, 123_987_000, time.FixedZone("CEST", 2*3600))
	if got := FormatTime(ts); got != "2026-09-27T16:42:00.123Z" {
		t.Fatalf("FormatTime %s", got)
	}
	for _, bad := range []string{"2026-09-27T16:42:00Z", "2026-09-27T16:42:00.1234Z", "2026-09-27 16:42:00.123Z", "2026-13-01T00:00:00.000Z", "2026-09-27T16:42:00.123+00:00"} {
		if _, err := ParseTime(bad); err == nil {
			t.Errorf("ParseTime(%q) accepted", bad)
		}
	}
	if got, err := ParseTime("2026-09-27T16:42:00.123Z"); err != nil || !got.Equal(ts.Truncate(time.Millisecond)) {
		t.Fatalf("ParseTime %v %v", got, err)
	}
}

// A snapshot taken in the middle of the log records the mac of its seq and replays
// the rest.
func TestSnapshotInTheMiddleOfTheLog(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	out := mustAppend(t, s, batchOf(2, "a"))
	mustAppend(t, s, batchOf(2, "b"))
	if err := s.SaveState(StateSnapshot{LastEventSeq: 3, Engine: map[string]int{"n": 3}}); err != nil {
		t.Fatal(err)
	}
	var doc stateDoc
	if err := json.Unmarshal(readFileT(t, filepath.Join(e.dir, stateFile)), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.LastEventMac != out[1].Mac || doc.Epoch != s.Epoch() || doc.SchemaVersion != SchemaVersion {
		t.Fatalf("doc %+v", doc)
	}
	s2, rep := e.reopen(s)
	if rep.State != StateCurrent || rep.ReplayFrom != 3 || rep.LastSeq != 5 || rep.Recovery != RecoveryReplayed {
		t.Fatalf("report %+v", rep)
	}
	if s2.Report().ReplayFrom != 3 || s2.Dir() != e.dir {
		t.Fatal("Report/Dir")
	}
	p, err := s2.ReadEvents(s2.Epoch(), rep.ReplayFrom, 100)
	if err != nil || len(p.Events) != 2 || p.Events[0].Seq != 4 {
		t.Fatalf("replay page %+v %v", p, err)
	}
}

func TestReadEnforcementFallsBackToPrevious(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	for gen := 1; gen <= 2; gen++ {
		if err := s.SaveState(snapshot(s, gen)); err != nil {
			t.Fatal(err)
		}
	}
	writeFileT(t, filepath.Join(e.dir, stateFile), []byte("{broken"))
	enf, err := ReadEnforcement(e.dir)
	if err != nil {
		t.Fatal(err)
	}
	var core map[string]any
	if err := json.Unmarshal(enf, &core); err != nil || core["gen"] != float64(1) {
		t.Fatalf("enforcement %s", enf)
	}
	if err := os.Remove(filepath.Join(e.dir, statePrevFile)); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadEnforcement(e.dir); err == nil {
		t.Fatal("no usable snapshot must fail")
	}
}
