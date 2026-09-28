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
	// rewritten and the link is kept. It is ignored when Resolve is set.
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
	// Resolve, when set, returns the path of the hosts file and replaces
	// Path. It is called at most once every ResolveEvery (DefaultResolveEvery
	// when zero or negative): the engine passes platform.HostsPath, which on
	// Windows follows the DataBasePath registry value (docs/ARCHITECTURE.md
	// §10.10: re-read every 60 s). When the path changes, the Manager starts
	// over on the new file (damage check, stale temporary files, Watch
	// baseline, so Watch reports the change and the engine re-applies there);
	// the old file is left as it is.
	Resolve      func() string
	ResolveEvery time.Duration
	// BreakLocks makes a write of a non-empty section that still fails
	// because another process holds the file open, after the retries of
	// Manager.write, close the processes that hold it (Windows, Restart
	// Manager) and try once more. Only ordinary processes in an interactive
	// session are closed, the way blocked apps are (see procwatch.Kill);
	// services, critical and protected processes and anything in session 0
	// (an antivirus, a backup agent) are waited for. Any user can open the
	// hosts file for reading and deny write sharing, which would otherwise
	// keep every new block out of the file. The engine turns it on.
	BreakLocks bool
	// OnLockBroken, when set, is called with the processes BreakLocks closed,
	// after the Apply that closed them returns its lock (from the caller's
	// goroutine; it must not block). The engine records tamper_detected{hosts}.
	OnLockBroken func(closed []LockHolder)

	mu             sync.Mutex
	backupSum      fingerprint // user part (section stripped) known to be in the newest backup
	recoverChecked bool        // the startup damage check (see Recover) has run
	cleaned        bool        // stale temporary files were removed in this process
	known          fingerprint // content after our last Apply/Remove/Restore
	seq            uint64      // incremented every time known is set
	originalDone   bool        // hosts.original exists (written now or found)
	lastHash       string      // SectionHash of the last section written ("" before)
	pathGen        uint64      // resolve generation the per-file state belongs to
	cur            string      // path read by the current operation (see read and write)
	blocking       bool        // the current write leaves a non-empty section (see BreakLocks)
	broken         []LockHolder

	pathMu     sync.Mutex // guards the resolve cache below (taken after mu, never before)
	resolved   string
	resolvedAt time.Time
	resolveGen uint64

	// Test hooks; nil selects the real implementation.
	rename      func(src, dst string) error
	inPlace     func(path string, data []byte) error
	sleep       func(time.Duration)
	newTicker   func(time.Duration) (<-chan time.Time, func())
	flush       func(ctx context.Context) error
	beforeWrite func()
	now         func() time.Time
	lockHolders func(path string) ([]LockHolder, error)
	killHolder  func(LockHolder) error
}

// DefaultResolveEvery is how often Manager.Resolve is consulted.
const DefaultResolveEvery = 60 * time.Second

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
	p, _ := m.resolvePath()
	return validPath(p)
}

func validPath(p string) error {
	if p == "" || !filepath.IsAbs(p) {
		return ErrInvalidPath
	}
	return nil
}

// resolvePath returns the hosts path (Path, or Resolve's cached answer) and
// the generation it belongs to, which changes whenever Resolve returns a new
// path.
func (m *Manager) resolvePath() (string, uint64) {
	if m.Resolve == nil {
		return m.Path, 1
	}
	m.pathMu.Lock()
	defer m.pathMu.Unlock()
	now := time.Now
	if m.now != nil {
		now = m.now
	}
	every := m.ResolveEvery
	if every <= 0 {
		every = DefaultResolveEvery
	}
	t := now()
	if m.resolveGen == 0 || t.Sub(m.resolvedAt) >= every || t.Before(m.resolvedAt) {
		if p := m.Resolve(); m.resolveGen == 0 || p != m.resolved {
			m.resolved = p
			m.resolveGen++
		}
		m.resolvedAt = t
	}
	return m.resolved, m.resolveGen
}

// target returns the path to operate on and, when Resolve moved it since
// the last call, resets the state that belonged to the previous file.
// Callers hold m.mu.
func (m *Manager) target() (string, error) {
	p, gen := m.resolvePath()
	if err := validPath(p); err != nil {
		return "", err
	}
	if gen != m.pathGen {
		if m.pathGen != 0 {
			m.logger().Warn("hosts: the hosts file path changed; managing the new file")
			m.recoverChecked, m.cleaned = false, false
			m.backupSum = fingerprint{}
			m.remember(nil, false)
		}
		m.pathGen = gen
	}
	return p, nil
}

