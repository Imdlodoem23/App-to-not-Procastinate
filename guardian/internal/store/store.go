package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/clock"
	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// Names inside the data directory (§11.1).
const (
	stateFile     = "state.json"
	statePrevFile = "state.prev.json"
	dirEvents     = "events"
	currentFile   = "current"
	dirQuarantine = "quarantine"
	dirBackups    = "backups"
	dirSecret     = "secret"
	dirRun        = "run"
	keyFile       = "ledger.key"
	lockName      = "guardian.lock"
	cleanMarker   = "clean-shutdown"
	plannedMarker = "planned-stop"
	startsFile    = "starts.json"
	clockFile     = "clock.json"
)

// Storage rules of the contract that the generated data does not carry (§10.12, §11).
const (
	// SchemaVersion is the state.json schema this build writes (§11.5).
	SchemaVersion = 1
	// SegmentMaxBytes is the size at which the log rolls to a new segment.
	SegmentMaxBytes = 8 << 20
	// SafeModeUncleanStarts unclean starts within SafeModeWindow enter safe mode.
	SafeModeUncleanStarts = 3
	SafeModeWindow        = 5 * time.Minute
	// PlannedStopTTL is how long a planned-stop marker stays valid.
	PlannedStopTTL = 10 * time.Minute
	// KeepStateBackups is how many pre-migration snapshots backups/ keeps.
	KeepStateBackups = 3
)

// Options configures Open. Zero values select the real clocks and the OS layers.
type Options struct {
	// Now reads the wall clock, used for the markers, starts.json and quarantine
	// names (never for events: their time comes from the engine). Default time.Now.
	Now func() time.Time
	// BootTime and BootID identify the boot for starts.json. Defaults: clock.BootTime
	// and clock.BootID.
	BootTime func() time.Duration
	BootID   func() (string, error)
	// Anchor is the rollback anchor (§11.4). Nil selects DefaultAnchor(); test
	// binaries must set it (MemAnchor), so a test can never write the real anchor.
	Anchor AnchorStore
	// FS is the file-system layer. Nil selects OSFS().
	FS FS
	// SchemaVersion is the state.json schema this build writes; 0 selects
	// SchemaVersion. Older snapshots are migrated with Migrations, newer ones freeze
	// the store.
	SchemaVersion int
	// Migrations maps a schema version N to its migrate_N_to_N+1 function.
	Migrations map[int]Migration
	// Takeover is what a whole-tree takeover of the data directory that ran before
	// Open in this process moved aside or deleted (platform.EnsureDirReport, e.g. the
	// one done before the log file opens). Open adds its own takeovers: once a
	// takeover has deleted a planted secret/ledger.key link, Open can no longer see
	// it, so the key would pass for a missing one (log_unreadable) instead of a
	// replaced one (untrusted_key, §10.12 step 4).
	Takeover platform.TakeoverReport

	// Test seams.
	segmentBytes int64
	trustOwner   func(path string) error
	ensureDir    func(dir string, private bool) (platform.TakeoverReport, error)
}

func (o Options) resolve() (Options, error) {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.BootTime == nil {
		o.BootTime = clock.BootTime
	}
	if o.BootID == nil {
		o.BootID = clock.BootID
	}
	if o.FS == nil {
		o.FS = OSFS()
	}
	switch {
	case o.SchemaVersion == 0:
		o.SchemaVersion = SchemaVersion
	case o.SchemaVersion < 1:
		return o, fmt.Errorf("store: schema version %d", o.SchemaVersion)
	}
	if o.Anchor == nil {
		if testing.Testing() {
			return o, errors.New("store: tests must set Options.Anchor (use NewMemAnchor)")
		}
		o.Anchor = DefaultAnchor()
	}
	if o.segmentBytes <= 0 {
		o.segmentBytes = SegmentMaxBytes
	}
	if o.trustOwner == nil {
		o.trustOwner = trustedOwner
	}
	if o.ensureDir == nil {
		o.ensureDir = platform.EnsureDirReport
	}
	return o, nil
}

// EpochReason is why an epoch starts (EpochStartReason in domain.ts).
type EpochReason string

const (
	EpochInstall       EpochReason = "install"
	EpochDataDeleted   EpochReason = "data_deleted"
	EpochLogUnreadable EpochReason = "log_unreadable"
	EpochUntrustedKey  EpochReason = "untrusted_key"
)

func (r EpochReason) valid() bool {
	switch r {
	case EpochInstall, EpochDataDeleted, EpochLogUnreadable, EpochUntrustedKey:
		return true
	}
	return false
}

// StateSource says which snapshot Open recovered.
type StateSource string

const (
	StateNone     StateSource = "none"
	StateCurrent  StateSource = "state"
	StatePrevious StateSource = "prev"
)

