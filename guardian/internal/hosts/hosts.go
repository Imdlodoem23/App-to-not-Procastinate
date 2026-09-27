package hosts

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// MaxFileSize is the largest hosts file the Manager reads. Anything bigger is
// refused with ErrTooLarge instead of being loaded into memory.
const MaxFileSize = 32 << 20

var (
	// ErrTooLarge is returned when the hosts file is larger than MaxFileSize.
	ErrTooLarge = fmt.Errorf("hosts: file larger than %d bytes", MaxFileSize)
	// ErrInvalidPath is returned when Manager.Path is empty or relative.
	ErrInvalidPath = errors.New("hosts: Manager.Path must be an absolute file path")
)

// Manager owns the Céntrate section of one hosts file. All methods are safe
// for concurrent use and are serialized by an internal mutex, so concurrent
// Apply calls never interleave their read-modify-write cycles. A Manager must
// not be copied after first use.
//
// Only one Manager (one guardian process) should manage a given file.
type Manager struct {
	// Path is the absolute path of the hosts file, normally
	// platform.HostsPath(). If it is a symbolic link, the link target is
	// rewritten and the link is kept.
	Path string
	// BackupDir receives hosts.bak and its rotated copies (see Backups). The
	// engine should place it inside platform.DataDir(), which only
	// administrators can write. Empty disables backups (tests only).
	BackupDir string
	// Logger receives operational events: counts, sizes and errors, never
	// domains. Nil discards them.
	Logger *slog.Logger
	// PollInterval is how often Watch checks the file. Zero or negative
	// selects DefaultPollInterval.
	PollInterval time.Duration
	// AutoFlush makes every Apply, Remove and RestoreFromBackup that changes
	// the file flush the system DNS cache afterwards (see FlushDNS), outside
	// the lock. Flush errors are logged and never returned. The engine turns it
	// on; tests leave it off so they never run system commands.
	AutoFlush bool

	mu             sync.Mutex
	backupSum      fingerprint // user part (section stripped) known to be in the newest backup
	recoverChecked bool        // the startup damage check (see Recover) has run
	cleaned        bool        // stale temporary files were removed in this process
	known          fingerprint // content after our last Apply/Remove/Restore
	seq            uint64      // incremented every time known is set

	// Test hooks; nil selects the real implementation.
	rename      func(src, dst string) error
	inPlace     func(path string, data []byte) error
	sleep       func(time.Duration)
	newTicker   func(time.Duration) (<-chan time.Time, func())
	flush       func(ctx context.Context) error
	beforeWrite func()
}

// fingerprint identifies the content of the file (or its absence).
type fingerprint struct {
	exists bool
	sum    [sha256.Size]byte
}

func fingerprintOf(data []byte, exists bool) fingerprint {
	if !exists {
		return fingerprint{}
	}
	return fingerprint{exists: true, sum: sha256.Sum256(data)}
}

func (m *Manager) logger() *slog.Logger {
	if m.Logger == nil {
		return slog.New(slog.DiscardHandler)
	}
	return m.Logger
}

func (m *Manager) checkPath() error {
	if m.Path == "" || !filepath.IsAbs(m.Path) {
		return ErrInvalidPath
	}
	return nil
}

// Apply makes the Céntrate section block exactly domains (IPv4 and IPv6),
// creating the file or the section if needed and repairing unbalanced markers.
// Domains are validated, lowercased, deduplicated and sorted first (see
// NormalizeDomains); if any is invalid nothing is written. An empty list is
// the same as Remove. When the resulting content equals the current one,
// nothing is written (the modification time does not change). The file is
// backed up before the write when its user lines are not in a backup yet, and
// the first Apply or Remove of the process restores a damaged file first (see
// Recover). On Windows, pass the list through HostsLayerDomains first.
func (m *Manager) Apply(domains []string) error {
	norm, err := NormalizeDomains(domains)
	if err != nil {
		return err
	}
	return m.update(norm)
}

