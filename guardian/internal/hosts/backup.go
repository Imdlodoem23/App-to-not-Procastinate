package hosts

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

const (
	// BackupName is the newest backup in Manager.BackupDir. Older ones are
	// BackupName.1 and BackupName.2.
	BackupName = "hosts.bak"
	// BackupKeep is how many backups are kept.
	BackupKeep = 3
)

// OriginalName is the pristine copy of the hosts file in Manager.BackupDir:
// the file as the guardian first saw it, with any Céntrate section taken
// out. It is written once and never overwritten (docs/ARCHITECTURE.md
// §10.10, §11.1); it is the last resort of Recover and RestoreFromBackup, and
// RestoreOriginal writes it back.
const OriginalName = "hosts.original"

// ErrNoBackup is returned by RestoreFromBackup when no usable backup exists.
var ErrNoBackup = errors.New("hosts: no usable backup")

// BackupPath returns the path of the i-th newest backup (0 is BackupName).
func (m *Manager) BackupPath(i int) string {
	if i == 0 {
		return filepath.Join(m.BackupDir, BackupName)
	}
	return filepath.Join(m.BackupDir, BackupName+"."+strconv.Itoa(i))
}

// OriginalPath returns the path of hosts.original.
func (m *Manager) OriginalPath() string {
	return filepath.Join(m.BackupDir, OriginalName)
}

// candidatePath returns the i-th restore candidate: the rotating backups,
// newest first, then hosts.original.
func (m *Manager) candidatePath(i int) string {
	if i < BackupKeep {
		return m.BackupPath(i)
	}
	return m.OriginalPath()
}

// saveOriginalLocked writes hosts.original from doc (the file just read,
// parsed) the first time this Manager reads an existing, usable hosts file,
// unless it already exists: it is never overwritten. The Céntrate section is
// taken out. Failures are logged and retried at the next read. Callers hold
// m.mu.
func (m *Manager) saveOriginalLocked(doc *document, exists bool) {
	if m.originalDone || m.BackupDir == "" || !exists {
		return
	}
	p := m.OriginalPath()
	if _, err := os.Lstat(p); err == nil {
		m.originalDone = true
		return
	} else if !errors.Is(err, fs.ErrNotExist) {
		m.logger().Warn("hosts: cannot check the original copy", "err", err)
		return
	}
	if err := m.writeBackupFile(p, doc.render(nil, time.Time{})); err != nil {
		m.logger().Warn("hosts: original copy not written", "err", err)
		return
	}
	m.originalDone = true
	m.logger().Info("hosts: original copy written")
}

// writeBackupFile writes data to dst in BackupDir through a synced temporary
// file, refusing to replace an existing dst.
func (m *Manager) writeBackupFile(dst string, data []byte) error {
	if err := os.MkdirAll(m.BackupDir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(m.BackupDir, tempPrefix+"*"+tempSuffix)
	if err != nil {
		return err
	}
	name := tmp.Name()
	_, err = tmp.Write(data)
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		if _, serr := os.Lstat(dst); serr == nil {
			err = fs.ErrExist
		} else if !errors.Is(serr, fs.ErrNotExist) {
			err = serr
		}
	}
	if err == nil {
		err = os.Rename(name, dst)
	}
	if err != nil {
		_ = os.Remove(name)
		return err
	}
	syncDir(m.BackupDir)
	return nil
}

// RestoreOriginal rewrites the hosts file with hosts.original (the file as
// the guardian first saw it, without the section), unless the file already
// holds exactly that. The current file is not backed up. It returns
// ErrNoBackup when hosts.original is missing or unusable. The engine uses it
// when the file is unparseable and the uninstaller when the file is unusable
// (docs/ARCHITECTURE.md §10.10, §10.12).
func (m *Manager) RestoreOriginal() error {
	if err := m.checkPath(); err != nil {
		return err
	}
	changed, err := m.restoreOriginalLocked()
	if err == nil && changed {
		m.autoFlush()
	}
	return err
}

func (m *Manager) restoreOriginalLocked() (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.BackupDir == "" {
		return false, ErrNoBackup
	}
	out, ok := m.usableCandidate(BackupKeep)
	if !ok {
		return false, ErrNoBackup
	}
	current, exists, err := m.read()
	if err == nil && exists && bytes.Equal(current, out) {
		m.remember(current, true)
		m.recoverChecked = true
		return false, nil
	}
	if err := m.write(out); err != nil {
		return false, fmt.Errorf("hosts: restore original: %w", err)
	}
	m.remember(out, true)
	m.recoverChecked = true
	m.logger().Warn("hosts: restored from the original copy", "bytes", len(out))
	return true, nil
}

