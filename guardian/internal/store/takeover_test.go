package store

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// takeoverSeam makes Open's directory takeovers (§11.1) behave like elevated ones
// whether or not the test runs elevated: directories are created as a process
// without elevation creates them, and the first takeover of target runs act, which
// does what the real takeover would do there and returns its report.
func takeoverSeam(target string, act func() platform.TakeoverReport) func(*Options) {
	done := false
	return func(o *Options) {
		o.ensureDir = func(dir string, private bool) (platform.TakeoverReport, error) {
			var rep platform.TakeoverReport
			if dir == target && !done {
				done = true
				rep = act()
			}
			mode := platform.DirMode
			if private {
				mode = platform.PrivateDirMode
			}
			return rep, os.MkdirAll(dir, mode)
		}
	}
}

// takeoverEnv is a directory with a log, a snapshot and, when anchored, an anchor,
// stopped cleanly. It returns the ledger key.
func takeoverEnv(t *testing.T, anchored bool) (*env, []byte) {
	t.Helper()
	e := newEnv(t)
	s := e.started()
	mustAppend(t, s, batchOf(1, "a"))
	if err := s.SaveState(snapshot(s, 1)); err != nil {
		t.Fatal(err)
	}
	if anchored {
		if err := s.PutAnchor(Anchor{Balance: -10, At: testAt}); err != nil {
			t.Fatal(err)
		}
	}
	e.closeClean(s)
	return e, e.key()
}

func hasWarning(rep RecoveryReport, sub string) bool {
	for _, w := range rep.Warnings {
		if strings.Contains(w, sub) {
			return true
		}
	}
	return false
}

// checkUntrustedKey checks a report for a key the takeover took away, and that the
// untrusted_key epoch the engine starts then works.
func checkUntrustedKey(t *testing.T, e *env, s *Store, rep RecoveryReport, oldKey []byte, problem string) {
	t.Helper()
	if !rep.KeyReplaced || rep.KeyCreated || !strings.Contains(rep.KeyProblem, problem) ||
		rep.NeedEpoch != EpochUntrustedKey || rep.Fresh || rep.Epoch != "" || rep.State != StateNone {
		t.Fatalf("report %+v", rep)
	}
	if k := e.key(); len(k) != keySize || bytes.Equal(k, oldKey) {
		t.Fatal("the ledger key was not replaced")
	}
	if _, err := s.NewEpoch(EpochUntrustedKey, []Event{epochStarted("untrusted_key", ""),
		ev("tamper_detected", 0, `{"kind":"untrusted_key","balanceCorrection":0,"voidStreak":false}`)}); err != nil {
		t.Fatal(err)
	}
	_, rep = e.reopen(s)
	if rep.KeyReplaced || rep.KeyCreated || rep.NeedEpoch != "" || rep.LastSeq != 2 {
		t.Fatalf("after the new epoch: %+v", rep)
	}
}

// Elevated, the whole-tree takeover deletes a planted secret/ledger.key link (or a
// secret/ that is a link) before loadKey looks: the key still counts as planted
// (untrusted_key), not as missing (log_unreadable). Regression: Open discarded the
// takeover report, so this path only worked without elevation.
func TestTakeoverDeletedKeyIsReplaced(t *testing.T) {
	t.Run("key", func(t *testing.T) {
		e, oldKey := takeoverEnv(t, true)
		keyPath := filepath.Join(e.dir, dirSecret, keyFile)
		e.mod = takeoverSeam(e.dir, func() platform.TakeoverReport {
			if err := os.Remove(keyPath); err != nil {
				t.Fatal(err)
			}
			return platform.TakeoverReport{Removed: []string{keyPath}}
		})
		s, rep := e.open()
		e.mod = nil
		if !hasWarning(rep, "takeover: removed "+keyPath) {
			t.Fatalf("warnings %q", rep.Warnings)
		}
		checkUntrustedKey(t, e, s, rep, oldKey, keyPath)
	})

	t.Run("secret dir", func(t *testing.T) {
		e, oldKey := takeoverEnv(t, false)
		secretDir := filepath.Join(e.dir, dirSecret)
		e.mod = takeoverSeam(e.dir, func() platform.TakeoverReport {
			if err := os.RemoveAll(secretDir); err != nil {
				t.Fatal(err)
			}
			return platform.TakeoverReport{Removed: []string{secretDir}}
		})
		s, rep := e.open()
		e.mod = nil
		checkUntrustedKey(t, e, s, rep, oldKey, secretDir+" was a link")
	})

	// A file that appears at the path after the takeover is not adopted either.
	t.Run("key reappeared", func(t *testing.T) {
		e, oldKey := takeoverEnv(t, true)
		keyPath := filepath.Join(e.dir, dirSecret, keyFile)
		known := bytes.Repeat([]byte{7}, keySize)
		e.mod = takeoverSeam(filepath.Join(e.dir, dirSecret), func() platform.TakeoverReport {
			writeFileT(t, keyPath, known)
			return platform.TakeoverReport{Removed: []string{keyPath}}
		})
		s, rep := e.open()
		e.mod = nil
		if bytes.Equal(e.key(), known) {
			t.Fatal("a key that appeared after the takeover was adopted")
		}
		checkUntrustedKey(t, e, s, rep, oldKey, keyPath)
	})

	// The takeover that deleted it ran before Open (the run command secures the data
	// directory before the log opens) and its report is passed in Options.Takeover.
	t.Run("earlier takeover", func(t *testing.T) {
		e, oldKey := takeoverEnv(t, true)
		keyPath := filepath.Join(e.dir, dirSecret, keyFile)
		if err := os.Remove(keyPath); err != nil {
			t.Fatal(err)
		}
		prior := platform.TakeoverReport{Removed: []string{keyPath}}
		e.mod = func(o *Options) {
			takeoverSeam("", nil)(o)
			o.Takeover = prior
		}
		s, rep := e.open()
		e.mod = nil
		checkUntrustedKey(t, e, s, rep, oldKey, keyPath)
		if len(prior.Removed) != 1 || prior.MovedAside != nil {
			t.Fatalf("the caller's report was modified: %+v", prior)
		}
	})

	// In a fresh directory the new epoch is install anyway.
	t.Run("fresh", func(t *testing.T) {
		e := newEnv(t)
		keyPath := filepath.Join(e.dir, dirSecret, keyFile)
		e.mod = takeoverSeam(e.dir, func() platform.TakeoverReport {
			return platform.TakeoverReport{Removed: []string{keyPath}}
		})
		_, rep := e.open()
		e.mod = nil
		if !rep.Fresh || !rep.KeyReplaced || rep.KeyCreated || rep.NeedEpoch != EpochInstall || len(e.key()) != keySize {
			t.Fatalf("report %+v", rep)
		}
	})
}

