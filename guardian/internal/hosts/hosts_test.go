package hosts

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// windowsDefaultHosts is the stock Windows 10/11 hosts file (CRLF).
const windowsDefaultHosts = "# Copyright (c) 1993-2009 Microsoft Corp.\r\n" +
	"#\r\n" +
	"# This is a sample HOSTS file used by Microsoft TCP/IP for Windows.\r\n" +
	"#\r\n" +
	"# This file contains the mappings of IP addresses to host names. Each\r\n" +
	"# entry should be kept on an individual line. The IP address should\r\n" +
	"# be placed in the first column followed by the corresponding host name.\r\n" +
	"# The IP address and the host name should be separated by at least one\r\n" +
	"# space.\r\n" +
	"#\r\n" +
	"# Additionally, comments (such as these) may be inserted on individual\r\n" +
	"# lines or following the machine name denoted by a '#' symbol.\r\n" +
	"#\r\n" +
	"# For example:\r\n" +
	"#\r\n" +
	"#      102.54.94.97     rhino.acme.com          # source server\r\n" +
	"#       38.25.63.10     x.acme.com              # x client host\r\n" +
	"\r\n" +
	"# localhost name resolution is handled within DNS itself.\r\n" +
	"#\t127.0.0.1       localhost\r\n" +
	"#\t::1             localhost\r\n"

const linuxHosts = "127.0.0.1\tlocalhost\n127.0.1.1\tmybox\n\n# IPv6\n::1     ip6-localhost ip6-loopback\n"

// section renders the expected Céntrate section with eol after every line.
func section(eol string, domains ...string) string {
	var b strings.Builder
	b.WriteString(StartMarker + eol + Header + eol)
	for _, d := range domains {
		b.WriteString("0.0.0.0 " + d + eol + ":: " + d + eol)
	}
	b.WriteString(EndMarker + eol)
	return b.String()
}

