package engine

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
	"github.com/imdlodoem23/centrate/guardian/internal/clock"
	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/hosts"
	"github.com/imdlodoem23/centrate/guardian/internal/platform"
	"github.com/imdlodoem23/centrate/guardian/internal/procwatch"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
	"github.com/imdlodoem23/centrate/guardian/internal/version"

	// IANA time zones for local days and schedules on every OS (§4).
	_ "time/tzdata"
)

// Timing rules of the contract that the generated data does not carry (§10.1, §10.2,
// §10.10, §10.12, §11.3). Every numeric rule that exists in the embedded JSON is read
// from there instead.
const (
	// tickInterval is the engine TICK (§10.1).
	tickInterval = 2 * time.Second
	// maxAwakePerTick clamps the awake time one tick may credit (§10.1, §10.9).
	maxAwakePerTick = 10 * time.Second
	// reconcileEvery re-renders and verifies enforcement even without changes (§10.10).
	reconcileEvery = 30 * time.Second
	// saveEvery bounds how long tick-only changes (credit, clock) wait for state.json.
	saveEvery = 30 * time.Second
	// stopPenaltyThreshold: a same-boot stop longer than this during a block is
	// tamper_detected{service_stopped} (§10.12 step 9).
	stopPenaltyThreshold = 60 * time.Second
	// bootHoldMax is the longest a new boot holds completions awaiting a time check.
	bootHoldMax = 120 * time.Second
	// Calibration schedule (§10.2).
	calibrateAfterBoot   = 60 * time.Second
	calibrateAfterJump   = 10 * time.Second
	calibrateEvery       = 30 * time.Minute
	calibrateBackoffMin  = 15 * time.Second
	calibrateBackoffMax  = 5 * time.Minute
	calibrateTimeout     = 30 * time.Second
	hostsTamperEventGap  = time.Minute
	processStartGrace    = 60 * time.Second
	processLogonGrace    = 90 * time.Second
	endedBlocksHistoryMs = int64(7 * 24 * time.Hour / time.Millisecond)
	jumpsWindowMs        = int64(24 * time.Hour / time.Millisecond)
	blocksPageDefault    = 50
)

// Options configures an Engine. Zero values select the real implementations, except
// Anchor in tests (the store refuses the system anchor inside a test binary).
type Options struct {
	// DataDir is the system data directory. Default platform.DataDir().
	DataDir string
	// Clock reads the machine's clocks. Default SystemClock{}.
	Clock Clock
	// Hosts is the hosts layer. Default a hosts.Manager on platform.HostsPath() with
	// backups in platform.BackupDir().
	Hosts HostsManager
	// DNS flushes the resolver cache after hosts changes. Default hosts.FlushDNS.
	DNS DNSFlusher
	// NetworkTime is the calibration source. Default clock.NetworkTime.
	NetworkTime NetworkTime
	// Nuclear is the Nuclear supervisor's OS side; nil disables relaunching.
	Nuclear NuclearRelauncher
	// ProcessLister and ProcessKiller drive the process watcher. Defaults: the OS ones.
	ProcessLister ProcessLister
	ProcessKiller ProcessKiller
	// ProcessInterval is the process watcher period (default procwatch.DefaultInterval).
	ProcessInterval time.Duration
	// Anchor is the rollback anchor. Nil selects the store default.
	Anchor store.AnchorStore
	// StoreFS is the store's file-system layer (tests inject failures). Nil: the OS.
	StoreFS store.FS
	// SchemaVersion is the state.json schema this build writes (0: store.SchemaVersion)
	// and Migrations its migrate_N_to_N+1 functions (§11.5); tests use them to produce
	// a newer schema (frozen mode).
	SchemaVersion int
	Migrations    map[int]store.Migration
	// Catalog and Platform: default catalog.Default() and catalog.CurrentPlatform().
	Catalog  *catalog.Catalog
	Platform catalog.Platform
	// Logger receives operational logs (never personal data). Nil discards them.
	Logger *slog.Logger
	// Version is the guardian version (default version.Version); Commit its commit.
	Version string
	Commit  string
	// BinaryID identifies this build of the guardian, sealed in run/clock.json at every
	// save: an update planned-stop marker exempts a stop only when the binary changed
	// (§10.12 step 9). Default: Version and the SHA-256 of the executable.
	BinaryID string
	// Port is the API port (health, diagnostics). Default the embedded default port.
	Port int
	// ServiceManager names the service manager for diagnostics.
	ServiceManager string
	// TestHooks makes health report the testhooks capability (testhooks builds only).
	TestHooks bool
	// LogonBoot returns the boot-clock reading of the last interactive logon, for the
	// process logon grace (§10.8); nil: no logon grace.
	LogonBoot func() (time.Duration, bool)
	// HostsPath is the hosts file path shown in diagnostics (sanitized) and
	// HostsPathRedirected reports the Windows DataBasePath override. Defaults:
	// platform.HostsPath and platform.HostsPathRedirected.
	HostsPath           string
	HostsPathRedirected func() bool
	// DetectTimezone returns the OS IANA zone written at first start ("" unknown).
	DetectTimezone func() string
	// NewTicker creates the loop ticker (default a *time.Ticker).
	NewTicker func(time.Duration) Ticker
	// DisableWatchers keeps Start from running the hosts and process watchers (tests
	// that drive detections by hand).
	DisableWatchers bool
}

