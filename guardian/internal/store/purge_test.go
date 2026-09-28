package store

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const privateWord = "privatesite"

// seedPrivateData fills a started store with data a deletion must remove: events,
// both state generations, a quarantined file and a pre-migration backup.
func seedPrivateData(t *testing.T, e *env, s *Store) {
	t.Helper()
	mustAppend(t, s, []Event{ev("attempt", -10, `{"attemptId":"att_x1","targetKey":"dom:`+privateWord+`.example"}`)})
	for gen := 1; gen <= 2; gen++ {
		snap := snapshot(s, gen)
		snap.Engine = engineState{Gen: gen, Note: privateWord + ".example"}
		if err := s.SaveState(snap); err != nil {
			t.Fatal(err)
		}
	}
	writeFileT(t, filepath.Join(e.dir, dirQuarantine, "corrupt-x.jsonl"), []byte(privateWord+"\n"))
	writeFileT(t, filepath.Join(e.dir, dirBackups, "state.v1.json"), []byte(privateWord+"\n"))
}

// filesWith lists the files under dir holding word.
func filesWith(t *testing.T, dir, word string) []string {
	t.Helper()
	var out []string
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if b, err := os.ReadFile(p); err == nil && bytes.Contains(b, []byte(word)) {
			out = append(out, p)
		}
		return nil
	})
	return out
}

func purgeMarkerExists(e *env) bool {
	_, err := os.Lstat(filepath.Join(e.dir, dirRun, purgeMarker))
	return err == nil
}

// Regression: a crash at any step of a data deletion (NewEpoch, then SaveStateAll)
// used to leave quarantine/*, backups/state.v*.json and a state.prev.json of the
// deleted epoch forever once events/current had switched. Now the next Open resumes
// the deletion (PurgePending) and nothing of the deleted data survives it.
func TestDataDeletionCrashResumedAtOpen(t *testing.T) {
	for k := 1; ; k++ {
		e := newEnv(t)
		ffs := newFaultFS()
		e.fs = ffs
		s := e.started()
		seedPrivateData(t, e, s)
		old := s.Epoch()
		ffs.arm(k, true, 3, nil)
		_, err := s.NewEpoch(EpochDataDeleted, []Event{epochStarted("data_deleted", old)})
		if err == nil || errors.Is(err, ErrCleanup) {
			_ = s.SaveStateAll(snapshot(s, 3))
		}
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
		if rep.Epoch == old {
			// The crash came before the switch: nothing was deleted, no deletion pending.
			if rep.PurgePending || purgeMarkerExists(e) {
				t.Fatalf("k=%d: deletion pending on the old epoch", k)
			}
			e.closeClean(s2)
			continue
		}
		if !rep.PurgePending || !s2.PurgePending() || rep.NeedEpoch != "" {
			t.Fatalf("k=%d: interrupted deletion not reported: %+v", k, rep)
		}
		if left := filesWith(t, e.dir, privateWord); len(left) > 0 {
			t.Fatalf("k=%d: deleted data survived the restart in %v", k, left)
		}
		// The engine finishes: its scrubbing, both generations, then FinishPurge.
		if err := s2.FinishPurge(); err == nil {
			t.Fatalf("k=%d: FinishPurge before SaveStateAll", k)
		}
		if err := s2.SaveState(snapshot(s2, 4)); err != nil {
			t.Fatal(err)
		}
		if err := s2.SaveStateAll(snapshot(s2, 4)); err != nil {
			t.Fatal(err)
		}
		if err := s2.FinishPurge(); err != nil {
			t.Fatalf("k=%d: FinishPurge: %v", k, err)
		}
		if s2.PurgePending() || purgeMarkerExists(e) {
			t.Fatalf("k=%d: marker kept after FinishPurge", k)
		}
		s3, rep := e.reopen(s2)
		if rep.PurgePending || rep.State != StateCurrent || len(filesWith(t, e.dir, privateWord)) > 0 {
			t.Fatalf("k=%d: after finishing: %+v", k, rep)
		}
		e.closeClean(s3)
	}
}

