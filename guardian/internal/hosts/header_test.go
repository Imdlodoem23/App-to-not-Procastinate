package hosts

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

var until0 = time.Date(2026, time.September, 27, 17, 42, 0, 0, time.UTC)

// sectionUntil renders the expected section with the header line.
func sectionUntil(eol string, until time.Time, domains ...string) string {
	var b strings.Builder
	b.WriteString(StartMarker + eol + Header + eol)
	b.WriteString(FormatSectionHeader(until, len(domains)) + eol)
	for _, d := range domains {
		b.WriteString("0.0.0.0 " + d + eol + ":: " + d + eol)
	}
	b.WriteString(EndMarker + eol)
	return b.String()
}

func TestFormatSectionHeader(t *testing.T) {
	if got := FormatSectionHeader(until0, 68); got != "# centrate-hosts v1 until=2026-09-27T17:42:00Z count=68" {
		t.Fatalf("got %q", got)
	}
	madrid := time.FixedZone("CEST", 2*3600)
	withMs := time.Date(2026, 9, 27, 19, 42, 0, 123_456_789, madrid)
	if got := FormatSectionHeader(withMs, 1); got != "# centrate-hosts v1 until=2026-09-27T17:42:00.123Z count=1" {
		t.Fatalf("got %q", got)
	}
	if got := FormatSectionHeader(until0, -3); !strings.HasSuffix(got, " count=0") {
		t.Fatalf("negative count: %q", got)
	}
}

func TestParseSectionHeader(t *testing.T) {
	good := map[string]struct {
		until time.Time
		count int
	}{
		"# centrate-hosts v1 until=2026-09-27T17:42:00Z count=68":            {until0, 68},
		"  # centrate-hosts v1 until=2026-09-27T17:42:00.5Z count=0  ":       {until0.Add(500 * time.Millisecond), 0},
		"# centrate-hosts v1 count=3 until=2026-09-27T17:42:00Z":             {until0, 3},
		"# centrate-hosts v1 until=2026-09-27T17:42:00Z count=3 future=x":    {until0, 3},
		"# centrate-hosts v1 until=2026-09-27T17:42:00Z count=100000":        {until0, 100000},
		"# centrate-hosts v1 until=2026-09-27T17:42:00.123456789Z count=1":   {until0.Add(123456789), 1},
		"# centrate-hosts v1  until=2026-09-27T17:42:00Z\tcount=2":           {until0, 2},
		"# centrate-hosts v1 until=2026-09-27T17:42:00Z count=2 until2=late": {until0, 2},
	}
	for line, want := range good {
		u, n, ok := ParseSectionHeader(line)
		if !ok || !u.Equal(want.until) || n != want.count || u.Location() != time.UTC {
			t.Errorf("ParseSectionHeader(%q) = %v, %d, %v", line, u, n, ok)
		}
	}
	for _, line := range []string{
		"",
		"# centrate-hosts v2 until=2026-09-27T17:42:00Z count=1",
		"# centrate-hosts v1",
		"# centrate-hosts v1 until=2026-09-27T17:42:00Z",
		"# centrate-hosts v1 count=1",
		"# centrate-hosts v1 until=2026-09-27T19:42:00+02:00 count=1",
		"# centrate-hosts v1 until=2026-09-27 count=1",
		"# centrate-hosts v1 until=2026-09-27T17:42:00Z count=01",
		"# centrate-hosts v1 until=2026-09-27T17:42:00Z count=-1",
		"# centrate-hosts v1 until=2026-09-27T17:42:00Z count=100001",
		"# centrate-hosts v1 until=2026-09-27T17:42:00Z count=1 count=2",
		"# centrate-hosts v1 until=2026-09-27T17:42:00Z until=2026-09-27T17:42:00Z count=1",
		"# centrate-hosts v1 until=2026-09-27T17:42:00Z count=1 junk",
		"# centrate-hosts v1 until=2026-09-27T17:42:00Z count=1 =x",
		"#centrate-hosts v1 until=2026-09-27T17:42:00Z count=1",
		"# centrate-hostsv1 until=2026-09-27T17:42:00Z count=1",
	} {
		if u, n, ok := ParseSectionHeader(line); ok {
			t.Errorf("ParseSectionHeader(%q) accepted: %v %d", line, u, n)
		}
	}
}