// Engine is the guardian's single owner of mutable state (§10.1). Every mutation and
// every query runs on one goroutine (the loop started by Start), or inline on the
// caller's goroutine, serialized, before Start and in tests. API handlers call the
// exported command methods, which run in one engine turn: the time-driven step, then
// validation, the mutation in commit order (§11.3) and the response.
type Engine struct {
	o        Options
	cat      *catalog.Catalog
	platform catalog.Platform
	log      *slog.Logger

	// Lifecycle (guarded by lifeMu).
	lifeMu   sync.Mutex
	running  bool
	stopped  bool
	opened   bool
	openErr  error
	ready    chan struct{}
	cmds     chan *command
	loopDone chan struct{}
	cancel   context.CancelFunc
	loopCtx  context.Context
	wg       sync.WaitGroup
	// ioWG tracks the hosts write and DNS flush workers (enforce.go); Stop waits for
	// them once no turn can start any more, and then no new one starts (ioStopped).
	ioWG      sync.WaitGroup
	ioStopped bool
	// inlineMu serializes commands while no loop runs.
	inlineMu sync.Mutex

	// Shared with other goroutines (safe for concurrent use).
	st           *store.Store
	matcher      atomic.Pointer[procwatch.Matcher]
	watcherErr   atomic.Bool
	eventsNotify *notifier
	rulesNotify  *notifier

	// Everything below is owned by the engine goroutine.
	det       *clock.Detector
	state     engineState
	bootID    string
	now       int64 // trusted Unix ms of the current turn
	prevT     int64
	bootNow   time.Duration
	awakeNow  time.Duration
	lastBoot  time.Duration
	lastAwake time.Duration
	startBoot time.Duration
	startedAt int64
	lastWall  time.Time
	loopMode  bool
	// inlineCalibration runs a due calibration inside the turn even on the loop
	// (TestClock).
	inlineCalibration bool

	mode          string
	startProblems []string
	diskFull      bool
	curReq        *string
	idem          []store.IdempotencyRecord
	// replayedReqs are the req fingerprints of the events replayed at startup (with
	// their latest trusted time), for addLostResponses.
	replayedReqs map[string]int64
	// lastAppliedAt is the trusted time of the last event applied (the reboot restore
	// jump's lower bound when rebuilt from the log).
	lastAppliedAt int64

	enf           enforcementPlan
	enfDirty      bool
	enfFP         string
	lastReconcile time.Duration
	hosts         hostsState
	contention    hosts.Contention
	frozenCore    *enforcementCore

	cal        calibration
	hold       *bootHold
	startJumps []jumpRec

	// critical is the startup evidence not committed yet (critical.go).
	critical         []criticalEv
	flushingCritical bool
	criticalRetryAt  time.Duration

	dirty        bool
	urgent       bool
	anchorEpoch  string
	anchorSeq    int64
	lastSave     time.Duration
	stateFP      string
	stateFPVer   int64
	integrity    string
	errCounts    map[string]*DiagnosticsError
	kills        []int64
	tampers      []int64
	lastCountKey map[string]attemptMemo
}