// An untrusted data directory (or secret/) is moved aside and created again before
// loadKey looks. When earlier data exists (an anchor, or a log outside secret/) the key
// it was signed with lived in a tree that is never adopted: untrusted_key. In a fresh
// directory it is a pre-created folder: install.
func TestTakeoverMovedAsideTree(t *testing.T) {
	t.Run("data dir with anchor", func(t *testing.T) {
		e, oldKey := takeoverEnv(t, true)
		aside := e.dir + ".untrusted-1790000000"
		e.mod = takeoverSeam(e.dir, func() platform.TakeoverReport {
			if err := os.Rename(e.dir, aside); err != nil {
				t.Fatal(err)
			}
			return platform.TakeoverReport{MovedAside: []string{aside}}
		})
		s, rep := e.open()
		e.mod = nil
		if !hasWarning(rep, "moved aside to "+aside) || rep.Anchor == nil {
			t.Fatalf("report %+v", rep)
		}
		checkUntrustedKey(t, e, s, rep, oldKey, e.dir+" was not trusted and was moved aside to "+aside)
		if got := readFileT(t, filepath.Join(aside, dirSecret, keyFile)); !bytes.Equal(got, oldKey) {
			t.Fatal("the tree moved aside was modified")
		}
	})

	t.Run("secret dir with log", func(t *testing.T) {
		e, oldKey := takeoverEnv(t, false)
		secretDir := filepath.Join(e.dir, dirSecret)
		aside := secretDir + ".untrusted-1790000000-1"
		e.mod = takeoverSeam(secretDir, func() platform.TakeoverReport {
			if err := os.Rename(secretDir, aside); err != nil {
				t.Fatal(err)
			}
			return platform.TakeoverReport{MovedAside: []string{aside}}
		})
		s, rep := e.open()
		e.mod = nil
		checkUntrustedKey(t, e, s, rep, oldKey, "moved aside to "+aside)
	})

	t.Run("fresh", func(t *testing.T) {
		e, _ := takeoverEnv(t, false)
		aside := e.dir + ".untrusted-1790000000"
		e.mod = takeoverSeam(e.dir, func() platform.TakeoverReport {
			if err := os.Rename(e.dir, aside); err != nil {
				t.Fatal(err)
			}
			return platform.TakeoverReport{MovedAside: []string{aside}}
		})
		_, rep := e.open()
		e.mod = nil
		if !rep.Fresh || rep.KeyReplaced || !rep.KeyCreated || rep.NeedEpoch != EpochInstall ||
			!hasWarning(rep, "moved aside to "+aside) {
			t.Fatalf("report %+v", rep)
		}
	})
}

// Anything else the takeover moved or deleted leaves a good key alone.
func TestTakeoverOtherEntriesKeepKey(t *testing.T) {
	e, oldKey := takeoverEnv(t, true)
	other := platform.TakeoverReport{
		MovedAside: []string{
			filepath.Join(e.dir, dirEvents, "other.untrusted-1790000000"),
			e.dir + "x.untrusted-1790000000",
			filepath.Join(e.dir, dirSecret, keyFile) + ".untrusted-1790000000",
			"untrusted-1790000000",
		},
		Removed: []string{
			filepath.Join(e.dir, dirRun, plannedMarker),
			filepath.Join(e.dir, dirSecret, keyFile+"x"),
			filepath.Join(e.dir, dirSecret, "rules.key"),
			e.dir + "x",
		},
	}
	e.mod = func(o *Options) {
		takeoverSeam("", nil)(o)
		o.Takeover = other
	}
	_, rep := e.open()
	e.mod = nil
	if rep.KeyReplaced || rep.KeyCreated || rep.KeyProblem != "" || rep.NeedEpoch != "" || rep.LastSeq != 2 ||
		!bytes.Equal(e.key(), oldKey) || len(rep.Warnings) != len(other.MovedAside)+len(other.Removed) {
		t.Fatalf("report %+v", rep)
	}
}