// RecoveryKind mirrors RecoveryKind in domain.ts (guardian_started.recovery).
type RecoveryKind string

const (
	RecoveryNone           RecoveryKind = "none"
	RecoveryReplayed       RecoveryKind = "replayed"
	RecoveryBackupSnapshot RecoveryKind = "backup_snapshot"
	RecoveryRebuilt        RecoveryKind = "rebuilt"
	RecoveryPartial        RecoveryKind = "partial"
	RecoveryHostsSection   RecoveryKind = "hosts_section"
	RecoveryEmpty          RecoveryKind = "empty"
)

// LogRepair describes a log truncated at a complete line that failed verification
// (§11.4): the engine appends ledger_repaired with these values and
// balanceCorrection = min(0, anchor.balance − rebuiltBalance).
type LogRepair struct {
	// DroppedFromSeq is the first seq removed; the next event reuses it.
	DroppedFromSeq int64
	// DroppedCount is how many lines were removed.
	DroppedCount int64
	// ArchivedAs is the quarantine file, relative to the data directory, with "/".
	ArchivedAs string
}

// RecoveryReport is what Open found and did (§10.12 steps 1-7). The engine turns it
// into events and modes; the store emits nothing itself.
type RecoveryReport struct {
	// Fresh: nothing existed (no log, no state, no anchor): a first install.
	Fresh bool
	// NeedEpoch is set when there is no usable current epoch: the engine must call
	// NewEpoch with this reason before any append. install for a fresh directory,
	// untrusted_key after the key was replaced, log_unreadable otherwise (carry from
	// the anchor, kept state from LoadState when a snapshot survived).
	NeedEpoch EpochReason
	// Epoch and LastSeq are the current epoch and its last committed seq.
	Epoch   string
	LastSeq int64

	// Frozen: a snapshot or log line with a newer schema or envelope version and a
	// valid MAC (§11.5). Nothing was modified; writes return ErrFrozen.
	// FrozenEnforcement is the v1 enforcement core to enforce from, when found.
	Frozen            bool
	FrozenReason      string
	FrozenEnforcement json.RawMessage

	// UncleanShutdown: run/clean-shutdown was missing (and this is not a fresh
	// install). UncleanStarts counts the unclean starts within SafeModeWindow, this
	// one included; SafeMode is UncleanStarts ≥ SafeModeUncleanStarts.
	UncleanShutdown bool
	UncleanStarts   int
	SafeMode        bool
	// PlannedStop is the consumed run/planned-stop marker.
	PlannedStop PlannedStop

	// KeyCreated: secret/ledger.key was created now. KeyReplaced: an existing key was
	// not trusted (owner, links, length) and was replaced; unless Fresh, NeedEpoch is
	// untrusted_key and the engine writes tamper_detected{untrusted_key}. A key the
	// §11.1 takeover deleted (a link, a special file or a file with several hard
	// links, or below a secret/ that was a link) counts as replaced, and so does the
	// key of a tree moved aside as untrusted when the directory is not Fresh.
	KeyCreated  bool
	KeyReplaced bool
	KeyProblem  string

	// State is the snapshot LoadState returns; ReplayFrom is its lastEventSeq: the
	// engine replays every event with seq > ReplayFrom (0: rebuild the whole epoch).
	State              StateSource
	StateSchemaVersion int
	StateMigratedFrom  int
	ReplayFrom         int64
	// StateMACInvalid: a snapshot failed its MAC (tamper_detected{state_mac}).
	// StateCorrupt: a snapshot could not be parsed. Both were moved to quarantine.
	// StateStale: a snapshot with a valid MAC did not match the log (another epoch,
	// ahead of the log or a different mac at its seq) and was not used.
	StateMACInvalid bool
	StateCorrupt    bool
	StateStale      bool

	// TornBytes were truncated from the final line; PartialLines complete lines of a
	// trailing batch without txEnd were quarantined (crash artifacts, never
	// acknowledged). Repair is set when a complete line failed verification.
	TornBytes    int
	PartialLines int
	Repair       *LogRepair
	// Quarantined lists the files written to quarantine/ (relative, with "/").
	Quarantined []string
	// RemovedTemps counts stale temporary files removed.
	RemovedTemps int

	// Anchor is the rollback anchor read at start (nil when absent or unreadable) and
	// AnchorCheck its comparison with the recovered log.
	Anchor      *Anchor
	AnchorCheck AnchorCheck
	AnchorError string

	// Recovery is the suggested guardian_started.recovery value (the engine may
	// refine it, e.g. hosts_section).
	Recovery RecoveryKind
	// Warnings are non-fatal problems (cleanup failures, unmigratable snapshots…).
	Warnings []string
}