func FuzzParseSectionHeader(f *testing.F) {
	f.Add(FormatSectionHeader(until0, 68))
	f.Add("# centrate-hosts v1 count=1 until=2026-09-27T17:42:00.5Z x=y")
	f.Fuzz(func(t *testing.T, line string) {
		u, n, ok := ParseSectionHeader(line)
		if !ok {
			return
		}
		if n < 0 || n > MaxDomains || u.Location() != time.UTC {
			t.Fatalf("accepted %q: %v %d", line, u, n)
		}
		// Whatever was accepted formats to a line that parses back the same.
		u2, n2, ok2 := ParseSectionHeader(FormatSectionHeader(u, n))
		if !ok2 || n2 != n || !u2.Equal(u.Truncate(time.Millisecond)) {
			t.Fatalf("round trip of %q: %v %d %v", line, u2, n2, ok2)
		}
	})
}

func TestApplyUntilWritesHeaderLine(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	if err := m.ApplyUntil([]string{"b.com", "A.com"}, until0); err != nil {
		t.Fatal(err)
	}
	want := linuxHosts + "\n" + sectionUntil("\n", until0, "a.com", "b.com")
	if got := readString(t, path); got != want {
		t.Fatalf("file:\n%s\nwant:\n%s", got, want)
	}
	domains, until, ok, err := m.Section()
	if err != nil || !ok || !until.Equal(until0) || !slices.Equal(domains, []string{"a.com", "b.com"}) {
		t.Fatalf("Section = %v, %v, %v, %v", domains, until, ok, err)
	}
	info, err := m.SectionInfo()
	if err != nil || !info.Present || !info.Consistent() || info.Count != 2 {
		t.Fatalf("SectionInfo = %+v, %v", info, err)
	}
	if cur, _ := m.Current(); !slices.Equal(cur, []string{"a.com", "b.com"}) {
		t.Fatalf("Current = %v", cur)
	}
	// Verify keeps the until the file has; VerifyUntil wants the given one.
	for _, c := range []struct {
		name string
		fn   func() (bool, error)
		want bool
	}{
		{"Verify same", func() (bool, error) { return m.Verify([]string{"a.com", "b.com"}) }, true},
		{"Verify other", func() (bool, error) { return m.Verify([]string{"a.com"}) }, false},
		{"VerifyUntil same", func() (bool, error) { return m.VerifyUntil([]string{"a.com", "b.com"}, until0) }, true},
		{"VerifyUntil later", func() (bool, error) { return m.VerifyUntil([]string{"a.com", "b.com"}, until0.Add(time.Minute)) }, false},
		{"VerifyUntil none", func() (bool, error) { return m.VerifyUntil([]string{"a.com", "b.com"}, time.Time{}) }, false},
	} {
		if got, err := c.fn(); err != nil || got != c.want {
			t.Errorf("%s = %v, %v", c.name, got, err)
		}
	}
	// A later until rewrites only the header line.
	later := until0.Add(30 * time.Minute)
	if err := m.ApplyUntil([]string{"a.com", "b.com"}, later); err != nil {
		t.Fatal(err)
	}
	if got := readString(t, path); got != linuxHosts+"\n"+sectionUntil("\n", later, "a.com", "b.com") {
		t.Fatalf("after a later until:\n%s", got)
	}
	// Apply without until drops the header line; Remove restores the file.
	mustApply(t, m, "a.com")
	if got := readString(t, path); got != linuxHosts+"\n"+section("\n", "a.com") {
		t.Fatalf("after Apply:\n%s", got)
	}
	if _, _, ok, _ := m.Section(); ok {
		t.Fatal("no header line: Section ok must be false")
	}
	if err := m.ApplyUntil(nil, until0); err != nil {
		t.Fatal(err)
	}
	if got := readString(t, path); got != linuxHosts {
		t.Fatalf("an empty list removes the section:\n%q", got)
	}
	if _, _, ok, err := m.Section(); ok || err != nil {
		t.Fatalf("no section: ok = %v, err = %v", ok, err)
	}
}

