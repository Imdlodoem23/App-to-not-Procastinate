package hosts

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
)

const (
	// BackupName is the newest backup in Manager.BackupDir. Older ones are
	// BackupName.1 and BackupName.2.
	BackupName = "hosts.bak"
	// BackupKeep is how many backups are kept.
	BackupKeep = 3
)

// ErrNoBackup is returned by RestoreFromBackup when no usable backup exists.
var ErrNoBackup = errors.New("hosts: no usable backup")

// BackupPath returns the path of the i-th newest backup (0 is BackupName).
func (m *Manager) BackupPath(i int) string {
	if i == 0 {
		return filepath.Join(m.BackupDir, BackupName)
	}
	return filepath.Join(m.BackupDir, BackupName+"."+strconv.Itoa(i))
}

// backupOnce copies the file to BackupDir before the first modification of
// the process lifetime. A backup identical to the newest one is not repeated,
// so restarts do not push older backups out. A failed backup is logged and
// retried before the next write; it does not block the write, which is atomic
// in the normal case. Callers hold m.mu.
func (m *Manager) backupOnce(data []byte, exists bool) {
	if m.backedUp || m.BackupDir == "" {
		return
	}
	if !exists {
		m.backedUp = true // nothing to preserve
		return
	}
	if err := m.writeBackup(data); err != nil {
		m.logger().Warn("hosts: backup failed", "err", err)
		return
	}
	m.backedUp = true
}

func (m *Manager) writeBackup(data []byte) error {
	if newest, err := os.ReadFile(m.BackupPath(0)); err == nil && bytes.Equal(newest, data) {
		return nil
	}
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

// Damaged reports whether the hosts file looks broken by an interrupted write
// of ours, the only case in which the engine should call RestoreFromBackup.
// The heuristic:
//
//   - the file contains NUL bytes (and is not UTF-16/UTF-32): a text hosts
//     file never does, while a crash during an in-place write can leave
//     zero-filled blocks; or
//   - the file is empty (0 bytes, or only a BOM) while the newest backup is
//     not: the atomic replace never produces an empty file, but a crash in the
//     middle of the in-place fallback can.
//
// Unbalanced or duplicated markers are not damage: Apply and Remove repair
// them without losing any user line (see the package documentation), which a
// restore could not promise because the backup may predate the user's edits.
// A missing file is not damage either: Apply creates it.
func (m *Manager) Damaged() (bool, error) {
	if err := m.checkPath(); err != nil {
		return false, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	data, exists, err := m.read()
	if err != nil || !exists {
		return false, err
	}
	switch _, err := parseDocument(data); {
	case errors.Is(err, ErrCorrupt):
		return true, nil
	case err != nil:
		return false, nil
	}
	if len(bytes.TrimPrefix(data, utf8BOM)) > 0 || m.BackupDir == "" {
		return false, nil
	}
	backup, err := os.ReadFile(m.BackupPath(0))
	return err == nil && len(bytes.TrimPrefix(backup, utf8BOM)) > 0, nil
}

// RestoreFromBackup rewrites the hosts file from the newest usable backup
// (one that exists and parses: no NUL bytes, not UTF-16), with any Céntrate
// section taken out; the engine re-applies the active domains afterwards. The
// damaged file is not backed up. It returns ErrNoBackup when there is nothing
// to restore. Use it only when Damaged reports true.
func (m *Manager) RestoreFromBackup() error {
	if err := m.checkPath(); err != nil {
		return err
	}
	changed, err := m.restoreLocked()
	if err == nil && changed {
		m.autoFlush()
	}
	return err
}

func (m *Manager) restoreLocked() (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.BackupDir == "" {
		return false, ErrNoBackup
	}
	for i := range BackupKeep {
		data, err := os.ReadFile(m.BackupPath(i))
		if err != nil || len(data) > MaxFileSize {
			continue
		}
		doc, err := parseDocument(data)
		if err != nil {
			continue
		}
		out := doc.render(nil)
		current, exists, err := m.read()
		if err == nil && exists && bytes.Equal(current, out) {
			m.remember(current, true)
			return false, nil
		}
		if err := m.write(out); err != nil {
			return false, fmt.Errorf("hosts: restore: %w", err)
		}
		m.remember(out, true)
		m.logger().Warn("hosts: restored from backup", "backup", i, "bytes", len(out))
		return true, nil
	}
	return false, ErrNoBackup
}