// usableCandidate reads restore candidate i and returns it with any section
// taken out, when it is readable and parseable.
func (m *Manager) usableCandidate(i int) ([]byte, bool) {
	data, err := readFileLimited(m.candidatePath(i))
	if err != nil {
		return nil, false
	}
	doc, err := parseDocument(data)
	if err != nil {
		return nil, false
	}
	return doc.render(nil, time.Time{}), true
}

// backupBeforeWrite copies the file (data, parsed as doc) to BackupDir before
// a write, when the user's part of it (everything outside the Céntrate
// section) is not in the newest backup yet: before the first write of a
// process, and again whenever someone else has edited the user's lines since.
// Changes to our own section never rotate the backups.
//
// Content that could push the good copies out is never backed up: a file
// whose user part is empty (or only a BOM) while an older backup has content,
// which is what an interrupted write or an emptied file looks like.
// Unparseable content never reaches this point.
//
// A failed backup is logged and retried before the next write; it does not
// block the write, which is atomic in the normal case. Callers hold m.mu.
func (m *Manager) backupBeforeWrite(doc *document, data []byte, exists bool) {
	if m.BackupDir == "" || !exists {
		return
	}
	user := doc.render(nil, time.Time{})
	sum := fingerprintOf(user, true)
	if sum == m.backupSum {
		return
	}
	if !hasContent(user) {
		if good, _, ok := m.pickBackup(); ok && hasContent(good) {
			m.logger().Warn("hosts: not backing up an empty hosts file over a backup with content")
			return
		}
	}
	if newest, err := readFileLimited(m.BackupPath(0)); err == nil {
		if nd, err := parseDocument(newest); err == nil && fingerprintOf(nd.render(nil, time.Time{}), true) == sum {
			m.backupSum = sum
			return
		}
	}
	if err := m.writeBackup(data); err != nil {
		m.logger().Warn("hosts: backup failed", "err", err)
		return
	}
	m.backupSum = sum
}

// hasContent reports whether b has anything besides a UTF-8 BOM.
func hasContent(b []byte) bool {
	return len(bytes.TrimPrefix(b, utf8BOM)) > 0
}

func (m *Manager) writeBackup(data []byte) error {
	if err := os.MkdirAll(m.BackupDir, 0o755); err != nil {
		return err
	}
	removeStaleTemps(m.BackupDir)
	tmp, err := os.CreateTemp(m.BackupDir, tempPrefix+"*"+tempSuffix)
	if err != nil {
		return err
	}
	name := tmp.Name()
	_, err = tmp.Write(data)
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(name)
		return err
	}
	// Rotate: hosts.bak.1 -> hosts.bak.2, hosts.bak -> hosts.bak.1.
	if err := os.Remove(m.BackupPath(BackupKeep - 1)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		_ = os.Remove(name)
		return err
	}
	for i := BackupKeep - 2; i >= 0; i-- {
		if err := os.Rename(m.BackupPath(i), m.BackupPath(i+1)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			_ = os.Remove(name)
			return err
		}
	}
	if err := os.Rename(name, m.BackupPath(0)); err != nil {
		_ = os.Remove(name)
		return err
	}
	syncDir(m.BackupDir)
	m.logger().Info("hosts: backup written", "bytes", len(data))
	return nil
}

// pickBackup returns the newest usable backup with any Céntrate section taken
// out, and its index: the rotating backups first, newest first, then
// hosts.original (index BackupKeep). Usable means readable, at most
// MaxFileSize and parseable (no NUL bytes, not UTF-16/UTF-32). A backup with
// content is preferred over newer empty ones, so a backup of an empty file
// (taken by an older build) never hides a good one. ok is false when no
// backup is usable.
func (m *Manager) pickBackup() (out []byte, index int, ok bool) {
	if m.BackupDir == "" {
		return nil, 0, false
	}
	var fallback []byte
	fallbackAt := -1
	for i := range BackupKeep + 1 {
		stripped, ok := m.usableCandidate(i)
		if !ok {
			continue
		}
		if hasContent(stripped) {
			return stripped, i, true
		}
		if fallbackAt < 0 {
			fallback, fallbackAt = stripped, i
		}
	}
	return fallback, fallbackAt, fallbackAt >= 0
}

