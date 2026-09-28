package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestFreshOpenIsCleanAndNeedsInstallEpoch(t *testing.T) {
	e := newEnv(t)
	s, rep := e.open()
	if !rep.Fresh || rep.NeedEpoch != EpochInstall || rep.UncleanShutdown || rep.SafeMode || !rep.KeyCreated ||
		rep.Recovery != RecoveryEmpty || rep.AnchorCheck != AnchorAbsent || rep.State != StateNone {
		t.Fatalf("report %+v", rep)
	}
	for _, d := range []string{dirEvents, dirQuarantine, dirBackups, dirSecret, dirRun} {
		if fi, err := os.Stat(filepath.Join(e.dir, d)); err != nil || !fi.IsDir() {
			t.Fatalf("%s: %v", d, err)
		}
	}
	if _, err := s.ReadEvents("", 0, 10); !errors.Is(err, ErrNoEpoch) {
		t.Fatalf("ReadEvents: %v", err)
	}
	out, err := s.NewEpoch(EpochInstall, []Event{epochStarted("install", ""), ev("settings_changed", 0, `{}`)})
	if err != nil || len(out) != 2 || out[0].Seq != 1 || out[0].PrevMac != "" || out[0].TxEnd || !out[1].TxEnd {
		t.Fatalf("NewEpoch %+v %v", out, err)
	}
	cur := readFileT(t, filepath.Join(e.dir, dirEvents, currentFile))
	if string(cur) != s.Epoch()+"\n" || !isEpochID(s.Epoch()) {
		t.Fatalf("current %q", cur)
	}
	if _, err := os.Stat(filepath.Join(e.epochDir(s), "00000001.jsonl")); err != nil {
		t.Fatal(err)
	}
}

func TestCleanAndUncleanShutdown(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	s, rep := e.reopen(s)
	if rep.UncleanShutdown || rep.Fresh {
		t.Fatalf("clean reopen: %+v", rep)
	}
	if _, err := os.Stat(filepath.Join(e.dir, dirRun, cleanMarker)); !os.IsNotExist(err) {
		t.Fatal("the marker must be consumed at start")
	}
	_ = s.Close() // crash: no marker
	s, rep = e.open()
	if !rep.UncleanShutdown || rep.UncleanStarts != 1 || rep.SafeMode {
		t.Fatalf("unclean: %+v", rep)
	}
	e.closeClean(s)
}

// Three unclean starts within 5 minutes enter safe mode; the window follows the boot
// clock within one boot, whatever the wall clock does.
func TestSafeModeAfterThreeUncleanStarts(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	_ = s.Close()
	crash := func() RecoveryReport {
		s, rep := e.open()
		_ = s.Close()
		return rep
	}
	if r := crash(); r.UncleanStarts != 1 || r.SafeMode {
		t.Fatalf("1st %+v", r)
	}
	e.clk.Advance(2 * time.Minute)
	e.clk.JumpWall(-time.Hour) // a wall-clock change does not hide the loop
	if r := crash(); r.UncleanStarts != 2 || r.SafeMode {
		t.Fatalf("2nd %+v", r)
	}
	e.clk.Advance(2 * time.Minute)
	if r := crash(); r.UncleanStarts != 3 || !r.SafeMode {
		t.Fatalf("3rd %+v", r)
	}
	e.clk.Advance(6 * time.Minute) // the window slides
	if r := crash(); r.UncleanStarts != 1 || r.SafeMode {
		t.Fatalf("after the window %+v", r)
	}
	// Across a reboot the wall clock measures the window.
	e.clk.Reboot()
	e.clk.Advance(time.Minute)
	if r := crash(); r.UncleanStarts != 2 {
		t.Fatalf("after reboot %+v", r)
	}
	var doc startsDoc
	if err := json.Unmarshal(readFileT(t, filepath.Join(e.dir, dirRun, startsFile)), &doc); err != nil || len(doc.Unclean) != 2 {
		t.Fatalf("starts.json %+v %v", doc, err)
	}
}

