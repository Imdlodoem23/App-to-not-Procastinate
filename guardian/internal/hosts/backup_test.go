package hosts

import (
	"errors"
	"os"
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
	// Later writes of the same process do not back up again.
	mustApply(t, m, "b.com")
	mustRemove(t, m)
	if _, err := os.Stat(m.BackupPath(1)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("second backup in the same process: %v", err)
	}

	// Each new process (Manager) backs up once; only BackupKeep are kept.
	var contents []string
	for i, d := range []string{"c.com", "d.com", "e.com", "f.com"} {
		contents = append(contents, readString(t, path))
		m2 := &Manager{Path: path, BackupDir: m.BackupDir}
		mustApply(t, m2, d)
		mustApply(t, m2, d, "x.com")
		if got := readBackup(t, m2, 0); got != contents[i] {
			t.Fatalf("process %d: newest backup = %q, want %q", i, got, contents[i])
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
	// UTF-16 is unsupported, not damaged.
	m4, _ := newManager(t, []byte("\xFF\xFEa\x00"))
	if bad, err := m4.Damaged(); bad || err != nil {
		t.Fatalf("Damaged(utf-16) = %v, %v", bad, err)
	}
}