// Store is an open data directory. Its methods are safe for concurrent use.
type Store struct {
	mu     sync.Mutex
	dir    string
	o      Options
	fs     FS
	anchor AnchorStore
	lock   *dirLock
	key    []byte
	closed bool

	frozen    bool
	needEpoch EpochReason
	epoch     string
	segs      []*segment // non-empty segments of the current epoch, by first seq
	lastSeq   int64
	lastMac   string
	appendF   File
	appendSeg *segment
	broken    error

	loaded   *LoadedState // snapshot recovered at Open
	curState []byte       // bytes of state.json as last verified or written (prev rotation)
	report   RecoveryReport
}

func (s *Store) path(elem ...string) string {
	return filepath.Join(append([]string{s.dir}, elem...)...)
}

// Open opens (creating it if needed) the data directory dir, runs the store's part of
// the startup ladder and returns the store with its recovery report. It fails with
// ErrLocked when another process holds the directory.
func Open(dir string, opts Options) (*Store, RecoveryReport, error) {
	rep := RecoveryReport{State: StateNone}
	if dir == "" || !filepath.IsAbs(dir) {
		return nil, rep, fmt.Errorf("store: %q is not an absolute path", dir)
	}
	o, err := opts.resolve()
	if err != nil {
		return nil, rep, err
	}
	s := &Store{dir: filepath.Clean(dir), o: o, fs: o.FS, anchor: o.Anchor}
	// What the takeovers (§11.1) moved aside or deleted, before loadKey looks.
	var took platform.TakeoverReport
	took.MovedAside = append(took.MovedAside, o.Takeover.MovedAside...)
	took.Removed = append(took.Removed, o.Takeover.Removed...)
	ensure := func(d string, private bool) error {
		tr, err := o.ensureDir(s.path(d), private)
		took.MovedAside = append(took.MovedAside, tr.MovedAside...)
		took.Removed = append(took.Removed, tr.Removed...)
		return err
	}
	for _, d := range []string{"", dirRun} {
		if err := ensure(d, false); err != nil {
			return nil, rep, err
		}
	}
	if s.lock, err = acquireLock(s.path(dirRun, lockName)); err != nil {
		return nil, rep, err
	}
	ok := false
	defer func() {
		if !ok {
			s.release()
		}
	}()
	for _, d := range []string{dirEvents, dirQuarantine, dirBackups} {
		if err := ensure(d, false); err != nil {
			return nil, rep, err
		}
	}
	if err := ensure(dirSecret, true); err != nil {
		return nil, rep, err
	}
	rep.RemovedTemps = s.removeStaleTemps()

	a, hasAnchor, aerr := s.anchor.Load()
	switch {
	case aerr != nil:
		rep.AnchorError = aerr.Error()
	case hasAnchor:
		rep.Anchor = &a
	}
	rep.Fresh = s.looksFresh() && !hasAnchor && aerr == nil

	clean, err := s.consumeCleanShutdown()
	if err != nil {
		return nil, rep, err
	}
	rep.UncleanShutdown = !clean && !rep.Fresh
	rep.PlannedStop = s.consumePlannedStop()
	if rep.UncleanShutdown {
		n, err := s.recordUncleanStart()
		if err != nil {
			rep.Warnings = append(rep.Warnings, "starts.json: "+err.Error())
		}
		rep.UncleanStarts = n
		rep.SafeMode = n >= SafeModeUncleanStarts
	}

	s.noteTakeover(&rep, took)
	if err := s.loadKey(&rep); err != nil {
		return nil, rep, err
	}
	switch {
	case rep.KeyReplaced && rep.Fresh:
		s.needEpoch = EpochInstall
		s.checkAnchor(&rep, nil)
	case rep.KeyReplaced:
		// Nothing signed with the old key can be trusted: no snapshot, no log.
		s.needEpoch = EpochUntrustedKey
		s.checkAnchor(&rep, nil)
	default:
		if err := s.recover(&rep); err != nil {
			return nil, rep, err
		}
	}

	rep.NeedEpoch = s.needEpoch
	rep.Epoch = s.epoch
	rep.LastSeq = s.lastSeq
	rep.Frozen = s.frozen
	rep.Recovery = suggestRecovery(&rep)
	s.report = rep
	ok = true
	return s, rep, nil
}

func suggestRecovery(r *RecoveryReport) RecoveryKind {
	switch {
	case r.Fresh || r.NeedEpoch == EpochInstall:
		return RecoveryEmpty
	case r.NeedEpoch != "" && r.State != StateNone && r.State != "":
		return RecoveryBackupSnapshot
	case r.NeedEpoch != "":
		return RecoveryEmpty
	case r.Repair != nil:
		return RecoveryPartial
	case r.State == StatePrevious:
		return RecoveryBackupSnapshot
	case r.State == StateCurrent && r.ReplayFrom == r.LastSeq:
		return RecoveryNone
	case r.State == StateCurrent:
		return RecoveryReplayed
	}
	return RecoveryRebuilt
}

