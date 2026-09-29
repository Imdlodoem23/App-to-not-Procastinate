package store

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func sampleAnchor() Anchor {
	day, voided, last := "2026-09-27", "2026-09-28", "2026-09-28T09:00:00.000Z"
	return Anchor{
		Epoch: "ep_AAAAAAAAAAAAAAAAAAAAAA", Seq: 12, Mac: strings.Repeat("A", macLen),
		Balance: -250, XP: 90, Escalation: AnchorEscalation{LastCountedAt: &last, Index: 2},
		Streak: 3, BestStreak: 9, LastClosedDay: &day, VoidedDay: &voided, At: testAt,
	}
}

func TestFileAnchorRoundTrip(t *testing.T) {
	for _, plist := range []bool{false, true} {
		dir := t.TempDir()
		f := &FileAnchor{Path: filepath.Join(dir, "etc", "centrate", "anchor.json"), Plist: plist, CreateDir: true}
		if _, ok, err := f.Load(); ok || err != nil {
			t.Fatalf("plist=%v: empty load %v %v", plist, ok, err)
		}
		a := sampleAnchor()
		a.At = `2026-09-28T10:00:00.000Z<&>"`
		if err := f.Save(a); err != nil {
			t.Fatal(err)
		}
		got, ok, err := f.Load()
		if !ok || err != nil || !reflect.DeepEqual(got, a) {
			t.Fatalf("plist=%v: %+v %v %v", plist, got, ok, err)
		}
		raw := readFileT(t, f.Path)
		if plist && !strings.Contains(string(raw), "<key>Anchor</key>") {
			t.Fatalf("not a plist: %s", raw)
		}
		if runtime.GOOS != "windows" {
			if fi, _ := os.Stat(f.Path); fi.Mode().Perm() != 0o600 {
				t.Fatalf("mode %v", fi.Mode().Perm())
			}
		}
		writeFileT(t, f.Path, []byte("garbage"))
		if _, _, err := f.Load(); !errors.Is(err, ErrAnchorFormat) {
			t.Fatalf("plist=%v: garbage: %v", plist, err)
		}
		if err := f.Remove(); err != nil {
			t.Fatal(err)
		}
		if err := f.Remove(); err != nil {
			t.Fatal("second Remove")
		}
	}
}