// command is one unit of work for the engine goroutine.
type command struct {
	fn   func()
	done chan struct{}
	ran  bool
}

// New prepares an Engine without touching the system: Open (or Start) runs the
// startup ladder.
func New(o Options) (*Engine, error) {
	if o.DataDir == "" {
		o.DataDir = platform.DataDir()
	}
	if o.Clock == nil {
		o.Clock = SystemClock{}
	}
	if o.Logger == nil {
		o.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if o.Hosts == nil {
		o.Hosts = &hosts.Manager{Path: platform.HostsPath(), BackupDir: platform.BackupDir(), Logger: o.Logger}
	}
	if o.DNS == nil {
		if f, ok := o.Hosts.(DNSFlusher); ok {
			o.DNS = f
		} else {
			o.DNS = systemFlusher
		}
	}
	if o.NetworkTime == nil {
		o.NetworkTime = NetworkTimeFunc(clock.NetworkTime)
	}
	if o.ProcessLister == nil {
		o.ProcessLister = procwatch.OSLister{}
	}
	if o.ProcessKiller == nil {
		o.ProcessKiller = procwatch.OSKiller{}
	}
	if o.ProcessInterval <= 0 {
		o.ProcessInterval = procwatch.DefaultInterval
	}
	if o.Catalog == nil {
		o.Catalog = catalog.Default()
	}
	if o.Platform == "" {
		o.Platform = catalog.CurrentPlatform()
	}
	if o.Version == "" {
		o.Version = version.Version
	}
	if o.BinaryID == "" {
		o.BinaryID = defaultBinaryID(o.Version)
	}
	if o.Port == 0 {
		o.Port = embedded.API().DefaultPort
	}
	if o.HostsPath == "" {
		o.HostsPath = platform.HostsPath()
	}
	if o.HostsPathRedirected == nil {
		o.HostsPathRedirected = platform.HostsPathRedirected
	}
	if o.DetectTimezone == nil {
		o.DetectTimezone = detectOSZone
	}
	if o.NewTicker == nil {
		o.NewTicker = newRealTicker
	}
	e := &Engine{
		o:            o,
		cat:          o.Catalog,
		platform:     o.Platform,
		log:          o.Logger,
		ready:        make(chan struct{}),
		cmds:         make(chan *command),
		loopDone:     make(chan struct{}),
		eventsNotify: newNotifier(),
		rulesNotify:  newNotifier(),
		state:        newEngineState(),
		mode:         ModeGuardianNormal,
		errCounts:    map[string]*DiagnosticsError{},
		lastCountKey: map[string]attemptMemo{},
		integrity:    "ok",
	}
	e.matcher.Store(&procwatch.Matcher{})
	// Contested: retry every 10 s, not with a growing backoff (§10.10): a script that
	// strips the section must not push the re-apply minutes away.
	e.contention.MaxDelay = hosts.DefaultContentionMinDelay
	return e, nil
}

// Open runs the startup ladder synchronously (§10.12 steps 1–11): lock and recover the
// store, restore the clock, write the startup events and reconcile enforcement. Start
// calls it when it was not called before; tests call it directly.
func (e *Engine) Open() error {
	e.inlineMu.Lock()
	defer e.inlineMu.Unlock()
	e.lifeMu.Lock()
	if e.opened || e.openErr != nil || e.stopped {
		err := e.openErr
		if e.stopped {
			err = ErrStopped
		}
		e.lifeMu.Unlock()
		return err
	}
	e.lifeMu.Unlock()

	err := e.startup()
	e.lifeMu.Lock()
	if err != nil {
		e.openErr = err
	} else {
		e.opened = true
	}
	e.lifeMu.Unlock()
	close(e.ready)
	return err
}

// Ready is closed once Open finished (successfully or not; see OpenErr).
func (e *Engine) Ready() <-chan struct{} { return e.ready }

// OpenErr is the error of the startup ladder, if it failed.
func (e *Engine) OpenErr() error {
	e.lifeMu.Lock()
	defer e.lifeMu.Unlock()
	return e.openErr
}

// Start implements svc.Runner: it returns at once and runs the startup ladder (unless
// Open already ran) and then the engine loop, the hosts watcher and the process watcher
// in the background until ctx is done or Stop is called.
func (e *Engine) Start(ctx context.Context) error {
	e.lifeMu.Lock()
	if e.running || e.stopped {
		e.lifeMu.Unlock()
		return errors.New("engine: already started or stopped")
	}
	e.lifeMu.Unlock()
	ctx, cancel := context.WithCancel(ctx)
	e.lifeMu.Lock()
	e.cancel = cancel
	e.loopCtx = ctx
	e.lifeMu.Unlock()
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		select {
		case <-e.ready:
		default:
			if err := e.Open(); err != nil {
				e.log.Error("guardian startup failed", "err", err)
				close(e.loopDone)
				return
			}
		}
		if e.OpenErr() != nil {
			close(e.loopDone)
			return
		}
		e.inlineMu.Lock()
		e.lifeMu.Lock()
		e.running = true
		e.lifeMu.Unlock()
		e.loopMode = true
		e.inlineMu.Unlock()
		if !e.o.DisableWatchers {
			e.startWatchers(ctx)
		}
		e.loop(ctx)
	}()
	return nil
}