// looksFresh reports whether the directory holds no log and no snapshot.
func (s *Store) looksFresh() bool {
	for _, p := range []string{s.path(stateFile), s.path(statePrevFile), s.path(dirEvents, currentFile)} {
		if _, err := s.fs.Lstat(p); !notExist(err) {
			return false
		}
	}
	entries, err := s.fs.ReadDir(s.path(dirEvents))
	if err != nil {
		return false
	}
	for _, e := range entries {
		if isEpochID(e.Name()) {
			return false
		}
	}
	return true
}

// removeStaleTemps deletes leftover "*.tmp-*" files of interrupted atomic writes
// (§10.12 step 2) in every directory the store writes.
func (s *Store) removeStaleTemps() int {
	dirs := []string{s.dir, s.path(dirRun), s.path(dirSecret), s.path(dirBackups), s.path(dirQuarantine), s.path(dirEvents)}
	if entries, err := s.fs.ReadDir(s.path(dirEvents)); err == nil {
		for _, e := range entries {
			if e.IsDir() && isEpochID(e.Name()) {
				dirs = append(dirs, s.path(dirEvents, e.Name()))
			}
		}
	}
	n := 0
	for _, d := range dirs {
		entries, err := s.fs.ReadDir(d)
		if err != nil {
			continue
		}
		removed := false
		for _, e := range entries {
			if !e.IsDir() && isTemp(e.Name()) && s.fs.Remove(filepath.Join(d, e.Name())) == nil {
				n++
				removed = true
			}
		}
		if removed {
			_ = s.fs.SyncDir(d)
		}
	}
	return n
}

// Report returns the recovery report of Open.
func (s *Store) Report() RecoveryReport {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.report
}

// Dir returns the data directory.
func (s *Store) Dir() string { return s.dir }

// Epoch returns the current epoch ("" while NeedEpoch is set).
func (s *Store) Epoch() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.epoch
}

// LastSeq returns the seq of the last committed event of the current epoch.
func (s *Store) LastSeq() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastSeq
}

// LastMac returns the mac of the last committed event ("" when the epoch is empty).
func (s *Store) LastMac() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastMac
}

// Frozen reports frozen mode (§11.5).
func (s *Store) Frozen() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.frozen
}

// Stats are sizes and flags for diagnostics.
type Stats struct {
	Epoch    string
	LastSeq  int64
	Segments int
	LogBytes int64
	Frozen   bool
	Broken   bool
}

// Stats returns the current log sizes and flags.
func (s *Store) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := Stats{Epoch: s.epoch, LastSeq: s.lastSeq, Segments: len(s.segs), Frozen: s.frozen, Broken: s.broken != nil}
	for _, g := range s.segs {
		st.LogBytes += g.size
	}
	return st
}

// writable returns why a write is refused, or nil. The caller holds s.mu.
func (s *Store) writable() error {
	switch {
	case s.closed:
		return ErrClosed
	case s.frozen:
		return ErrFrozen
	case s.broken != nil:
		return s.broken
	}
	return nil
}

// Close releases the lock and the open segment. It does not write the clean-shutdown
// marker: call SaveState and MarkCleanShutdown first on a clean stop.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	return s.release()
}

func (s *Store) release() error {
	err := s.closeAppend()
	if s.lock != nil {
		if lerr := s.lock.release(); err == nil {
			err = lerr
		}
		s.lock = nil
	}
	return err
}

func (s *Store) closeAppend() error {
	if s.appendF == nil {
		return nil
	}
	err := s.appendF.Close()
	s.appendF, s.appendSeg = nil, nil
	return err
}

// quarantineName returns a free "quarantine/<kind>-<ts><ext>" path and its relative
// form with "/".
func (s *Store) quarantineName(kind, ext string) (abs, rel string) {
	ts := s.o.Now().UTC().Format("20060102T150405.000Z")
	for i := 0; ; i++ {
		name := kind + "-" + ts + ext
		if i > 0 {
			name = fmt.Sprintf("%s-%s-%d%s", kind, ts, i, ext)
		}
		abs = s.path(dirQuarantine, name)
		if _, err := s.fs.Lstat(abs); notExist(err) {
			return abs, dirQuarantine + "/" + name
		}
	}
}

// quarantineMove moves a file or directory into quarantine/.
func (s *Store) quarantineMove(src, kind, ext string) (string, error) {
	abs, rel := s.quarantineName(kind, ext)
	if err := s.fs.Rename(src, abs); err != nil {
		return "", err
	}
	_ = s.fs.SyncDir(filepath.Dir(src))
	_ = s.fs.SyncDir(s.path(dirQuarantine))
	return rel, nil
}

func (s *Store) warn(rep *RecoveryReport, format string, args ...any) {
	rep.Warnings = append(rep.Warnings, fmt.Sprintf(format, args...))
}