// CurrentPath returns the hosts file the Manager operates on now: Path, or
// the latest answer of Resolve.
func (m *Manager) CurrentPath() string {
	p, _ := m.resolvePath()
	return p
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
//
// Apply writes no header line (see ApplyUntil). More domains than
// SectionBudget are refused with ErrOverBudget.
func (m *Manager) Apply(domains []string) error {
	return m.ApplyUntil(domains, time.Time{})
}

// ApplyUntil is Apply that also writes the header line
// "# centrate-hosts v1 until=… count=…" (FormatSectionHeader) right after the
// section's comment, so enforcement survives the loss of every state file
// (docs/ARCHITECTURE.md §10.10, §10.12). until is the latest trusted endsAt
// among the active blocks; a zero until writes no header line. An empty list
// removes the section.
func (m *Manager) ApplyUntil(domains []string, until time.Time) error {
	norm, err := NormalizeDomains(domains)
	if err != nil {
		return err
	}
	if len(norm) > SectionBudget() {
		return ErrOverBudget
	}
	return m.update(norm, until)
}

// ApplyPrioritized applies at most SectionBudget domains taken from groups,
// highest priority first (see Prioritize), with the header line for until,
// and returns how many distinct domains were left out. Nothing is written
// when a domain is invalid. The engine logs a non-zero count (never the
// domains).
func (m *Manager) ApplyPrioritized(groups [][]string, until time.Time) (int, error) {
	kept, dropped, err := Prioritize(groups, SectionBudget())
	if err != nil {
		return 0, err
	}
	if dropped > 0 {
		m.logger().Warn("hosts: section over budget, entries dropped by priority", "kept", len(kept), "dropped", dropped)
	}
	return dropped, m.update(kept, until)
}

// Remove deletes the Céntrate section (and any stray marker), plus one of the
// blank lines it leaves behind. A file without a section is not written.
func (m *Manager) Remove() error {
	return m.update(nil, time.Time{})
}

func (m *Manager) update(domains []string, until time.Time) error {
	if err := m.checkPath(); err != nil {
		return err
	}
	changed, err := m.updateLocked(domains, until)
	if err == nil && changed {
		m.autoFlush()
	}
	m.mu.Lock()
	broken := m.broken
	m.broken = nil
	m.mu.Unlock()
	if len(broken) > 0 && m.OnLockBroken != nil {
		m.OnLockBroken(broken)
	}
	return err
}

func (m *Manager) updateLocked(domains []string, until time.Time) (bool, error) {
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
	m.saveOriginalLocked(doc, exists)
	out := doc.render(domains, until)
	if bytes.Equal(out, data) { // includes a missing file and no domains
		m.remember(data, exists)
		m.lastHash = SectionHash(domains)
		return restored, nil
	}
	m.backupBeforeWrite(doc, data, exists)
	m.blocking = len(domains) > 0
	err = m.write(out)
	m.blocking = false
	if err != nil {
		return restored, err
	}
	m.remember(out, true)
	m.lastHash = SectionHash(domains)
	m.logger().Info("hosts: section updated", "entries", len(domains), "bytes", len(out))
	return true, nil
}

// Section parses the current section: its domains (sorted, deduplicated,
// never nil) and the until of its header line. ok is false when the file has
// no section or the section has no valid header line. It never writes.
func (m *Manager) Section() (domains []string, until time.Time, ok bool, err error) {
	info, err := m.SectionInfo()
	if err != nil {
		return nil, time.Time{}, false, err
	}
	return info.Domains, info.Until, info.Present && info.HasHeader, nil
}

// SectionInfo describes the current section, header line included. A missing
// file has no section. It never writes.
func (m *Manager) SectionInfo() (SectionInfo, error) {
	if err := m.checkPath(); err != nil {
		return SectionInfo{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	data, _, err := m.read()
	if err != nil {
		return SectionInfo{}, err
	}
	doc, err := parseDocument(data)
	if err != nil {
		return SectionInfo{}, err
	}
	return doc.sectionInfo(), nil
}

// LastSectionHash returns the SectionHash of the section the last successful
// Apply, ApplyUntil, ApplyPrioritized or Remove of this Manager left in the
// file (the hash of the empty list after Remove); ok is false before any.
func (m *Manager) LastSectionHash() (hash string, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lastHash, m.lastHash != ""
}

// CurrentSectionHash returns the SectionHash of the domains the section
// blocks now (see Current; of the empty list when there is none). Compared with the hash
// persisted after the last write, it tells whether someone changed the
// section while the guardian was not running.
func (m *Manager) CurrentSectionHash() (string, error) {
	ds, err := m.Current()
	if err != nil {
		return "", err
	}
	return SectionHash(ds), nil
}

// Current returns the domains the Céntrate section currently blocks, sorted
// and deduplicated: the domains it lists, minus any that a user line outside
// the section maps to a real address (a line the next Apply comments out, see
// ShadowMarker). So a line added while the guardian was stopped changes
// CurrentSectionHash just as editing the section does. A missing file or
// section yields an empty slice.
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
	return doc.effectiveDomains(), nil
}

// Verify reports whether the file already is exactly what Apply(expected)
// would produce, keeping the until of the header line the section has (if
// any): the section lists exactly expected, its header line (when present)
// counts them, the markers are balanced and there is a single section. The
// watcher calls it and re-applies on false. It never writes.
func (m *Manager) Verify(expected []string) (bool, error) {
	return m.verify(expected, time.Time{}, false)
}

// VerifyUntil is Verify that also requires the header line for until (none
// when until is zero): the file is exactly what ApplyUntil(expected, until)
// would produce.
func (m *Manager) VerifyUntil(expected []string, until time.Time) (bool, error) {
	return m.verify(expected, until, true)
}

func (m *Manager) verify(expected []string, until time.Time, strict bool) (bool, error) {
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
	if !strict {
		if info := doc.sectionInfo(); info.HasHeader {
			until = info.Until
		}
	}
	return bytes.Equal(doc.render(norm, until), data), nil
}

// read returns the file content; a missing file is (nil, false, nil).
// Callers hold m.mu.
func (m *Manager) read() ([]byte, bool, error) {
	m.cur = ""
	p, err := m.target()
	if err != nil {
		return nil, false, err
	}
	m.cur = p
	data, err := readFileLimited(p)
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