func TestPlannedStopMarker(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	if err := s.MarkPlannedStop("shutdown"); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkPlannedStop("Bad Reason"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("bad reason: %v", err)
	}
	e.clk.Advance(9 * time.Minute)
	s, rep := e.reopen(s)
	ps := rep.PlannedStop
	if !ps.Present || !ps.Valid || ps.Reason != "shutdown" || !ps.At.Equal(e.clk.Now().Add(-9*time.Minute)) {
		t.Fatalf("planned stop %+v", ps)
	}
	if _, err := os.Stat(filepath.Join(e.dir, dirRun, plannedMarker)); !os.IsNotExist(err) {
		t.Fatal("the marker must be consumed")
	}
	s, rep = e.reopen(s)
	if rep.PlannedStop.Present {
		t.Fatal("consumed marker seen twice")
	}

	// Expired.
	if err := s.MarkPlannedStop("update"); err != nil {
		t.Fatal(err)
	}
	e.clk.Advance(11 * time.Minute)
	s, rep = e.reopen(s)
	if !rep.PlannedStop.Present || rep.PlannedStop.Valid || rep.PlannedStop.Problem == "" {
		t.Fatalf("expired %+v", rep.PlannedStop)
	}

	// An empty marker (an installer just creating the file) is dated by its mtime.
	p := filepath.Join(e.dir, dirRun, plannedMarker)
	writeFileT(t, p, nil)
	if err := os.Chtimes(p, e.clk.Now(), e.clk.Now().Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	s, rep = e.reopen(s)
	if !rep.PlannedStop.Valid || rep.PlannedStop.Reason != "" {
		t.Fatalf("empty marker %+v", rep.PlannedStop)
	}

	// Not owned by root/SYSTEM: never valid.
	if err := s.MarkPlannedStop("update"); err != nil {
		t.Fatal(err)
	}
	e.mod = func(o *Options) {
		o.trustOwner = func(path string) error {
			if filepath.Base(path) == plannedMarker {
				return errors.New("owned by a user")
			}
			return nil
		}
	}
	s, rep = e.reopen(s)
	if rep.PlannedStop.Valid || rep.PlannedStop.Problem != "owned by a user" {
		t.Fatalf("untrusted %+v", rep.PlannedStop)
	}
	e.mod = nil

	// Garbage content is not valid.
	writeFileT(t, p, []byte("{nope"))
	s, rep = e.reopen(s)
	if !rep.PlannedStop.Present || rep.PlannedStop.Valid {
		t.Fatalf("garbage %+v", rep.PlannedStop)
	}
	e.closeClean(s)

	// WritePlannedStop works without the store (installer, CLI) and while it is open.
	s, _ = e.open()
	if err := WritePlannedStop(e.dir, "update"); err != nil {
		t.Fatal(err)
	}
	var doc markerDoc
	if err := json.Unmarshal(readFileT(t, p), &doc); err != nil || doc.Reason != "update" || doc.V != 1 {
		t.Fatalf("marker %+v %v", doc, err)
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(p); fi.Mode().Perm() != secretPerm {
			t.Fatalf("marker mode %v", fi.Mode().Perm())
		}
	}
	e.closeClean(s)
}

func TestLockIsExclusive(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	if _, _, err := Open(e.dir, e.options()); !errors.Is(err, ErrLocked) {
		t.Fatalf("second Open: %v", err)
	}
	e.closeClean(s)
	s2, _ := e.open()
	if err := s2.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s2.Close(); err != nil {
		t.Fatal("Close twice")
	}
	if _, err := s2.AppendBatch(batchOf(1, "x")); !errors.Is(err, ErrClosed) {
		t.Fatalf("after Close: %v", err)
	}
	if _, err := s2.ReadEvents("", 0, 1); !errors.Is(err, ErrClosed) {
		t.Fatalf("after Close: %v", err)
	}
}

func TestOpenRequiresAnchorInTestsAndAbsoluteDir(t *testing.T) {
	if _, _, err := Open(t.TempDir(), Options{}); err == nil {
		t.Fatal("tests must pass an anchor")
	}
	if _, _, err := Open("relative/dir", Options{Anchor: NewMemAnchor()}); err == nil {
		t.Fatal("relative directory accepted")
	}
}

func TestLedgerKey(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	key := e.key()
	if len(key) != keySize {
		t.Fatalf("key %d bytes", len(key))
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(filepath.Join(e.dir, dirSecret, keyFile))
		di, _ := os.Stat(filepath.Join(e.dir, dirSecret))
		if fi.Mode().Perm() != secretPerm || di.Mode().Perm() != 0o700 {
			t.Fatalf("modes %v %v", fi.Mode().Perm(), di.Mode().Perm())
		}
	}
	mustAppend(t, s, batchOf(1, "a"))
	s, rep := e.reopen(s)
	if rep.KeyCreated || rep.KeyReplaced || !bytes.Equal(e.key(), key) || rep.LastSeq != 2 {
		t.Fatalf("reused key: %+v", rep)
	}
	oldEpoch := s.Epoch()
	e.closeClean(s)

	// A key not owned by SYSTEM/root is compromised: replaced, new epoch untrusted_key.
	e.mod = func(o *Options) {
		o.trustOwner = func(path string) error {
			if filepath.Base(path) == keyFile {
				return errors.New("owned by uid 1000")
			}
			return nil
		}
	}
	s, rep = e.open()
	e.mod = nil
	if !rep.KeyReplaced || rep.KeyProblem != "owned by uid 1000" || rep.NeedEpoch != EpochUntrustedKey ||
		rep.Epoch != "" || rep.State != StateNone || rep.AnchorCheck != AnchorAbsent {
		t.Fatalf("untrusted key: %+v", rep)
	}
	if bytes.Equal(e.key(), key) {
		t.Fatal("key not replaced")
	}
	if _, err := s.NewEpoch(EpochUntrustedKey, []Event{epochStarted("untrusted_key", oldEpoch),
		ev("tamper_detected", 0, `{"kind":"untrusted_key","balanceCorrection":0,"voidStreak":false}`)}); err != nil {
		t.Fatal(err)
	}
	s, rep = e.reopen(s)
	if rep.KeyReplaced || rep.LastSeq != 2 || rep.Repair != nil {
		t.Fatalf("after the new epoch: %+v", rep)
	}
	e.closeClean(s)

	// A key of the wrong length is replaced too.
	writeFileT(t, filepath.Join(e.dir, dirSecret, keyFile), []byte("short"))
	_, rep = e.open()
	if !rep.KeyReplaced || rep.NeedEpoch != EpochUntrustedKey {
		t.Fatalf("short key: %+v", rep)
	}
}

func TestDeletedKeyMakesLogUnreadable(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	mustAppend(t, s, batchOf(1, "a"))
	if err := s.SaveState(snapshot(s, 1)); err != nil {
		t.Fatal(err)
	}
	e.closeClean(s)
	if err := os.Remove(filepath.Join(e.dir, dirSecret, keyFile)); err != nil {
		t.Fatal(err)
	}
	_, rep := e.open()
	if !rep.KeyCreated || rep.NeedEpoch != EpochLogUnreadable || !rep.StateMACInvalid || rep.Fresh {
		t.Fatalf("report %+v", rep)
	}
}

func TestClockFile(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	type snap struct {
		Trusted string `json:"trusted"`
		BootNs  int64  `json:"bootNs"`
	}
	var got snap
	if ok, err := s.LoadClock(&got); ok || err != nil {
		t.Fatalf("missing clock: %v %v", ok, err)
	}
	want := snap{Trusted: "2026-09-28T10:00:00Z", BootNs: 123456789}
	if err := s.SaveClock(want); err != nil {
		t.Fatal(err)
	}
	s, _ = e.reopen(s)
	if ok, err := s.LoadClock(&got); !ok || err != nil || got != want {
		t.Fatalf("LoadClock %v %v %+v", ok, err, got)
	}
	p := filepath.Join(e.dir, dirRun, clockFile)
	raw := readFileT(t, p)
	writeFileT(t, p, bytes.Replace(raw, []byte("2026-09-28"), []byte("2026-09-29"), 1))
	if ok, err := s.LoadClock(&got); ok || !errors.Is(err, ErrTampered) {
		t.Fatalf("edited clock: %v %v", ok, err)
	}
}