// Regression: a cleanup failure inside NewEpoch (ErrCleanup, only logged by the
// engine) was never retried. The marker keeps the deletion pending and FinishPurge
// retries it.
func TestDataDeletionCleanupFailureRetried(t *testing.T) {
	e := newEnv(t)
	ffs := newFaultFS()
	e.fs = ffs
	s := e.started()
	seedPrivateData(t, e, s)
	old := s.Epoch()
	failing := &failRemoveFS{faultFS: ffs, match: "corrupt-x.jsonl"}
	s.fs = failing
	_, err := s.NewEpoch(EpochDataDeleted, []Event{epochStarted("data_deleted", old)})
	if !errors.Is(err, ErrCleanup) {
		t.Fatalf("NewEpoch: %v", err)
	}
	if _, err := os.Stat(filepath.Join(e.dir, dirQuarantine, "corrupt-x.jsonl")); err != nil {
		t.Fatal("the injected failure did not keep the file")
	}
	for _, f := range []string{stateFile, statePrevFile} {
		if _, err := os.Stat(filepath.Join(e.dir, f)); !os.IsNotExist(err) {
			t.Fatalf("%s of the deleted epoch kept", f)
		}
	}
	if err := s.SaveStateAll(snapshot(s, 3)); err != nil {
		t.Fatal(err)
	}
	if err := s.FinishPurge(); !errors.Is(err, ErrCleanup) || !purgeMarkerExists(e) {
		t.Fatalf("FinishPurge with the failure still there: %v", err)
	}
	failing.set("")
	if err := s.FinishPurge(); err != nil || purgeMarkerExists(e) {
		t.Fatalf("FinishPurge: %v", err)
	}
	if left := filesWith(t, e.dir, privateWord); len(left) > 0 {
		t.Fatalf("deleted data survived: %v", left)
	}
	// Without a pending deletion FinishPurge does nothing.
	if err := s.FinishPurge(); err != nil {
		t.Fatal(err)
	}
}

// Regression: recover() kept a state.json of another epoch as the previous generation,
// so the first save rotated deleted data into state.prev.json.
func TestOtherEpochStateNeverRotated(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	seedPrivateData(t, e, s)
	old := s.Epoch()
	stale := readFileT(t, filepath.Join(e.dir, stateFile))
	if _, err := s.NewEpoch(EpochDataDeleted, []Event{epochStarted("data_deleted", old)}); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveStateAll(snapshot(s, 3)); err != nil {
		t.Fatal(err)
	}
	if err := s.FinishPurge(); err != nil {
		t.Fatal(err)
	}
	e.closeClean(s)
	// A snapshot of the old epoch (valid MAC) put back as state.json.
	writeFileT(t, filepath.Join(e.dir, stateFile), stale)
	s, rep := e.open()
	if !rep.StateStale || rep.State != StatePrevious {
		t.Fatalf("report %+v", rep)
	}
	if err := s.SaveState(snapshot(s, 4)); err != nil {
		t.Fatal(err)
	}
	if left := filesWith(t, e.dir, privateWord); len(left) > 0 {
		t.Fatalf("old-epoch snapshot rotated: %v", left)
	}
}

// failRemoveFS fails Remove and RemoveAll of paths containing match.
type failRemoveFS struct {
	*faultFS
	mu    sync.Mutex
	match string
}

func (f *failRemoveFS) set(m string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.match = m
}

func (f *failRemoveFS) fails(name string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.match != "" && strings.Contains(name, f.match)
}

func (f *failRemoveFS) Remove(name string) error {
	if f.fails(name) {
		return errInjected
	}
	return f.faultFS.Remove(name)
}

func (f *failRemoveFS) RemoveAll(name string) error {
	if f.fails(name) {
		return errInjected
	}
	return f.faultFS.RemoveAll(name)
}

// recordFS records the perm of every file created with O_EXCL.
type recordFS struct {
	FS
	mu    sync.Mutex
	perms map[string]fs.FileMode
}

func (r *recordFS) OpenFile(name string, flag int, perm fs.FileMode) (File, error) {
	if flag&os.O_EXCL != 0 {
		base := filepath.Base(name)
		if i := strings.Index(base, tmpInfix); i >= 0 {
			base = base[:i]
		}
		r.mu.Lock()
		r.perms[base] = perm
		r.mu.Unlock()
	}
	return r.FS.OpenFile(name, flag, perm)
}

// Regression (Windows): the snapshots were created readable by every local account,
// so a standard user could hold a share-mode-0 handle on them and make every state
// save fail. They are created with statePerm, which is private on Windows.
func TestStateFilesUseStatePerm(t *testing.T) {
	e := newEnv(t)
	rec := &recordFS{FS: OSFS(), perms: map[string]fs.FileMode{}}
	e.fs = rec
	s := e.started()
	mustAppend(t, s, batchOf(1, "a"))
	for gen := 1; gen <= 2; gen++ {
		if err := s.SaveState(snapshot(s, gen)); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{stateFile, statePrevFile} {
		if got, ok := rec.perms[f]; !ok || got != statePerm {
			t.Fatalf("%s created with %v, want %v", f, got, statePerm)
		}
	}
	if err := s.backupState(1, []byte("{}\n")); err != nil {
		t.Fatal(err)
	}
	if got := rec.perms["state.v1.json"]; got != statePerm {
		t.Fatalf("state backup created with %v", got)
	}
}