// newManager writes content (nil: no file) to a hosts file in a temporary
// directory and returns a Manager for it.
func newManager(t *testing.T, content []byte) (*Manager, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "hosts")
	if content != nil {
		if err := os.WriteFile(path, content, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return &Manager{Path: path, BackupDir: filepath.Join(dir, "backup")}, path
}

func readString(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func mustApply(t *testing.T, m *Manager, domains ...string) {
	t.Helper()
	if err := m.Apply(domains); err != nil {
		t.Fatalf("Apply(%v): %v", domains, err)
	}
}

func mustRemove(t *testing.T, m *Manager) {
	t.Helper()
	if err := m.Remove(); err != nil {
		t.Fatalf("Remove: %v", err)
	}
}

func TestApplyEmptyFile(t *testing.T) {
	m, path := newManager(t, []byte{})
	mustApply(t, m, "b.com", "a.com")
	eol := string(defaultEOL())
	if got, want := readString(t, path), section(eol, "a.com", "b.com"); got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
	mustRemove(t, m)
	if got := readString(t, path); got != "" {
		t.Fatalf("after Remove got %q, want empty file", got)
	}
}

func TestApplyCreatesMissingFile(t *testing.T) {
	m, path := newManager(t, nil)
	if err := m.Remove(); err != nil {
		t.Fatalf("Remove on missing file: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Remove created the file: %v", err)
	}
	mustApply(t, m, "a.com")
	if got, want := readString(t, path), section(string(defaultEOL()), "a.com"); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestApplyWindowsCRLF(t *testing.T) {
	m, path := newManager(t, []byte(windowsDefaultHosts))
	mustApply(t, m, "youtube.com", "www.youtube.com")
	got := readString(t, path)
	want := windowsDefaultHosts + "\r\n" + section("\r\n", "www.youtube.com", "youtube.com")
	if got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
	if strings.Count(got, "\n") != strings.Count(got, "\r\n") {
		t.Fatal("a bare LF was written into a CRLF file")
	}
	mustRemove(t, m)
	if got := readString(t, path); got != windowsDefaultHosts {
		t.Fatalf("Remove did not restore the original:\n%q", got)
	}
}

func TestApplyKeepsBOM(t *testing.T) {
	orig := "\xEF\xBB\xBF127.0.0.1 localhost\r\n"
	m, path := newManager(t, []byte(orig))
	mustApply(t, m, "a.com")
	got := readString(t, path)
	want := orig + "\r\n" + section("\r\n", "a.com")
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if n := strings.Count(got, "\xEF\xBB\xBF"); n != 1 {
		t.Fatalf("%d BOMs in the file", n)
	}
	mustRemove(t, m)
	if got := readString(t, path); got != orig {
		t.Fatalf("after Remove got %q, want %q", got, orig)
	}
}

func TestApplyUpdatesExistingSection(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	mustApply(t, m, "a.com", "b.com")
	mustApply(t, m, "c.com")
	if got, want := readString(t, path), linuxHosts+"\n"+section("\n", "c.com"); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	// A section the user moved to the top is updated where it is.
	moved := section("\n", "old.com") + linuxHosts
	if err := os.WriteFile(path, []byte(moved), 0o644); err != nil {
		t.Fatal(err)
	}
	mustApply(t, m, "new.com")
	if got, want := readString(t, path), section("\n", "new.com")+linuxHosts; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestApplyEmptyListRemoves(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	mustApply(t, m, "a.com")
	mustApply(t, m)
	if got := readString(t, path); got != linuxHosts {
		t.Fatalf("got %q, want %q", got, linuxHosts)
	}
}

func TestRemoveRoundTrip(t *testing.T) {
	cases := map[string]string{
		"empty":            "",
		"lf":               linuxHosts,
		"crlf":             windowsDefaultHosts,
		"no final newline": "127.0.0.1 localhost",
		"crlf no newline":  "127.0.0.1 localhost\r\n::1 localhost",
		"trailing blank":   "127.0.0.1 localhost\n\n",
		"bom":              "\xEF\xBB\xBF127.0.0.1 localhost\n",
		"bom only":         "\xEF\xBB\xBF",
		"mixed endings":    "a.lan 1\r\nb\nc\r\n",
		"blank only":       "\n",
		"legacy encoding":  "# Configuraci\xF3n\r\n127.0.0.1 localhost\r\n",
		"whitespace lines": "  \t\n127.0.0.1 localhost\n \n",
	}
	for name, orig := range cases {
		t.Run(name, func(t *testing.T) {
			m, path := newManager(t, []byte(orig))
			mustApply(t, m, "a.com", "b.org")
			mustApply(t, m, "c.net") // update in place
			mustRemove(t, m)
			if got := readString(t, path); got != orig {
				t.Fatalf("round trip changed the file:\n got %q\nwant %q", got, orig)
			}
		})
	}
}

func TestApplyIdempotentNoWrite(t *testing.T) {
	m, path := newManager(t, []byte(windowsDefaultHosts))
	mustApply(t, m, "a.com", "b.com")
	old := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	writes := 0
	m.beforeWrite = func() { writes++ }

	mustApply(t, m, "B.COM", "a.com", "b.com") // same set, other order and case
	ok, err := m.Verify([]string{"a.com", "b.com"})
	if err != nil || !ok {
		t.Fatalf("Verify = %v, %v", ok, err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !fi.ModTime().Equal(old) || writes != 0 {
		t.Fatalf("idempotent Apply wrote the file (mtime %v, writes %d)", fi.ModTime(), writes)
	}

	mustRemove(t, m)
	mustRemove(t, m)
	if writes != 1 {
		t.Fatalf("two Removes wrote %d times, want 1", writes)
	}
}

func TestApplyRejectsInvalidDomains(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	for _, bad := range invalidDomains {
		err := m.Apply([]string{"ok.com", bad})
		var de *InvalidDomainError
		if !errors.As(err, &de) {
			t.Errorf("Apply(%q) = %v, want *InvalidDomainError", bad, err)
			continue
		}
		if de.Index != 1 || de.Domain != bad {
			t.Errorf("Apply(%q): error index %d domain %q", bad, de.Index, de.Domain)
		}
		if bad != "" && strings.Contains(de.Error(), bad) {
			t.Errorf("error message leaks the domain: %q", de.Error())
		}
	}
	if got := readString(t, path); got != linuxHosts {
		t.Fatalf("the file changed after rejected Apply calls: %q", got)
	}
	if _, err := os.Stat(m.BackupPath(0)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a rejected Apply took a backup: %v", err)
	}
}

func TestIPv6LinesPresent(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	domains := []string{"x.com", "www.x.com", "m.x.com"}
	mustApply(t, m, domains...)
	lines := strings.Split(readString(t, path), "\n")
	for _, d := range domains {
		i := slices.Index(lines, "0.0.0.0 "+d)
		if i < 0 || i+1 >= len(lines) || lines[i+1] != ":: "+d {
			t.Errorf("%s: missing IPv4 line followed by IPv6 line", d)
		}
	}
}

func TestUserLinesUntouchedByteForByte(t *testing.T) {
	// The lines right before and after the section look like ours on
	// purpose: with balanced markers they must never be claimed.
	before := "# Hosts\t with tabs and trailing spaces   \r\n" +
		"127.0.0.1\tlocalhost # comment\n" +
		"# caf\xE9 in a legacy code page\r\n" +
		"carriage\rreturn inside a line\n" +
		"0.0.0.0 user-own-block.com\n"
	after := "0.0.0.0 another-user-block.com\n" +
		"10.0.0.2   nas   \r\n" +
		"\t# indented comment\n" +
		"# last line without newline"
	orig := before + section("\n", "old.com") + after
	m, path := newManager(t, []byte(orig))
	mustApply(t, m, "new.com")
	got := readString(t, path)
	if !strings.HasPrefix(got, before) || !strings.HasSuffix(got, after) {
		t.Fatalf("user lines changed:\n%q", got)
	}
	mid := strings.TrimSuffix(strings.TrimPrefix(got, before), after)
	if !strings.Contains(mid, headerASCII) || strings.Contains(mid, Header) {
		t.Fatalf("a legacy-encoded file must get the ASCII header, got %q", mid)
	}
	if !strings.Contains(mid, "0.0.0.0 new.com") || strings.Contains(mid, "old.com") {
		t.Fatalf("section not updated: %q", mid)
	}
	mustRemove(t, m)
	if got := readString(t, path); got != before+after {
		t.Fatalf("after Remove got %q, want %q", got, before+after)
	}
}

func TestRepairUnbalancedMarkers(t *testing.T) {
	hdr := Header + "\n"
	cases := []struct {
		name, in, applied, removed string
		current                    []string
	}{
		{
			name: "start without end keeps the user lines after it",
			in: "127.0.0.1 localhost\n\n" + StartMarker + "\n" + hdr +
				"0.0.0.0 old.com\n:: old.com\n10.0.0.1 nas.lan\n# user comment\n",
			applied: "127.0.0.1 localhost\n\n" + section("\n", "new.com") + "10.0.0.1 nas.lan\n# user comment\n",
			removed: "127.0.0.1 localhost\n\n10.0.0.1 nas.lan\n# user comment\n",
			current: []string{"old.com"},
		},
		{
			name:    "start without end at the end of the file",
			in:      "a.lan\n\n" + StartMarker + "\n" + hdr + "0.0.0.0 old.com\n",
			applied: "a.lan\n\n" + section("\n", "new.com"),
			removed: "a.lan\n",
			current: []string{"old.com"},
		},
		{
			name:    "end without start",
			in:      "a.lan\n0.0.0.0 old.com\n:: old.com\n" + EndMarker + "\nb.lan\n",
			applied: "a.lan\n" + section("\n", "new.com") + "b.lan\n",
			removed: "a.lan\nb.lan\n",
			current: []string{"old.com"},
		},
		{
			name:    "lone end marker",
			in:      "a.lan\n" + EndMarker + "\n",
			applied: "a.lan\n" + section("\n", "new.com"),
			removed: "a.lan\n",
			current: []string{},
		},
		{
			name:    "duplicated sections",
			in:      "a.lan\n" + section("\n", "one.com") + "b.lan\n" + section("\n", "two.com") + "c.lan\n",
			applied: "a.lan\n" + section("\n", "new.com") + "b.lan\nc.lan\n",
			removed: "a.lan\nb.lan\nc.lan\n",
			current: []string{"one.com", "two.com"},
		},
		{
			name: "start, user line, start, end",
			in: "a.lan\n" + StartMarker + "\n0.0.0.0 x.com\nuser line\n" +
				StartMarker + "\n:: y.com\n" + EndMarker + "\nz.lan\n",
			applied: "a.lan\n" + section("\n", "new.com") + "user line\nz.lan\n",
			removed: "a.lan\nuser line\nz.lan\n",
			current: []string{"x.com", "y.com"},
		},
		{
			name:    "indented markers are still ours",
			in:      "a.lan\n  " + StartMarker + "  \n0.0.0.0 old.com\n\t" + EndMarker + "\n",
			applied: "a.lan\n" + section("\n", "new.com"),
			removed: "a.lan\n",
			current: []string{"old.com"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m, path := newManager(t, []byte(tc.in))
			cur, err := m.Current()
			if err != nil || !slices.Equal(cur, tc.current) {
				t.Fatalf("Current = %v, %v; want %v", cur, err, tc.current)
			}
			if ok, err := m.Verify(tc.current); ok || err != nil {
				t.Fatalf("Verify on a damaged section = %v, %v; want false", ok, err)
			}
			mustApply(t, m, "new.com")
			if got := readString(t, path); got != tc.applied {
				t.Fatalf("after Apply\n got %q\nwant %q", got, tc.applied)
			}
			if ok, err := m.Verify([]string{"new.com"}); !ok || err != nil {
				t.Fatalf("Verify after repair = %v, %v", ok, err)
			}
			if err := os.WriteFile(path, []byte(tc.in), 0o644); err != nil {
				t.Fatal(err)
			}
			mustRemove(t, m)
			if got := readString(t, path); got != tc.removed {
				t.Fatalf("after Remove\n got %q\nwant %q", got, tc.removed)
			}
		})
	}
}

func TestCurrentAndVerify(t *testing.T) {
	m, path := newManager(t, nil)
	if cur, err := m.Current(); err != nil || cur == nil || len(cur) != 0 {
		t.Fatalf("Current on missing file = %#v, %v", cur, err)
	}
	if ok, err := m.Verify(nil); !ok || err != nil {
		t.Fatalf("Verify(nil) on missing file = %v, %v", ok, err)
	}
	if ok, _ := m.Verify([]string{"a.com"}); ok {
		t.Fatal("Verify(a.com) on missing file = true")
	}

	if err := os.WriteFile(path, []byte(linuxHosts), 0o644); err != nil {
		t.Fatal(err)
	}
	mustApply(t, m, "b.com", "a.com")
	if cur, err := m.Current(); err != nil || !slices.Equal(cur, []string{"a.com", "b.com"}) {
		t.Fatalf("Current = %v, %v", cur, err)
	}
	if ok, err := m.Verify([]string{"A.com", "b.com"}); !ok || err != nil {
		t.Fatalf("Verify = %v, %v", ok, err)
	}
	if ok, _ := m.Verify([]string{"a.com"}); ok {
		t.Fatal("Verify with a different set = true")
	}
	if _, err := m.Verify([]string{"*.a.com"}); err == nil {
		t.Fatal("Verify accepted an invalid domain")
	}

	// Someone deletes one of our lines.
	edited := strings.Replace(readString(t, path), ":: b.com\n", "", 1)
	if err := os.WriteFile(path, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}
	if ok, _ := m.Verify([]string{"a.com", "b.com"}); ok {
		t.Fatal("Verify missed a deleted IPv6 line")
	}
	// Someone deletes the whole section.
	if err := os.WriteFile(path, []byte(linuxHosts), 0o644); err != nil {
		t.Fatal(err)
	}
	if ok, _ := m.Verify([]string{"a.com", "b.com"}); ok {
		t.Fatal("Verify missed a deleted section")
	}
	if ok, _ := m.Verify(nil); !ok {
		t.Fatal("Verify(nil) on a file without section = false")
	}
}

func TestRejectsUnsupportedFiles(t *testing.T) {
	cases := map[string]struct {
		content string
		err     error
	}{
		"utf-16 le": {"\xFF\xFE1\x002\x007\x00", ErrUnsupportedEncoding},
		"utf-16 be": {"\xFE\xFF\x001\x002", ErrUnsupportedEncoding},
		"nul bytes": {"127.0.0.1 localhost\n\x00\x00\x00", ErrCorrupt},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			m, path := newManager(t, []byte(tc.content))
			if err := m.Apply([]string{"a.com"}); !errors.Is(err, tc.err) {
				t.Fatalf("Apply = %v, want %v", err, tc.err)
			}
			if err := m.Remove(); !errors.Is(err, tc.err) {
				t.Fatalf("Remove = %v, want %v", err, tc.err)
			}
			if _, err := m.Current(); !errors.Is(err, tc.err) {
				t.Fatalf("Current = %v, want %v", err, tc.err)
			}
			if got := readString(t, path); got != tc.content {
				t.Fatal("the file was modified")
			}
		})
	}
}

func TestInvalidPath(t *testing.T) {
	for _, p := range []string{"", "hosts", filepath.Join("rel", "hosts")} {
		m := &Manager{Path: p}
		if err := m.Apply([]string{"a.com"}); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("Apply with Path %q = %v", p, err)
		}
		if _, err := m.Current(); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("Current with Path %q = %v", p, err)
		}
	}
}

func TestAutoFlushOnlyOnChange(t *testing.T) {
	m, _ := newManager(t, []byte(linuxHosts))
	flushes := 0
	m.flush = func(ctx context.Context) error { flushes++; return errors.New("ignored") }
	m.AutoFlush = true
	mustApply(t, m, "a.com")
	mustApply(t, m, "a.com")
	mustRemove(t, m)
	mustRemove(t, m)
	if flushes != 2 {
		t.Fatalf("flushes = %d, want 2", flushes)
	}
}

func TestRenderIsStable(t *testing.T) {
	// Rendering an already rendered document with the same domains is a no-op
	// for every layout the other tests produce.
	inputs := []string{"", linuxHosts, windowsDefaultHosts, "x", "\xEF\xBB\xBF", "a\r\nb\n"}
	for _, in := range inputs {
		doc, err := parseDocument([]byte(in))
		if err != nil {
			t.Fatal(err)
		}
		once := doc.render([]string{"a.com"})
		doc2, err := parseDocument(once)
		if err != nil {
			t.Fatal(err)
		}
		if twice := doc2.render([]string{"a.com"}); !bytes.Equal(once, twice) {
			t.Errorf("%q: render not stable:\n%q\n%q", in, once, twice)
		}
	}
}
