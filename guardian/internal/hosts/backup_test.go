package hosts

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
)

func readBackup(t *testing.T, m *Manager, i int) string {
	t.Helper()
	b, err := os.ReadFile(m.BackupPath(i))
	if err != nil {
		t.Fatalf("backup %d: %v", i, err)
	}
	return string(b)
}

func TestBackupBeforeFirstWrite(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	mustApply(t, m, "a.com")
	if got := readBackup(t, m, 0); got != linuxHosts {
		t.Fatalf("backup = %q, want the original", got)
	}
	// Changes to our own section never back up again, in this process or
	// in the next one.
	mustApply(t, m, "b.com")
	mustRemove(t, m)
	mustApply(t, m, "c.com")
	m2 := &Manager{Path: path, BackupDir: m.BackupDir}
	mustApply(t, m2, "d.com")
	if _, err := os.Stat(m.BackupPath(1)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a section-only change rotated the backups: %v", err)
	}
}

func TestBackupRefreshedAfterExternalEdits(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	mustApply(t, m, "a.com")
	// Someone edits the user's lines while the guardian runs; the next
	// write backs up their version (section included, as it was on disk),
	// and only BackupKeep copies are kept.
	var contents []string
	for i := range BackupKeep + 1 {
		edited := strings.Replace(readString(t, path), "127.0.0.1", "127.0.0.1\t# edit "+strconv.Itoa(i)+"\n127.0.0.1", 1)
		if err := os.WriteFile(path, []byte(edited), 0o644); err != nil {
			t.Fatal(err)
		}
		contents = append(contents, edited)
		mustApply(t, m, "a.com", "x"+strconv.Itoa(i)+".com")
		if got := readBackup(t, m, 0); got != edited {
			t.Fatalf("edit %d: newest backup = %q, want %q", i, got, edited)
		}
	}
	for i := range BackupKeep {
		if got, want := readBackup(t, m, i), contents[len(contents)-1-i]; got != want {
			t.Fatalf("backup %d = %q, want %q", i, got, want)
		}
	}
	if _, err := os.Stat(m.BackupPath(BackupKeep)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("more than %d backups kept: %v", BackupKeep, err)
	}
}

func TestBackupRetriedAfterFailure(t *testing.T) {
	m, _ := newManager(t, []byte(linuxHosts))
	dir := m.BackupDir
	// A file where the backup directory should be makes the backup fail.
	if err := os.WriteFile(dir, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	mustApply(t, m, "a.com") // the write still happens
	if err := os.Remove(dir); err != nil {
		t.Fatal(err)
	}
	mustApply(t, m, "b.com")
	if got := readBackup(t, m, 0); got != linuxHosts+"\n"+section("\n", "a.com") {
		t.Fatalf("retried backup = %q", got)
	}
}

// TestTornEmptyFileKeepsGoodBackup is the startup sequence after a crash in
// the middle of an in-place write: the file is empty and the engine calls
// Apply before anything else.
func TestTornEmptyFileKeepsGoodBackup(t *testing.T) {
	m, path := newManager(t, []byte(windowsDefaultHosts))
	mustApply(t, m, "a.com")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	m2 := &Manager{Path: path, BackupDir: m.BackupDir}
	mustApply(t, m2, "a.com")
	if got, want := readString(t, path), windowsDefaultHosts+"\r\n"+section("\r\n", "a.com"); got != want {
		t.Fatalf("after Apply on a torn file\n got %q\nwant %q", got, want)
	}
	if got := readBackup(t, m2, 0); got != windowsDefaultHosts {
		t.Fatalf("newest backup = %q, want the good copy", got)
	}
	if _, err := os.Stat(m2.BackupPath(1)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the empty file was backed up: %v", err)
	}

	// Later in the same process the user empties the file: it is not
	// restored (only the first write checks), and not backed up either.
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	mustApply(t, m2, "b.com")
	if got := readString(t, path); got != section("\r\n", "b.com") && got != section("\n", "b.com") {
		t.Fatalf("after Apply on an emptied file got %q", got)
	}
	if got := readBackup(t, m2, 0); got != windowsDefaultHosts {
		t.Fatalf("newest backup = %q, want the good copy", got)
	}
}

func TestFirstWriteRestoresCorruptFile(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	mustApply(t, m, "a.com")
	torn := linuxHosts[:10] + strings.Repeat("\x00", 4096)
	if err := os.WriteFile(path, []byte(torn), 0o644); err != nil {
		t.Fatal(err)
	}
	m2 := &Manager{Path: path, BackupDir: m.BackupDir}
	flushes := 0
	m2.flush = func(context.Context) error { flushes++; return nil }
	m2.AutoFlush = true
	mustRemove(t, m2)
	if got := readString(t, path); got != linuxHosts {
		t.Fatalf("after Remove on a torn file got %q", got)
	}
	if flushes != 1 {
		t.Fatalf("flushes = %d, want 1", flushes)
	}
	// Without any backup the damage is reported and the file left alone.
	m3, path3 := newManager(t, []byte(torn))
	if err := m3.Apply([]string{"a.com"}); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("Apply on a torn file without backup = %v, want ErrCorrupt", err)
	}
	if got := readString(t, path3); got != torn {
		t.Fatal("the torn file was modified")
	}
}