func TestApplyUntilCRLFAndIdempotent(t *testing.T) {
	m, path := newManager(t, []byte(windowsDefaultHosts))
	for range 2 {
		if err := m.ApplyUntil([]string{"x.com"}, until0); err != nil {
			t.Fatal(err)
		}
	}
	want := windowsDefaultHosts + "\r\n" + sectionUntil("\r\n", until0, "x.com")
	if got := readString(t, path); got != want {
		t.Fatalf("file:\n%q\nwant\n%q", got, want)
	}
	fi1, _ := os.Stat(path)
	time.Sleep(10 * time.Millisecond)
	if err := m.ApplyUntil([]string{"x.com"}, until0); err != nil {
		t.Fatal(err)
	}
	if fi2, _ := os.Stat(path); !fi2.ModTime().Equal(fi1.ModTime()) {
		t.Fatal("an identical ApplyUntil must not write")
	}
	mustRemove(t, m)
	if got := readString(t, path); got != windowsDefaultHosts {
		t.Fatal("Remove must give back the original bytes")
	}
}

// Someone deleting entries by hand leaves a header whose count no longer
// matches: Verify fails and the section is repaired.
func TestHeaderCountMismatchIsNotVerified(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	if err := m.ApplyUntil([]string{"a.com", "b.com"}, until0); err != nil {
		t.Fatal(err)
	}
	edited := strings.Replace(readString(t, path), "0.0.0.0 b.com\n:: b.com\n", "", 1)
	if err := os.WriteFile(path, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}
	info, _ := m.SectionInfo()
	if info.Consistent() || info.Count != 2 || len(info.Domains) != 1 {
		t.Fatalf("SectionInfo = %+v", info)
	}
	if ok, _ := m.Verify([]string{"a.com"}); ok {
		t.Fatal("a stale count must not verify")
	}
	if ok, _ := m.Verify([]string{"a.com", "b.com"}); ok {
		t.Fatal("missing entries must not verify")
	}
}

func TestStrayMarkersClaimTheHeaderLine(t *testing.T) {
	meta := FormatSectionHeader(until0, 1) + "\n"
	cases := []struct{ name, in, applied string }{
		{
			name:    "start without end",
			in:      "a.lan\n\n" + StartMarker + "\n" + Header + "\n" + meta + "0.0.0.0 old.com\n:: old.com\nb.lan\n",
			applied: "a.lan\n\n" + section("\n", "new.com") + "b.lan\n",
		},
		{
			name:    "start without end, header line only",
			in:      "a.lan\n\n" + StartMarker + "\n" + meta + "0.0.0.0 old.com\n:: old.com\n",
			applied: "a.lan\n\n" + section("\n", "new.com"),
		},
		{
			name:    "end without start below the header and header line",
			in:      "a.lan\n" + Header + "\n" + meta + "0.0.0.0 old.com\n:: old.com\n" + EndMarker + "\nb.lan\n",
			applied: "a.lan\n" + section("\n", "new.com") + "b.lan\n",
		},
		{
			name:    "end without start below the header line alone",
			in:      "a.lan\n" + meta + "0.0.0.0 old.com\n:: old.com\n" + EndMarker + "\n",
			applied: "a.lan\n" + section("\n", "new.com"),
		},
		{
			name:    "a header line that is not ours exactly stays",
			in:      "a.lan\n# centrate-hosts v1 count=1 until=2026-09-27T17:42:00Z\n0.0.0.0 old.com\n:: old.com\n" + EndMarker + "\n",
			applied: "a.lan\n# centrate-hosts v1 count=1 until=2026-09-27T17:42:00Z\n0.0.0.0 old.com\n:: old.com\n" + section("\n", "new.com"),
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, path := newManager(t, []byte(c.in))
			mustApply(t, m, "new.com")
			if got := readString(t, path); got != c.applied {
				t.Fatalf("applied:\n%s\nwant:\n%s", got, c.applied)
			}
		})
	}
	// Inside a well-formed section the first valid header line wins.
	m, _ := newManager(t, []byte(StartMarker+"\n"+Header+"\n# centrate-hosts v1 bad\n"+meta+FormatSectionHeader(until0.Add(time.Hour), 1)+"\n0.0.0.0 a.com\n:: a.com\n"+EndMarker+"\n"))
	if _, until, ok, err := m.Section(); err != nil || !ok || !until.Equal(until0) {
		t.Fatalf("Section until = %v, %v, %v", until, ok, err)
	}
}