// Remove deletes the Céntrate section (and any stray marker), plus one of the
// blank lines it leaves behind. A file without a section is not written.
func (m *Manager) Remove() error {
	return m.update(nil)
}

func (m *Manager) update(domains []string) error {
	if err := m.checkPath(); err != nil {
		return err
	}
	changed, err := m.updateLocked(domains)
	if err == nil && changed {
		m.autoFlush()
	}
	return err
}

func (m *Manager) updateLocked(domains []string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	data, exists, err := m.read()
	if err != nil {
		return false, err
	}
	restored := false
	if !m.recoverChecked {
		// First write of this process: restore a file torn by a crash of an
		// earlier one before building on it (see Recover). Without a usable
		// backup, parseDocument reports the damage below.
		data, exists, restored, err = m.recoverLocked(data, exists)
		if err != nil && !errors.Is(err, ErrNoBackup) {
			return false, err
		}
	}
	doc, err := parseDocument(data)
	if err != nil {
		return restored, err
	}
	out := doc.render(domains)
	if bytes.Equal(out, data) { // includes a missing file and no domains
		m.remember(data, exists)
		return restored, nil
	}
	m.backupBeforeWrite(doc, data, exists)
	if err := m.write(out); err != nil {
		return restored, err
	}
	m.remember(out, true)
	m.logger().Info("hosts: section updated", "entries", len(domains), "bytes", len(out))
	return true, nil
}

// Current returns the domains currently listed in the Céntrate section,
// sorted and deduplicated. A missing file or section yields an empty slice.
func (m *Manager) Current() ([]string, error) {
	if err := m.checkPath(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	data, _, err := m.read()
	if err != nil {
		return nil, err
	}
	doc, err := parseDocument(data)
	if err != nil {
		return nil, err
	}
	return doc.sectionDomains(), nil
}

// Verify reports whether the file already is exactly what Apply(expected)
// would produce: the section lists exactly expected, the markers are balanced
// and there is a single section. The watcher calls it and re-applies on false.
// It never writes.
func (m *Manager) Verify(expected []string) (bool, error) {
	norm, err := NormalizeDomains(expected)
	if err != nil {
		return false, err
	}
	if err := m.checkPath(); err != nil {
		return false, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	data, exists, err := m.read()
	if err != nil {
		return false, err
	}
	doc, err := parseDocument(data)
	if err != nil {
		return false, err
	}
	if !exists {
		return len(norm) == 0, nil
	}
	return bytes.Equal(doc.render(norm), data), nil
}

// read returns the file content; a missing file is (nil, false, nil).
func (m *Manager) read() ([]byte, bool, error) {
	data, err := readFileLimited(m.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return data, true, nil
}

// readFileLimited reads path, refusing files larger than MaxFileSize with
// ErrTooLarge. A missing file returns an error wrapping fs.ErrNotExist.
func readFileLimited(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("hosts: open: %w", err)
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, MaxFileSize+1))
	if err != nil {
		return nil, fmt.Errorf("hosts: read: %w", err)
	}
	if len(data) > MaxFileSize {
		return nil, ErrTooLarge
	}
	return data, nil
}

// remember records the content left by one of our operations, so Watch does
// not report our own writes. Callers hold m.mu.
func (m *Manager) remember(data []byte, exists bool) {
	m.known = fingerprintOf(data, exists)
	m.seq++
}

// FlushDNS flushes the system DNS cache (see the package-level FlushDNS),
// logging to m.Logger. Errors are logged and returned for information only.
func (m *Manager) FlushDNS(ctx context.Context) error {
	if m.flush != nil {
		return m.flush(ctx)
	}
	return FlushDNS(ctx, m.logger())
}

func (m *Manager) autoFlush() {
	if !m.AutoFlush {
		return
	}
	_ = m.FlushDNS(context.Background())
}
