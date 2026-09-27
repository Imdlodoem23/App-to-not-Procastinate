package hosts

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// tempFiles lists our temporary files left in dir.
func tempFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), tempPrefix) {
			out = append(out, e.Name())
		}
	}
	return out
}

func TestLockedRenameRetriesThenWritesInPlace(t *testing.T) {
	m, path := newManager(t, []byte(windowsDefaultHosts))
	var sleeps []time.Duration
	m.sleep = func(d time.Duration) { sleeps = append(sleeps, d) }
	renames := 0
	m.rename = func(src, dst string) error { renames++; return errLocked }
	inPlace := 0
	m.inPlace = func(p string, data []byte) error { inPlace++; return writeInPlace(p, data) }

	mustApply(t, m, "a.com")

	want := windowsDefaultHosts + "\r\n" + section("\r\n", "a.com")
	if got := readString(t, path); got != want {
		t.Fatalf("got %q", got)
	}
	if inPlace != 1 {
		t.Fatalf("in-place writes = %d, want 1", inPlace)
	}
	var total time.Duration
	for _, d := range sleeps {
		total += d
	}
	if total < lockRetryBudget || total > lockRetryBudget+maxBackoff {
		t.Fatalf("retried for %v (%v), want about %v", total, sleeps, lockRetryBudget)
	}
	if sleeps[0] != firstBackoff || sleeps[1] != 2*firstBackoff || slices.Max(sleeps) != maxBackoff {
		t.Fatalf("backoff sequence %v", sleeps)
	}
	if renames != len(sleeps)+1 {
		t.Fatalf("%d renames for %d sleeps", renames, len(sleeps))
	}
	if left := tempFiles(t, filepath.Dir(path)); len(left) != 0 {
		t.Fatalf("temporary files left behind: %v", left)
	}
}

func TestLockedRenameSucceedsOnRetry(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	var sleeps []time.Duration
	m.sleep = func(d time.Duration) { sleeps = append(sleeps, d) }
	fails := 2
	m.rename = func(src, dst string) error {
		if fails > 0 {
			fails--
			return &os.LinkError{Op: "rename", Old: src, New: dst, Err: errLocked}
		}
		return replaceFile(src, dst)
	}
	m.inPlace = func(string, []byte) error { t.Fatal("unexpected in-place write"); return nil }
	mustApply(t, m, "a.com")
	if !slices.Equal(sleeps, []time.Duration{firstBackoff, 2 * firstBackoff}) {
		t.Fatalf("sleeps = %v", sleeps)
	}
	if got := readString(t, path); got != linuxHosts+"\n"+section("\n", "a.com") {
		t.Fatalf("got %q", got)
	}
}

func TestInPlaceRetriesWhileLocked(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	m.sleep = func(time.Duration) {}
	m.rename = func(string, string) error { return errLocked }
	attempts := 0
	m.inPlace = func(p string, data []byte) error {
		attempts++
		if attempts < inPlaceAttempts {
			return errLocked
		}
		return writeInPlace(p, data)
	}
	mustApply(t, m, "a.com")
	if attempts != inPlaceAttempts {
		t.Fatalf("in-place attempts = %d", attempts)
	}

	// Still locked after every attempt: the error is returned and the file
	// is left as it was.
	m.inPlace = func(string, []byte) error { return errLocked }
	before := readString(t, path)
	if err := m.Apply([]string{"b.com"}); !errors.Is(err, errLocked) {
		t.Fatalf("Apply = %v, want errLocked", err)
	}
	if got := readString(t, path); got != before {
		t.Fatal("file changed after a failed write")
	}
	if cur, _ := m.Current(); !slices.Equal(cur, []string{"a.com"}) {
		t.Fatalf("Current = %v", cur)
	}
}

func TestOtherRenameErrorsDoNotFallBack(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	m.sleep = func(time.Duration) { t.Fatal("unexpected retry") }
	boom := errors.New("boom")
	m.rename = func(string, string) error { return boom }
	m.inPlace = func(string, []byte) error { t.Fatal("unexpected in-place write"); return nil }
	if err := m.Apply([]string{"a.com"}); !errors.Is(err, boom) {
		t.Fatalf("Apply = %v", err)
	}
	if got := readString(t, path); got != linuxHosts {
		t.Fatal("file changed")
	}
	if left := tempFiles(t, filepath.Dir(path)); len(left) != 0 {
		t.Fatalf("temporary files left behind: %v", left)
	}
}

func TestWriteInPlaceShrinksAndGrows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hosts")
	for _, content := range []string{"a long first version\n", "short\n", "", "grown again, longer than before\n"} {
		if err := writeInPlace(path, []byte(content)); err != nil {
			t.Fatal(err)
		}
		if got := readString(t, path); got != content {
			t.Fatalf("got %q, want %q", got, content)
		}
	}
}

func TestStaleTempFilesRemoved(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	dir := filepath.Dir(path)
	stale := filepath.Join(dir, tempPrefix+"123"+tempSuffix)
	other := filepath.Join(dir, "hosts.custom.tmp")
	for _, p := range []string{stale, other} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	mustApply(t, m, "a.com")
	if _, err := os.Stat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale temporary file kept: %v", err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("unrelated file removed: %v", err)
	}
}

func TestConcurrentApplySerialized(t *testing.T) {
	m, path := newManager(t, []byte(windowsDefaultHosts))
	var inFlight, overlaps, writes atomic.Int32
	m.rename = func(src, dst string) error {
		if inFlight.Add(1) > 1 {
			overlaps.Add(1)
		}
		defer inFlight.Add(-1)
		writes.Add(1)
		time.Sleep(time.Millisecond)
		return replaceFile(src, dst)
	}
	sets := make([][]string, 16)
	for i := range sets {
		sets[i] = []string{fmt.Sprintf("site%d.com", i), fmt.Sprintf("www.site%d.com", i)}
	}
	var wg sync.WaitGroup
	for _, set := range sets {
		wg.Add(2)
		go func() { defer wg.Done(); mustApplyNoFatal(t, m, set) }()
		go func() { defer wg.Done(); _, _ = m.Verify(set) }()
	}
	wg.Wait()

	if overlaps.Load() != 0 {
		t.Fatalf("%d overlapping writes", overlaps.Load())
	}
	got := readString(t, path)
	if strings.Count(got, StartMarker) != 1 || strings.Count(got, EndMarker) != 1 {
		t.Fatalf("not exactly one section:\n%s", got)
	}
	if !strings.HasPrefix(got, windowsDefaultHosts) {
		t.Fatal("user lines changed")
	}
	cur, err := m.Current()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, set := range sets {
		if slices.Equal(cur, set) {
			found = true
		}
	}
	if !found {
		t.Fatalf("final section %v is not one of the applied sets", cur)
	}
	if left := tempFiles(t, filepath.Dir(path)); len(left) != 0 {
		t.Fatalf("temporary files left behind: %v", left)
	}
}

func mustApplyNoFatal(t *testing.T, m *Manager, domains []string) {
	if err := m.Apply(domains); err != nil {
		t.Errorf("Apply(%v): %v", domains, err)
	}
}