func TestSectionHash(t *testing.T) {
	engineHash := func(domains []string) string { // engine.hashDomains
		s := slices.Clone(domains)
		slices.Sort(s)
		s = slices.Compact(s)
		sum := sha256.Sum256([]byte(strings.Join(s, "\n")))
		return hex.EncodeToString(sum[:])
	}
	a := []string{"b.com", "a.com", "b.com"}
	if SectionHash(a) != engineHash([]string{"a.com", "b.com"}) {
		t.Fatal("SectionHash must match the engine's persisted hash")
	}
	if SectionHash([]string{"A.com", "b.com"}) != SectionHash([]string{"b.com", "a.com"}) {
		t.Fatal("case and order must not matter")
	}
	if SectionHash(nil) != SectionHash([]string{}) || SectionHash(nil) == SectionHash([]string{"a.com"}) {
		t.Fatal("empty list")
	}

	m, path := newManager(t, []byte(linuxHosts))
	if _, ok := m.LastSectionHash(); ok {
		t.Fatal("no write yet")
	}
	if err := m.ApplyUntil([]string{"b.com", "a.com"}, until0); err != nil {
		t.Fatal(err)
	}
	last, ok := m.LastSectionHash()
	cur, err := m.CurrentSectionHash()
	if !ok || err != nil || last != cur || last != SectionHash([]string{"a.com", "b.com"}) {
		t.Fatalf("last %q, current %q, %v", last, cur, err)
	}
	// Changed while "stopped": the current hash no longer matches.
	if err := os.WriteFile(path, []byte(strings.Replace(readString(t, path), "0.0.0.0 b.com\n:: b.com\n", "", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	m2 := &Manager{Path: path, BackupDir: m.BackupDir}
	if cur, _ := m2.CurrentSectionHash(); cur == last {
		t.Fatal("an edited section must hash differently")
	}
	mustRemove(t, m2)
	if last, ok := m2.LastSectionHash(); !ok || last != SectionHash(nil) {
		t.Fatalf("after Remove: %q, %v", last, ok)
	}
}

func TestPrioritize(t *testing.T) {
	groups := [][]string{
		{"z-punishment.com", "a-punishment.com"},
		{"m-exam.com", "Z-PUNISHMENT.com"},
		{"b-normal.com", "c-normal.com"},
	}
	kept, dropped, err := Prioritize(groups, 4)
	if err != nil || dropped != 1 || !slices.Equal(kept, []string{"a-punishment.com", "b-normal.com", "m-exam.com", "z-punishment.com"}) {
		t.Fatalf("got %v, %d, %v", kept, dropped, err)
	}
	kept, dropped, err = Prioritize(groups, 2)
	if err != nil || dropped != 3 || !slices.Equal(kept, []string{"a-punishment.com", "z-punishment.com"}) {
		t.Fatalf("limit 2: %v, %d, %v", kept, dropped, err)
	}
	if kept, dropped, _ := Prioritize(groups, 0); len(kept) != 0 || dropped != 5 {
		t.Fatalf("limit 0: %v, %d", kept, dropped)
	}
	if kept, dropped, _ := Prioritize(groups, -1); len(kept) != 0 || dropped != 5 {
		t.Fatalf("limit -1: %v, %d", kept, dropped)
	}
	if kept, dropped, _ := Prioritize(nil, 10); kept == nil || len(kept) != 0 || dropped != 0 {
		t.Fatalf("nothing: %v, %d", kept, dropped)
	}
	_, _, err = Prioritize([][]string{{"a.com"}, {"b.com", "*.bad.com"}}, 10)
	var inv *InvalidDomainError
	if !errors.As(err, &inv) || inv.Index != 2 || strings.Contains(err.Error(), "bad.com") {
		t.Fatalf("invalid domain: %v", err)
	}
}

func TestSectionBudgetComesFromContract(t *testing.T) {
	if SectionBudget() != embedded.API().Limits.HostsMaxDomains || SectionBudget() <= 0 || SectionBudget() > MaxDomains {
		t.Fatalf("SectionBudget = %d", SectionBudget())
	}
}

// Over the budget, Apply refuses (never an alphabetical cut) and
// ApplyPrioritized drops the lowest-priority entries.
func TestBudgetIsEnforcedByPriority(t *testing.T) {
	budget := SectionBudget()
	var high, low []string
	for i := range budget {
		high = append(high, fmt.Sprintf("z%06d.example.com", i)) // sorts last
	}
	for i := range 3 {
		low = append(low, fmt.Sprintf("a%06d.example.com", i)) // sorts first
	}
	m, path := newManager(t, []byte(linuxHosts))
	if err := m.ApplyUntil(append(slices.Clone(high), low...), until0); !errors.Is(err, ErrOverBudget) {
		t.Fatalf("over budget: err = %v", err)
	}
	if got := readString(t, path); got != linuxHosts {
		t.Fatal("nothing may be written over budget")
	}
	dropped, err := m.ApplyPrioritized([][]string{high, low}, until0)
	if err != nil || dropped != len(low) {
		t.Fatalf("ApplyPrioritized = %d, %v", dropped, err)
	}
	info, err := m.SectionInfo()
	if err != nil || len(info.Domains) != budget || !info.Consistent() {
		t.Fatalf("section: %d domains, %+v", len(info.Domains), err)
	}
	if slices.Contains(info.Domains, low[0]) || !slices.Contains(info.Domains, high[0]) {
		t.Fatal("the low-priority group must be the one dropped")
	}
	if _, err := m.ApplyPrioritized([][]string{{"ok.com", "bad domain"}}, until0); err == nil {
		t.Fatal("invalid domain accepted")
	}
}

func TestOriginalWrittenOnceWithoutSection(t *testing.T) {
	start := linuxHosts + "\n" + section("\n", "left.over")
	m, path := newManager(t, []byte(start))
	if _, err := os.Stat(m.OriginalPath()); !os.IsNotExist(err) {
		t.Fatal("no original before the first read")
	}
	mustApply(t, m, "a.com")
	if got := readString(t, m.OriginalPath()); got != linuxHosts {
		t.Fatalf("original = %q, want the file without the section", got)
	}
	// Later user edits, applies and new processes never overwrite it.
	if err := os.WriteFile(path, []byte("10.0.0.9 nas.lan\n"+readString(t, path)), 0o644); err != nil {
		t.Fatal(err)
	}
	mustApply(t, m, "b.com")
	m2 := &Manager{Path: path, BackupDir: m.BackupDir}
	if _, err := m2.Recover(); err != nil {
		t.Fatal(err)
	}
	mustApply(t, m2, "c.com")
	if got := readString(t, m.OriginalPath()); got != linuxHosts {
		t.Fatalf("original overwritten: %q", got)
	}
	// RestoreOriginal writes it back (without any section).
	if err := m2.RestoreOriginal(); err != nil {
		t.Fatal(err)
	}
	if got := readString(t, path); got != linuxHosts {
		t.Fatalf("restored %q", got)
	}
	if err := m2.RestoreOriginal(); err != nil { // already equal: no write
		t.Fatal(err)
	}
}

func TestOriginalWrittenByRecover(t *testing.T) {
	m, _ := newManager(t, []byte(windowsDefaultHosts))
	if _, err := m.Recover(); err != nil {
		t.Fatal(err)
	}
	if got := readString(t, m.OriginalPath()); got != windowsDefaultHosts {
		t.Fatalf("original = %q", got)
	}
	// A missing file writes no original (nothing was seen yet).
	m2, _ := newManager(t, nil)
	mustApply(t, m2, "a.com")
	if _, err := os.Stat(m2.OriginalPath()); !os.IsNotExist(err) {
		t.Fatalf("original of a missing file: %v", err)
	}
	// Without a BackupDir there is no original and RestoreOriginal fails.
	m3 := &Manager{Path: filepath.Join(t.TempDir(), "hosts")}
	if err := m3.RestoreOriginal(); !errors.Is(err, ErrNoBackup) {
		t.Fatalf("RestoreOriginal without backups: %v", err)
	}
	if err := (&Manager{}).RestoreOriginal(); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("invalid path: %v", err)
	}
}

// With every rotating backup gone, a file torn by a crash is restored from
// hosts.original.
func TestRecoverFallsBackToOriginal(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	mustApply(t, m, "a.com")
	for i := range BackupKeep {
		_ = os.Remove(m.BackupPath(i))
	}
	if err := os.WriteFile(path, make([]byte, 64), 0o644); err != nil { // zero-filled
		t.Fatal(err)
	}
	m2 := &Manager{Path: path, BackupDir: m.BackupDir}
	restored, err := m2.Recover()
	if err != nil || !restored {
		t.Fatalf("Recover = %v, %v", restored, err)
	}
	if got := readString(t, path); got != linuxHosts {
		t.Fatalf("restored %q", got)
	}
}

func TestResolveFollowsPathChanges(t *testing.T) {
	dir := t.TempDir()
	a, b := filepath.Join(dir, "a", "hosts"), filepath.Join(dir, "b", "hosts")
	for _, p := range []string{a, b} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(linuxHosts), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var mu sync.Mutex
	current, calls := a, 0
	now := time.Unix(1_800_000_000, 0)
	m := &Manager{
		Path:      "/ignored/when/resolving",
		BackupDir: filepath.Join(dir, "backup"),
		Resolve: func() string {
			mu.Lock()
			defer mu.Unlock()
			calls++
			return current
		},
		now: func() time.Time {
			mu.Lock()
			defer mu.Unlock()
			return now
		},
	}
	set := func(p string, advance time.Duration) {
		mu.Lock()
		current = p
		now = now.Add(advance)
		mu.Unlock()
	}
	mustApply(t, m, "a.com")
	if got := readString(t, a); got != linuxHosts+"\n"+section("\n", "a.com") || m.CurrentPath() != a {
		t.Fatalf("a = %q", got)
	}
	set(b, DefaultResolveEvery-time.Second) // not re-read yet
	mustApply(t, m, "a.com", "b.com")
	if got := readString(t, b); got != linuxHosts {
		t.Fatal("the path must be re-read only every ResolveEvery")
	}
	set(b, time.Second)
	w := &watcher{m: m}
	w.init()
	if !w.poll() {
		t.Fatal("the watcher must report the move to a file without our section")
	}
	mustApply(t, m, "a.com", "b.com")
	if got := readString(t, b); got != linuxHosts+"\n"+section("\n", "a.com", "b.com") || m.CurrentPath() != b {
		t.Fatalf("b = %q", got)
	}
	if got := readString(t, a); got != linuxHosts+"\n"+section("\n", "a.com", "b.com") {
		t.Fatalf("the old file is left as it was: %q", got)
	}
	if w.poll() {
		t.Fatal("our own write is not a change")
	}
	mu.Lock()
	n := calls
	mu.Unlock()
	if n != 2 {
		t.Fatalf("Resolve called %d times, want 2", n)
	}
	// An invalid resolved path fails every operation.
	set("relative/hosts", DefaultResolveEvery)
	if err := m.Apply([]string{"a.com"}); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("relative resolved path: %v", err)
	}
}

// FuzzRoundTripUntil is FuzzRoundTrip with the header line: rendering is
// idempotent, the header line reads back, and removing the section from the
// applied file gives what Remove gives on the original.
func FuzzRoundTripUntil(f *testing.F) {
	meta := FormatSectionHeader(until0, 1)
	for _, seed := range []string{
		"", linuxHosts, windowsDefaultHosts, "x\r", "\xEF\xBB\xBF",
		meta + "\n",
		"a\n" + StartMarker + "\n" + Header + "\n" + meta + "\n0.0.0.0 x.com\n:: x.com\nb\n",
		"a\n" + meta + "\n0.0.0.0 x.com\n:: x.com\n" + EndMarker + "\r\nb",
		sectionUntil("\r\n", until0, "x.com") + sectionUntil("\n", until0, "y.com") + EndMarker,
	} {
		f.Add([]byte(seed))
	}
	domains := []string{"a.com", "b.org"}
	until := until0.Add(1500 * time.Millisecond)
	f.Fuzz(func(t *testing.T, data []byte) {
		doc, err := parseDocument(data)
		if err != nil {
			return
		}
		applied := doc.render(domains, until)
		doc2, err := parseDocument(applied)
		if err != nil {
			t.Fatalf("rendered file does not parse: %v", err)
		}
		if again := doc2.render(domains, until); !bytes.Equal(again, applied) {
			t.Fatalf("render not idempotent:\n%q\n%q", applied, again)
		}
		info := doc2.sectionInfo()
		if !info.Present || !info.Consistent() || !info.Until.Equal(until) || !slices.Equal(info.Domains, domains) {
			t.Fatalf("section info = %+v", info)
		}
		if removed, want := doc2.render(nil, time.Time{}), doc.render(nil, time.Time{}); !bytes.Equal(removed, want) {
			t.Fatalf("Remove after ApplyUntil differs from Remove:\n got %q\nwant %q", removed, want)
		}
	})
}