// Damaged reports whether the hosts file looks broken by an interrupted write
// of ours, the only case in which it should be restored from a backup (see
// Recover). The heuristic:
//
//   - the file contains a run of NUL bytes or nothing but NUL bytes
//     (ErrCorrupt): a text hosts file never does, in any encoding, while a
//     crash during an in-place write can leave zero-filled blocks; or
//   - the file is empty (0 bytes, or only a BOM) while a usable backup has
//     content: the atomic replace never produces an empty file, but a crash
//     in the middle of the in-place fallback can.
//
// Files in an unsupported encoding (UTF-16 or UTF-32, with or without a byte
// order mark) are not damage: Apply refuses them with ErrUnsupportedEncoding
// and they stay as the user saved them. Unbalanced or duplicated markers are
// not damage either: Apply and Remove repair them without losing any user
// line (see the package documentation), which a restore could not promise
// because the backup may predate the user's edits. A missing file is not
// damage: Apply creates it.
func (m *Manager) Damaged() (bool, error) {
	if err := m.checkPath(); err != nil {
		return false, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	data, exists, err := m.read()
	if err != nil {
		return false, err
	}
	return m.damagedLocked(data, exists), nil
}

func (m *Manager) damagedLocked(data []byte, exists bool) bool {
	switch {
	case !exists:
		return false
	case errors.Is(checkEncoding(data), ErrCorrupt):
		return true
	case hasContent(data):
		return false
	}
	good, _, ok := m.pickBackup()
	return ok && hasContent(good)
}

// Recover restores the hosts file from the newest usable backup when it
// looks damaged (see Damaged), checking and restoring under one lock, and
// reports whether it rewrote the file. A damaged file with no usable backup
// returns ErrNoBackup and is left alone.
//
// The first Apply or Remove of each process runs the same check itself before
// anything else, so a file torn by a crash in an earlier process is restored
// before a new section is built on it (after which Damaged could no longer
// tell). The engine should still call Recover at startup, before the first
// Apply, to learn about a restore and report it.
func (m *Manager) Recover() (bool, error) {
	if err := m.checkPath(); err != nil {
		return false, err
	}
	changed, err := m.recoverOnce()
	if err == nil && changed {
		m.autoFlush()
	}
	return changed, err
}

func (m *Manager) recoverOnce() (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	data, exists, err := m.read()
	if err != nil {
		return false, err
	}
	out, outExists, changed, err := m.recoverLocked(data, exists)
	if err == nil {
		if doc, perr := parseDocument(out); perr == nil {
			m.saveOriginalLocked(doc, outExists)
		}
	}
	return changed, err
}

// recoverLocked restores the file when data (its current content) looks
// damaged and returns the content the caller should continue from, whether
// the file exists and whether it was rewritten. Once a check has completed
// (nothing to do, restored, or nothing to restore from), m.recoverChecked is
// set and updates stop checking. Callers hold m.mu.
func (m *Manager) recoverLocked(data []byte, exists bool) ([]byte, bool, bool, error) {
	if !m.damagedLocked(data, exists) {
		m.recoverChecked = true
		return data, exists, false, nil
	}
	out, changed, err := m.restoreLocked()
	if err != nil {
		if errors.Is(err, ErrNoBackup) {
			m.recoverChecked = true
		}
		return data, exists, false, err
	}
	m.recoverChecked = true
	return out, true, changed, nil
}

// RestoreFromBackup rewrites the hosts file from the newest usable backup
// (see pickBackup: one that exists and parses, preferring one with content
// over newer empty ones), with any Céntrate section taken out; the engine
// re-applies the active domains afterwards. The current file is not backed
// up. It returns ErrNoBackup when there is nothing to restore. It restores
// unconditionally: prefer Recover, which only restores a damaged file.
func (m *Manager) RestoreFromBackup() error {
	if err := m.checkPath(); err != nil {
		return err
	}
	changed, err := m.restoreUnconditionally()
	if err == nil && changed {
		m.autoFlush()
	}
	return err
}

func (m *Manager) restoreUnconditionally() (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, changed, err := m.restoreLocked()
	if err == nil {
		m.recoverChecked = true
	}
	return changed, err
}

// restoreLocked writes the chosen backup (section stripped) to the file
// unless the file already holds exactly that, and returns that content.
// Callers hold m.mu.
func (m *Manager) restoreLocked() ([]byte, bool, error) {
	out, i, ok := m.pickBackup()
	if !ok {
		return nil, false, ErrNoBackup
	}
	current, exists, err := m.read()
	if err == nil && exists && bytes.Equal(current, out) {
		m.remember(current, true)
		return out, false, nil
	}
	if err := m.write(out); err != nil {
		return nil, false, fmt.Errorf("hosts: restore: %w", err)
	}
	m.remember(out, true)
	m.logger().Warn("hosts: restored from backup", "backup", i, "bytes", len(out))
	return out, true, nil
}