func TestRecover(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	if ok, err := m.Recover(); ok || err != nil {
		t.Fatalf("Recover on a good file = %v, %v", ok, err)
	}
	mustApply(t, m, "a.com")
	if err := os.WriteFile(path, []byte("\xEF\xBB\xBF"), 0o644); err != nil {
		t.Fatal(err)
	}
	if ok, err := m.Recover(); !ok || err != nil {
		t.Fatalf("Recover on a BOM-only file = %v, %v", ok, err)
	}
	if got := readString(t, path); got != linuxHosts {
		t.Fatalf("recovered %q", got)
	}
	if ok, err := m.Recover(); ok || err != nil {
		t.Fatalf("second Recover = %v, %v", ok, err)
	}
	m2, _ := newManager(t, []byte("\x00\x00"))
	if ok, err := m2.Recover(); ok || !errors.Is(err, ErrNoBackup) {
		t.Fatalf("Recover without backup = %v, %v", ok, err)
	}
	if _, err := (&Manager{}).Recover(); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("Recover without Path = %v", err)
	}
}

// TestRestorePrefersBackupWithContent: an empty newest backup (taken by an
// older build from a torn file) must not hide a good older one.
func TestRestorePrefersBackupWithContent(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	mustApply(t, m, "a.com")
	if err := os.Rename(m.BackupPath(0), m.BackupPath(1)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(m.BackupPath(0), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if bad, err := m.Damaged(); !bad || err != nil {
		t.Fatalf("Damaged = %v, %v", bad, err)
	}
	if ok, err := m.Recover(); !ok || err != nil {
		t.Fatalf("Recover = %v, %v", ok, err)
	}
	if got := readString(t, path); got != linuxHosts {
		t.Fatalf("restored %q", got)
	}
	// Only empty backups: an empty file is not damage.
	m2, _ := newManager(t, []byte{})
	if err := os.MkdirAll(m2.BackupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(m2.BackupPath(0), []byte("\xEF\xBB\xBF"), 0o600); err != nil {
		t.Fatal(err)
	}
	if bad, err := m2.Damaged(); bad || err != nil {
		t.Fatalf("Damaged with only empty backups = %v, %v", bad, err)
	}
}

func TestBackupNotRepeatedForSameContent(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	mustApply(t, m, "a.com")
	mustRemove(t, m) // back to the original bytes
	m2 := &Manager{Path: path, BackupDir: m.BackupDir}
	mustApply(t, m2, "a.com")
	if _, err := os.Stat(m.BackupPath(1)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("identical backup rotated the old one: %v", err)
	}
}

func TestBackupSkippedForMissingFileOrNoDir(t *testing.T) {
	m, _ := newManager(t, nil)
	mustApply(t, m, "a.com")
	if _, err := os.Stat(m.BackupPath(0)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("backup of a missing file: %v", err)
	}
	m2, _ := newManager(t, []byte(linuxHosts))
	m2.BackupDir = ""
	mustApply(t, m2, "a.com") // backups disabled: still writes
	if err := m2.RestoreFromBackup(); !errors.Is(err, ErrNoBackup) {
		t.Fatalf("RestoreFromBackup without BackupDir = %v", err)
	}
}

func TestDamagedEmptyFileRestored(t *testing.T) {
	m, path := newManager(t, []byte(windowsDefaultHosts))
	mustApply(t, m, "a.com")
	if bad, err := m.Damaged(); bad || err != nil {
		t.Fatalf("Damaged on a good file = %v, %v", bad, err)
	}
	// A crash in the middle of an in-place write left the file empty.
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if bad, err := m.Damaged(); !bad || err != nil {
		t.Fatalf("Damaged on an empty file = %v, %v", bad, err)
	}
	if err := m.RestoreFromBackup(); err != nil {
		t.Fatal(err)
	}
	if got := readString(t, path); got != windowsDefaultHosts {
		t.Fatalf("restored %q", got)
	}
	if bad, _ := m.Damaged(); bad {
		t.Fatal("still damaged after restore")
	}
}

func TestRestoreStripsOldSection(t *testing.T) {
	// The backup was taken while a block from a previous run was active.
	orig := linuxHosts + "\n" + section("\n", "stale.com")
	m, path := newManager(t, []byte(orig))
	mustApply(t, m, "a.com")
	if err := os.WriteFile(path, []byte("\x00\x00\x00\x00"), 0o644); err != nil {
		t.Fatal(err)
	}
	if bad, err := m.Damaged(); !bad || err != nil {
		t.Fatalf("Damaged with NUL bytes = %v, %v", bad, err)
	}
	if err := m.Apply([]string{"a.com"}); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("Apply on a corrupt file = %v, want ErrCorrupt", err)
	}
	if err := m.RestoreFromBackup(); err != nil {
		t.Fatal(err)
	}
	if got := readString(t, path); got != linuxHosts {
		t.Fatalf("restored %q, want the original without the stale section", got)
	}
	mustApply(t, m, "a.com")
	if ok, _ := m.Verify([]string{"a.com"}); !ok {
		t.Fatal("re-apply after restore failed")
	}
}

func TestRestoreSkipsUnusableBackups(t *testing.T) {
	m, path := newManager(t, []byte(linuxHosts))
	mustApply(t, m, "a.com")
	// Newest backup is corrupt; the next one is good.
	if err := os.Rename(m.BackupPath(0), m.BackupPath(1)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(m.BackupPath(0), []byte("x\x00"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := m.RestoreFromBackup(); err != nil {
		t.Fatal(err)
	}
	if got := readString(t, path); got != linuxHosts {
		t.Fatalf("restored %q", got)
	}
}

func TestDamagedHeuristicNegatives(t *testing.T) {
	// Empty file and no backup: the user may simply have an empty hosts file.
	m, _ := newManager(t, []byte{})
	if bad, err := m.Damaged(); bad || err != nil {
		t.Fatalf("Damaged(empty, no backup) = %v, %v", bad, err)
	}
	if err := m.RestoreFromBackup(); !errors.Is(err, ErrNoBackup) {
		t.Fatalf("RestoreFromBackup without backups = %v", err)
	}
	// Missing file.
	m2, _ := newManager(t, nil)
	if bad, err := m2.Damaged(); bad || err != nil {
		t.Fatalf("Damaged(missing) = %v, %v", bad, err)
	}
	// Unbalanced markers are repaired, not restored.
	m3, _ := newManager(t, []byte("a.lan\n"+StartMarker+"\n"))
	if bad, err := m3.Damaged(); bad || err != nil {
		t.Fatalf("Damaged(unbalanced) = %v, %v", bad, err)
	}
	// UTF-16 and UTF-32, with or without a byte order mark, are unsupported,
	// not damaged, even when a backup with content exists.
	wide := map[string]string{
		"utf-16 le bom":    "\xFF\xFEa\x00",
		"utf-16 le no bom": "1\x002\x007\x00.\x000\x00.\x000\x00.\x001\x00\r\x00\n\x00",
		"utf-16 be no bom": "\x001\x002\x007\x00.\x000\x00.\x000\x00.\x001\x00\n",
		"utf-32 be bom":    "\x00\x00\xFE\xFF\x00\x00\x00a\x00\x00\x00\n",
		"utf-32 le bom":    "\xFF\xFE\x00\x00a\x00\x00\x00\n\x00\x00\x00",
	}
	for name, content := range wide {
		m4, path4 := newManager(t, []byte(linuxHosts))
		mustApply(t, m4, "a.com")
		if err := os.WriteFile(path4, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		if bad, err := m4.Damaged(); bad || err != nil {
			t.Errorf("Damaged(%s) = %v, %v", name, bad, err)
		}
		if ok, err := m4.Recover(); ok || err != nil {
			t.Errorf("Recover(%s) = %v, %v", name, ok, err)
		}
		m5 := &Manager{Path: path4, BackupDir: m4.BackupDir}
		if err := m5.Apply([]string{"a.com"}); !errors.Is(err, ErrUnsupportedEncoding) {
			t.Errorf("first Apply(%s) = %v", name, err)
		}
		if got := readString(t, path4); got != content {
			t.Errorf("%s: the file was modified", name)
		}
	}
}