func TestPlistParsesForeignLayout(t *testing.T) {
	doc := []byte(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Other</key><string>x</string>
  <key>Nested</key><dict><key>Anchor</key><string>wrong</string></dict>
  <key>Anchor</key><string>{&quot;seq&quot;:1}</string>
</dict></plist>`)
	got, err := plistString(doc, "Anchor")
	if err != nil || string(got) != `{"seq":1}` {
		t.Fatalf("%q %v", got, err)
	}
}

func TestMemAnchor(t *testing.T) {
	m := NewMemAnchor()
	a := sampleAnchor()
	if err := m.Save(a); err != nil {
		t.Fatal(err)
	}
	*a.VoidedDay = "changed"
	got, ok, _ := m.Load()
	if !ok || *got.VoidedDay != "2026-09-28" || m.Saves() != 1 {
		t.Fatal("MemAnchor aliases its input")
	}
	m.SaveErr = errors.New("registry denied")
	if err := m.Save(a); err == nil {
		t.Fatal("SaveErr ignored")
	}
	m.Set(nil)
	if _, ok, _ := m.Load(); ok {
		t.Fatal("Set(nil)")
	}
}

func TestPutAnchorAndConsistentCheck(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	out := mustAppend(t, s, batchOf(2, "a"))
	if err := s.PutAnchor(Anchor{Balance: -20, At: testAt}); err != nil {
		t.Fatal(err)
	}
	a, ok, _ := s.Anchor()
	if !ok || a.Epoch != s.Epoch() || a.Seq != 3 || a.Mac != out[1].Mac || a.Balance != -20 {
		t.Fatalf("anchor %+v", a)
	}
	// Explicit positions must name a committed event.
	if err := s.PutAnchor(Anchor{Epoch: s.Epoch(), Seq: 2, Mac: out[0].Mac, At: testAt}); err != nil {
		t.Fatal(err)
	}
	for name, bad := range map[string]Anchor{
		"ahead":     {Epoch: s.Epoch(), Seq: 9, Mac: out[1].Mac, At: testAt},
		"other mac": {Epoch: s.Epoch(), Seq: 2, Mac: out[1].Mac, At: testAt},
		"epoch":     {Epoch: "ep_AAAAAAAAAAAAAAAAAAAAAA", Seq: 2, Mac: out[0].Mac, At: testAt},
		"time":      {At: "yesterday"},
	} {
		if err := s.PutAnchor(bad); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
	mustAppend(t, s, batchOf(1, "b"))
	_, rep := e.reopen(s)
	if rep.AnchorCheck != AnchorConsistent || rep.Anchor.Seq != 2 {
		t.Fatalf("check %s %+v", rep.AnchorCheck, rep.Anchor)
	}
}

func TestPutAnchorFailureIsWriteError(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	e.anchor.SaveErr = errors.New("registry denied")
	err := s.PutAnchor(Anchor{At: testAt})
	var we *WriteError
	if !errors.As(err, &we) {
		t.Fatalf("err %v", err)
	}
}

// Restoring an old copy of the directory (or truncating the log) after the anchor
// moved on is a rollback; so is a log that diverged at the anchor's seq.
func TestAnchorDetectsRollback(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	mustAppend(t, s, batchOf(2, "a"))
	seg := e.segments(s)[0]
	before := readFileT(t, seg)
	mustAppend(t, s, ev("emergency_confirmed", -200, `{"penalty":200}`).batch())
	if err := s.PutAnchor(Anchor{Balance: -220, At: testAt}); err != nil {
		t.Fatal(err)
	}
	e.closeClean(s)

	writeFileT(t, seg, before) // the penalty batch vanished
	s, rep := e.open()
	if rep.AnchorCheck != AnchorRollback || rep.Anchor.Balance != -220 || rep.LastSeq != 3 {
		t.Fatalf("truncated: %s %+v", rep.AnchorCheck, rep)
	}
	// The log then diverges at the anchor's seq with other content.
	mustAppend(t, s, batchOf(1, "other"))
	_, rep = e.reopen(s)
	if rep.AnchorCheck != AnchorRollback || rep.LastSeq != 4 {
		t.Fatalf("diverged: %s last %d", rep.AnchorCheck, rep.LastSeq)
	}
}

func (x Event) batch() []Event { return []Event{x} }

func TestAnchorEpochCases(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	mustAppend(t, s, batchOf(1, "a"))
	if err := s.PutAnchor(Anchor{At: testAt}); err != nil {
		t.Fatal(err)
	}
	old := s.Epoch()
	// Stopped between NewEpoch and PutAnchor: the anchor names the previous epoch.
	if _, err := s.NewEpoch(EpochDataDeleted, []Event{epochStarted("data_deleted", old)}); err != nil {
		t.Fatal(err)
	}
	s, rep := e.reopen(s)
	if rep.AnchorCheck != AnchorPreviousEpoch {
		t.Fatalf("previous epoch: %s", rep.AnchorCheck)
	}
	if err := s.PutAnchor(Anchor{At: testAt}); err != nil {
		t.Fatal(err)
	}
	s, rep = e.reopen(s)
	if rep.AnchorCheck != AnchorConsistent {
		t.Fatalf("moved: %s", rep.AnchorCheck)
	}
	// An anchor of an unrelated epoch (a restored directory from before a deletion).
	a := sampleAnchor()
	e.anchor.Set(&a)
	s, rep = e.reopen(s)
	if rep.AnchorCheck != AnchorRollback {
		t.Fatalf("unrelated epoch: %s", rep.AnchorCheck)
	}
	// Malformed and unreadable anchors.
	a.Seq = 0
	e.anchor.Set(&a)
	s, rep = e.reopen(s)
	if rep.AnchorCheck != AnchorInvalid {
		t.Fatalf("invalid: %s", rep.AnchorCheck)
	}
	e.anchor.LoadErr = errors.New("registry unavailable")
	_, rep = e.reopen(s)
	if rep.AnchorCheck != AnchorUnverified || rep.AnchorError == "" || rep.Anchor != nil || rep.Fresh {
		t.Fatalf("unreadable: %+v", rep)
	}
}

func TestDefaultAnchorFollowsDataDirOverride(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "centrate")
	t.Setenv("CENTRATE_DATA_DIR", dir)
	f, ok := DefaultAnchor().(*FileAnchor)
	if !ok || f.Path != dir+".anchor.json" {
		t.Fatalf("DefaultAnchor = %#v", DefaultAnchor())
	}
	t.Setenv("CENTRATE_DATA_DIR", "")
	if !reflect.DeepEqual(DefaultAnchor(), OSAnchor()) {
		t.Fatal("without the override DefaultAnchor is the OS anchor")
	}
}
