package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewEpochDataDeleted(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	mustAppend(t, s, batchOf(3, "a"))
	if err := s.SaveState(snapshot(s, 1)); err != nil {
		t.Fatal(err)
	}
	old := s.Epoch()
	for _, p := range []string{
		filepath.Join(e.dir, dirQuarantine, "corrupt-x.jsonl"),
		filepath.Join(e.dir, dirBackups, "state.v1.json"),
		filepath.Join(e.dir, dirBackups, "hosts.bak"),
		filepath.Join(e.dir, dirBackups, "hosts.original"),
	} {
		writeFileT(t, p, []byte("x"))
	}
	if err := os.MkdirAll(filepath.Join(e.dir, dirQuarantine, "epoch-old"), 0o755); err != nil {
		t.Fatal(err)
	}
	out, err := s.NewEpoch(EpochDataDeleted, []Event{epochStarted("data_deleted", old)})
	if err != nil {
		t.Fatal(err)
	}
	if s.Epoch() == old || out[0].Epoch != s.Epoch() || s.LastSeq() != 1 {
		t.Fatalf("epoch %s → %s, last %d", old, s.Epoch(), s.LastSeq())
	}
	if _, err := os.Stat(filepath.Join(e.dir, dirEvents, old)); !os.IsNotExist(err) {
		t.Fatal("old epoch segments survived data deletion")
	}
	if q := e.quarantine(); len(q) != 0 {
		t.Fatalf("quarantine survived data deletion: %v", q)
	}
	if _, err := os.Stat(filepath.Join(e.dir, dirBackups, "state.v1.json")); !os.IsNotExist(err) {
		t.Fatal("state backups survived data deletion")
	}
	for _, keep := range []string{"hosts.bak", "hosts.original"} {
		if _, err := os.Stat(filepath.Join(e.dir, dirBackups, keep)); err != nil {
			t.Fatalf("%s removed: %v", keep, err)
		}
	}
	// A client still on the old epoch is reset to the new one.
	p, err := s.ReadEvents(old, 4, 10)
	if err != nil || !p.Reset || len(p.Events) != 1 || p.Events[0].Type != "epoch_started" {
		t.Fatalf("page %+v %v", p, err)
	}
	// The post-deletion state is written as both generations.
	if err := s.SaveStateAll(snapshot(s, 2)); err != nil {
		t.Fatal(err)
	}
	s, rep := e.reopen(s)
	var got engineState
	if _, err := s.LoadState(&got); err != nil || got.Gen != 2 || rep.State != StateCurrent || rep.Recovery != RecoveryNone {
		t.Fatalf("after deletion: gen %d %v %+v", got.Gen, err, rep)
	}
}

func TestNewEpochRules(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	if _, err := s.NewEpoch(EpochDataDeleted, []Event{epochStarted("data_deleted", ""), epochStarted("x", "")}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("two epoch_started: %v", err)
	}
	if _, err := s.AppendBatch([]Event{epochStarted("x", "")}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("epoch_started through AppendBatch: %v", err)
	}
}

// Crash at every step of NewEpoch: the next Open finds either the previous epoch,
// complete, or the new one; never a broken current pointer.
func TestNewEpochCrashAtEveryStep(t *testing.T) {
	for k := 1; ; k++ {
		e := newEnv(t)
		ffs := newFaultFS()
		e.fs = ffs
		s := e.started()
		mustAppend(t, s, batchOf(2, "a"))
		old := s.Epoch()
		ffs.arm(k, true, 7, nil)
		_, err := s.NewEpoch(EpochDataDeleted, []Event{epochStarted("data_deleted", old)})
		if !ffs.didFail() {
			if err != nil {
				t.Fatal(err)
			}
			break
		}
		_ = s.Close()
		ffs.disarm()
		e.fs = nil
		s2, rep := e.open()
		switch {
		case rep.NeedEpoch != "":
			t.Fatalf("k=%d: %+v", k, rep)
		case rep.Epoch == old && rep.LastSeq != 3:
			t.Fatalf("k=%d: old epoch with %d events", k, rep.LastSeq)
		case rep.Epoch != old && rep.LastSeq != 1:
			t.Fatalf("k=%d: new epoch with %d events", k, rep.LastSeq)
		}
		entries, _ := os.ReadDir(filepath.Join(e.dir, dirEvents))
		for _, d := range entries {
			if d.IsDir() && d.Name() != rep.Epoch {
				t.Fatalf("k=%d: orphan epoch %s left after Open", k, d.Name())
			}
		}
		if rep.Repair != nil {
			t.Fatalf("k=%d: crash reported as tampering", k)
		}
		e.closeClean(s2)
	}
}

func TestOrphanEpochRemovedAtOpen(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	e.closeClean(s)
	orphan := filepath.Join(e.dir, dirEvents, "ep_ORPHANORPHANORPHANORPHAN")
	if err := os.MkdirAll(orphan, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFileT(t, filepath.Join(orphan, "00000001.jsonl"), []byte("x\n"))
	other := filepath.Join(e.dir, dirEvents, "not-an-epoch")
	if err := os.MkdirAll(other, 0o755); err != nil {
		t.Fatal(err)
	}
	_, rep := e.open()
	if _, err := os.Stat(orphan); !os.IsNotExist(err) || rep.NeedEpoch != "" {
		t.Fatalf("orphan kept (%v) %+v", err, rep)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatal("unknown directories are left alone")
	}
}

func TestMissingCurrentIsUnreadableNotFresh(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	mustAppend(t, s, batchOf(1, "a"))
	if err := s.SaveState(snapshot(s, 7)); err != nil {
		t.Fatal(err)
	}
	old := s.Epoch()
	e.closeClean(s)
	if err := os.Remove(filepath.Join(e.dir, dirEvents, currentFile)); err != nil {
		t.Fatal(err)
	}
	s, rep := e.open()
	if rep.Fresh || rep.NeedEpoch != EpochLogUnreadable || rep.State != StateCurrent || rep.Recovery != RecoveryBackupSnapshot {
		t.Fatalf("report %+v", rep)
	}
	// The snapshot survives for the engine's kept state.
	var got engineState
	ls, err := s.LoadState(&got)
	if err != nil || got.Gen != 7 || ls.Epoch != old {
		t.Fatalf("LoadState %+v %v", ls, err)
	}
	if _, err := s.NewEpoch(EpochLogUnreadable, []Event{epochStarted("log_unreadable", old)}); err != nil {
		t.Fatal(err)
	}
	var moved bool
	for _, q := range e.quarantine() {
		moved = moved || strings.HasPrefix(q, "epoch-"+old)
	}
	if !moved {
		t.Fatalf("old epoch not quarantined: %v", e.quarantine())
	}
}

func TestDeletedEventsWithAnchorIsNotFresh(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	mustAppend(t, s, batchOf(1, "a"))
	if err := s.PutAnchor(Anchor{Balance: -300, At: testAt}); err != nil {
		t.Fatal(err)
	}
	e.closeClean(s)
	for _, p := range []string{dirEvents, stateFile, statePrevFile} {
		_ = os.RemoveAll(filepath.Join(e.dir, p))
	}
	_, rep := e.open()
	if rep.Fresh || rep.NeedEpoch != EpochLogUnreadable || rep.Anchor == nil || rep.Anchor.Balance != -300 ||
		rep.AnchorCheck != AnchorUnverified {
		t.Fatalf("report %+v", rep)
	}
}