// loop is the engine goroutine.
func (e *Engine) loop(ctx context.Context) {
	t := e.o.NewTicker(tickInterval)
	defer t.Stop()
	defer func() {
		// Refuse what is still queued; senders see loopDone afterwards.
		for {
			select {
			case c := <-e.cmds:
				close(c.done)
			default:
				close(e.loopDone)
				return
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case c := <-e.cmds:
			c.ran = true
			c.fn()
			close(c.done)
		case <-t.C():
			e.step()
		}
	}
}

// startWatchers runs the hosts watcher and the process watcher (§10.1): they send
// notices and detections to the engine goroutine.
func (e *Engine) startWatchers(ctx context.Context) {
	e.wg.Add(2)
	go func() {
		defer e.wg.Done()
		_ = e.o.Hosts.Watch(ctx, func() { e.post(ctx, func() { e.onHostsChanged() }) })
	}()
	go func() {
		defer e.wg.Done()
		w := &procwatch.Watcher{
			Interval: e.o.ProcessInterval,
			Lister:   watchedLister{e.o.ProcessLister, &e.watcherErr},
			Killer:   e.o.ProcessKiller,
			Logger:   e.log,
			Now:      e.det.EffectiveNow,
		}
		w.Run(ctx, func() procwatch.Matcher { return *e.matcher.Load() }, func(k procwatch.Killed) {
			e.post(ctx, func() { e.onProcessKilled(k) })
		})
	}()
}

// watchedLister records whether the last listing failed (problem process_watcher_failed).
type watchedLister struct {
	l   ProcessLister
	bad *atomic.Bool
}

func (w watchedLister) List() ([]procwatch.Process, error) {
	p, err := w.l.List()
	w.bad.Store(err != nil)
	return p, err
}

// post runs fn on the engine goroutine (after a time step), waiting for it.
func (e *Engine) post(ctx context.Context, fn func()) {
	_ = e.exec(ctx, func() {
		if !e.opened {
			return
		}
		e.timeStep()
		fn()
		e.afterTurn()
	})
}

// Stop implements svc.Runner: it stops the loop and the watchers and shuts down cleanly
// (§13): final state and clock snapshot, the clean-shutdown marker, the lock released.
// It never removes the hosts section.
func (e *Engine) Stop() error {
	e.lifeMu.Lock()
	if e.stopped {
		e.lifeMu.Unlock()
		return nil
	}
	e.stopped = true
	cancel := e.cancel
	e.lifeMu.Unlock()
	if cancel != nil {
		cancel()
	}
	e.wg.Wait()
	e.inlineMu.Lock()
	defer e.inlineMu.Unlock()
	e.waitIO()
	e.lifeMu.Lock()
	e.running = false
	opened := e.opened
	e.lifeMu.Unlock()
	if !opened || e.st == nil {
		return nil
	}
	var errs []error
	// Evidence of the previous stop that could not be logged keeps the snapshots as they
	// were, so the next start finds it again (critical.go).
	held := e.criticalHeld()
	if !e.isFrozen() && !held {
		e.readClocks()
		e.now = e.trustedNowMs()
		if err := e.saveState(); err != nil {
			errs = append(errs, err)
		}
	}
	if !held {
		if err := e.saveClock(e.st.LastSeq(), true); err != nil {
			errs = append(errs, err)
		}
	}
	if err := e.st.MarkCleanShutdown(); err != nil {
		errs = append(errs, err)
	}
	if err := e.st.Close(); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// Shutdown implements svc.ShutdownRunner: an OS shutdown writes the planned-stop marker
// first (§13), so the next start in the same boot is not penalized.
func (e *Engine) Shutdown(ctx context.Context) error {
	_ = ctx
	e.lifeMu.Lock()
	st := e.st
	e.lifeMu.Unlock()
	if st != nil {
		_ = st.MarkPlannedStop("shutdown")
	}
	return e.Stop()
}

// exec runs fn on the engine goroutine, or inline (serialized) when no loop runs.
func (e *Engine) exec(ctx context.Context, fn func()) error {
	e.inlineMu.Lock()
	e.lifeMu.Lock()
	running, stopped := e.running, e.stopped
	e.lifeMu.Unlock()
	if !running {
		defer e.inlineMu.Unlock()
		if stopped {
			return ErrStopped
		}
		fn()
		return nil
	}
	e.inlineMu.Unlock()
	c := &command{fn: fn, done: make(chan struct{})}
	select {
	case e.cmds <- c:
	case <-e.loopDone:
		return ErrStopped
	case <-ctx.Done():
		return ctx.Err()
	}
	<-c.done
	if !c.ran {
		return ErrStopped
	}
	return nil
}

// Request is what the API layer knows about a request besides its body.
type Request struct {
	// Scope is the token kind that authenticated it: "app", "ext" or "" (none).
	Scope string
	// ExtensionID is the paired extension of an ext-token request.
	ExtensionID string
	// Idem is set for an idempotent request (§8.6) that carried an Idempotency-Key.
	Idem *Idempotency
}

// cmdOpts describe a command for run.
type cmdOpts struct {
	// write marks a mutation: refused in frozen and safe mode (§8.3 step 6).
	write bool
	// report marks a write that can only cost the user points or report progress
	// (attempts, study heartbeat/strike/pause/resume/end): refused in frozen mode only,
	// so safe mode, which anyone with admin rights reaches by killing the guardian
	// three times, never suspends a penalty (§16.2).
	report bool
	// idem is the idempotency data of the request, or nil.
	idem *Idempotency
	// status is the success status stored with an idempotent response.
	status int
}

// run executes one command in one engine turn (§8.3 step 8): the time-driven step,
// the mode check, the idempotency lookup, fn (validation, mutation in commit order,
// response), the idempotency record, then reconcile and persistence.
func run[T any](e *Engine, ctx context.Context, o cmdOpts, fn func() (T, error)) (T, error) {
	var res T
	var err error
	xerr := e.exec(ctx, func() {
		if !e.opened {
			err = ErrNotOpen
			return
		}
		e.timeStep()
		defer e.afterTurn()
		if o.write || o.report {
			check := e.writable
			if o.report {
				check = e.acceptsReports
			}
			if werr := check(); werr != nil {
				err = werr
				return
			}
		}
		if o.idem != nil {
			if ierr := e.idemLookup(o.idem); ierr != nil {
				err = ierr
				return
			}
			req := o.idem.Req
			e.curReq = &req
			defer func() { e.curReq = nil }()
		}
		res, err = fn()
		if err == nil && o.idem != nil {
			e.idemStore(o.idem, o.status, res)
		}
	})
	if xerr != nil {
		return res, xerr
	}
	return res, err
}

// Step runs exactly one engine tick (§10.1): the time-driven step, the Nuclear
// supervisor, enforcement reconcile when due and persistence when due.
func (e *Engine) Step() {
	_ = e.exec(context.Background(), func() {
		if e.opened {
			e.step()
		}
	})
}

func (e *Engine) step() {
	e.timeStep()
	e.nuclearReconcile()
	e.closeBrowsersStep()
	e.afterTurn()
}

// afterTurn reconciles enforcement when dirty or due and saves state when due.
func (e *Engine) afterTurn() {
	e.retryCritical()
	e.pollHosts()
	if e.enfDirty || e.bootNow-e.lastReconcile >= reconcileEvery || e.hostsRetryDue() {
		e.reconcile()
	}
	e.checkHostsSustained()
	e.flushTamper()
	if e.enfDirty {
		e.reconcile()
	}
	e.persistIfDue()
}

// writable is nil when mutations are allowed (§8.3 step 6).
func (e *Engine) writable() error {
	switch e.mode {
	case ModeGuardianFrozen:
		return readOnly("schema_too_new")
	case ModeGuardianSafe:
		return readOnly("safe_mode")
	}
	return nil
}

// acceptsReports is nil when report writes (cmdOpts.report) are allowed: in every
// mode but frozen. Safe mode refuses what the user initiates, never what can cost them
// points, and silence during study keeps counting there.
func (e *Engine) acceptsReports() error {
	if e.mode == ModeGuardianFrozen {
		return readOnly("schema_too_new")
	}
	return nil
}

func (e *Engine) isFrozen() bool { return e.mode == ModeGuardianFrozen }

// timeStep is the time-driven part of every turn (§10.1).
func (e *Engine) timeStep() {
	if e.isFrozen() {
		e.frozenStep()
		return
	}
	j := e.det.Tick()
	e.readClocks()
	e.now = e.trustedNowMs()
	if j.Jumped() {
		e.onTickJump(j)
	}
	if j.Suspended {
		e.scheduleCalibration(e.bootNow + calibrateAfterBoot)
		e.enfDirty = true
		// The snapshot is from before the suspend; a crash now must not count the sleep
		// as a stop.
		e.markDirty(true)
	}
	dAwake := min(max(e.awakeNow-e.lastAwake, 0), maxAwakePerTick)
	dBoot := max(e.bootNow-e.lastBoot, 0)
	e.maybeCalibrate()
	e.closeDays(e.now)
	e.applyPendingSettings(dBoot.Milliseconds())
	e.expireAllowances(e.now)
	e.creditBlocks(e.prevT, e.now, dAwake.Milliseconds())
	e.completeBlocks(e.now)
	e.activateSchedules(e.now)
	e.studyStep(dAwake.Milliseconds(), e.now)
	e.emergencyStep()
	e.pruneHistory(e.now)
	e.prevT, e.lastAwake, e.lastBoot = e.now, e.awakeNow, e.bootNow
	e.markDirty(false)
}

// readClocks samples the boot and awake clocks and the wall clock.
func (e *Engine) readClocks() {
	e.bootNow = e.o.Clock.Boot()
	e.awakeNow = e.o.Clock.Awake()
	e.lastWall = e.o.Clock.Wall()
}

// trustedNowMs is the trusted time T in Unix milliseconds.
func (e *Engine) trustedNowMs() int64 { return e.det.EffectiveNow().UnixMilli() }

// wallOffsetMs is W in milliseconds.
func (e *Engine) wallOffsetMs() int64 { return e.det.WallOffset().Milliseconds() }

// display converts a trusted time to display time (§4).
func (e *Engine) display(ms int64) string { return fmtMs(ms + e.wallOffsetMs()) }

// displayPtr converts an optional trusted time.
func (e *Engine) displayPtr(ms *int64) *string {
	if ms == nil {
		return nil
	}
	s := e.display(*ms)
	return &s
}

// serverNow is the guardian's wall clock when it answers (§4).
func (e *Engine) serverNow() string { return fmtTime(e.o.Clock.Wall()) }

// commit appends a batch and applies it (§11.3 steps 3–6). On a store failure nothing
// is applied and the error is the 503 read_only answer.
//
// run/clock.json is written first, at the log position the batch will end at: the
// clock snapshot is never older than the log, whenever the guardian stops, so at the
// next start a snapshot older than the log can only be an old copy put back or the
// result of a failed write (restoreClock), and a calibration correction in the batch is
// already in it.
//
// While startup evidence is pending (critical.go) it is committed first, and a batch
// never goes ahead of it. The critical batch itself saves the clock snapshot only once
// it is in the log: a failed append must leave the snapshot that measures the stop.
func (e *Engine) commit(b *batch) error {
	if b.empty() {
		return nil
	}
	if len(e.critical) > 0 && !e.flushingCritical {
		if err := e.flushCritical(); err != nil {
			return err
		}
		b = e.rebatch(b)
	}
	if !e.flushingCritical {
		if err := e.saveClock(e.st.LastSeq()+int64(len(b.events)), false); err != nil {
			e.countError("clock_save")
			e.log.Warn("clock snapshot save failed", "err", err)
		}
	}
	out, err := e.st.AppendBatch(b.events)
	if err != nil {
		e.countError("store_append")
		if store.ReadOnlyReason(err) == store.ReasonDiskFull {
			e.diskFull = true
		}
		e.log.Error("event append failed", "err", err, "events", len(b.events))
		return storeWriteErr(err)
	}
	e.diskFull = false
	if e.flushingCritical {
		if err := e.saveClock(e.st.LastSeq(), false); err != nil {
			e.countError("clock_save")
			e.log.Warn("clock snapshot save failed", "err", err)
		}
	}
	for i := range out {
		if aerr := e.applyEvent(&out[i]); aerr != nil {
			e.log.Error("applying a committed event failed", "seq", out[i].Seq, "type", out[i].Type, "err", aerr)
		}
	}
	e.eventsNotify.broadcast()
	e.bumpState()
	e.markDirty(true)
	e.reconcile() // §11.3 step 5, before the anchor (6) and the response (7)
	if b.anchorNow {
		e.putAnchor()
	}
	return nil
}

// commitNow commits a batch built outside a command (time-driven), logging failures.
func (e *Engine) commitNow(b *batch, what string) bool {
	if err := e.commit(b); err != nil {
		e.log.Warn("time-driven batch not committed; retrying later", "what", what, "err", err)
		return false
	}
	return true
}

// bumpState increases stateVersion (§8.5).
func (e *Engine) bumpState() { e.state.Versions.State++ }

// bumpExtRules increases extRulesVersion and wakes the rules long polls (§10.10).
func (e *Engine) bumpExtRules() {
	e.state.Versions.ExtRules++
	e.rulesNotify.broadcast()
}

// markDirty schedules a state.json write: urgent after a commit (≤ 1 s, done at the
// end of the turn), otherwise within saveEvery.
func (e *Engine) markDirty(urgent bool) {
	e.dirty = true
	if urgent {
		e.urgent = true
	}
}

// persistIfDue writes state.json (and the clock snapshot) when due (§11.3 step 8).
func (e *Engine) persistIfDue() {
	if e.isFrozen() || !e.dirty || e.criticalHeld() {
		return
	}
	if !e.urgent && e.bootNow-e.lastSave < saveEvery {
		return
	}
	// The clock snapshot is the last trace of this run (restoreClock): kept fresh even
	// while state.json cannot be written.
	serr := e.saveState()
	if err := e.saveClock(e.st.LastSeq(), false); err != nil {
		e.log.Warn("clock snapshot save failed", "err", err)
	}
	if serr != nil {
		e.log.Warn("state save failed", "err", serr)
		e.countError("state_save")
	}
}

// countError records an error code for diagnostics (codes only).
func (e *Engine) countError(code string) {
	d := e.errCounts[code]
	if d == nil {
		d = &DiagnosticsError{Code: code}
		e.errCounts[code] = d
	}
	d.Count++
	d.LastAt = e.display(e.now)
}

// String describes the engine for logs.
func (e *Engine) String() string {
	return fmt.Sprintf("engine(%s, mode %s)", e.platform, e.mode)
}
