// Package daemon assembles the running guardian (docs/ARCHITECTURE.md §1, §10.12, §13):
// the engine with the real OS implementations (trusted clock sources, the hosts file at
// platform.HostsPath(), the process watcher, network time), the HTTP API opened only
// after the startup ladder reconciled enforcement, and the clean and OS-shutdown stops.
//
// cmd/centrate-guardian runs a Runner as its svc.Runner; the integration tests run the
// very same code on temporary directories with the engine's fakes injected through
// Options. New never touches the system: everything happens in Start.
//
// Builds with the testhooks tag (never shipped) run on an engine.FakeClock persisted in
// the data directory, so POST /v1/_test/clock drives the real binary's time across
// restarts (fakeclock.go).
package daemon

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"path/filepath"
	"sync"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/api"
	"github.com/imdlodoem23/centrate/guardian/internal/awake"
	"github.com/imdlodoem23/centrate/guardian/internal/engine"
	"github.com/imdlodoem23/centrate/guardian/internal/hosts"
	"github.com/imdlodoem23/centrate/guardian/internal/nuclear"
	"github.com/imdlodoem23/centrate/guardian/internal/platform"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
	"github.com/imdlodoem23/centrate/guardian/internal/version"
)

// plannedStopShutdown is the planned-stop reason of an OS shutdown (§13).
const plannedStopShutdown = "shutdown"

// Options configures a Runner. Zero values select the real implementations; tests
// inject the engine's fakes (docs/ARCHITECTURE.md §15).
type Options struct {
	// DataDir is the system data directory (§11.1). Default platform.DataDir(), which
	// honours CENTRATE_DATA_DIR in tests and unelevated or development builds.
	DataDir string
	// HostsPath is the hosts file. Default platform.HostsPath() (CENTRATE_HOSTS_PATH),
	// followed while the guardian runs: on Windows the hosts.Manager re-reads the
	// DataBasePath registry value every hosts.DefaultResolveEvery and moves to the file
	// the resolver reads (§10.10). An explicit HostsPath is never re-resolved. The
	// system DNS cache is flushed only while the file is the system hosts file.
	HostsPath string
	// Config is config.json; nil loads it from DataDir (invalid values are logged and
	// replaced by their defaults).
	Config *api.Config
	// Logger receives operational logs (never personal data). Nil discards them.
	Logger *slog.Logger
	// PurgeLogs deletes the guardian's log files; data deletion calls it (§10.11 step
	// 3). Nil keeps the logs.
	PurgeLogs func() error
	// Version is the guardian version. Default version.Version.
	Version string
	// ServiceManager names the service manager for diagnostics ("linux-systemd",
	// "interactive"…).
	ServiceManager string

	// Clock reads the machine's clocks. Default engine.SystemClock{}; testhooks builds
	// default to a FakeClock persisted in DataDir.
	Clock engine.Clock
	// NetworkTime is the calibration source. Default clock.NetworkTime (a FakeNetworkTime
	// answering the fake clock's real time when the fake clock is the default).
	NetworkTime engine.NetworkTime
	// Hosts is the hosts layer. Default a hosts.Manager on HostsPath with its backups in
	// DataDir/backups.
	Hosts engine.HostsManager
	// DNS flushes the resolver cache. Default the system flusher for the system hosts
	// file, nothing for any other file.
	DNS engine.DNSFlusher
	// ProcessLister and ProcessKiller drive the process watcher. Default the OS ones.
	ProcessLister engine.ProcessLister
	ProcessKiller engine.ProcessKiller
	// Nuclear relaunches the app during a Nuclear punishment. Default the OS relauncher
	// (internal/nuclear) for config.json appPath; nothing when appPath is empty.
	Nuclear engine.NuclearRelauncher
	// LogonBoot returns the boot-clock reading of the last interactive logon (process
	// logon grace, §10.8); nil: no logon grace.
	LogonBoot func() (time.Duration, bool)
	// Anchor is the rollback anchor. Nil selects the store default (the OS anchor, or a
	// file next to CENTRATE_DATA_DIR). Test binaries must set it.
	Anchor store.AnchorStore
	// Peers resolves loopback peers for the API. Default the OS resolver.
	Peers api.PeerResolver
	// Listen opens the API listener. Default TCP on 127.0.0.1:<config.json port>.
	Listen func(ctx context.Context, addr string) (net.Listener, error)
	// DetectTimezone returns the OS IANA zone written at first start. Default the
	// engine's detector.
	DetectTimezone func() string
	// DisableWatchers keeps the hosts and process watchers from running (tests).
	DisableWatchers bool
	// ShuttingDown reports, when the service is stopped, whether the OS is shutting
	// down: Unix service managers stop services with the same signal for a shutdown and
	// for a plain stop (§13). Default SystemShuttingDown.
	ShuttingDown func() bool
	// NewInhibitor creates the keep-awake inhibitor (§10.14). Default the OS mechanism
	// (awake.New); testhooks builds default to an awake.Fake, so end-to-end runs never
	// keep the test machine awake.
	NewInhibitor func(onChange func()) awake.Inhibitor
	// OnFatal is called once when the guardian cannot start (the startup ladder
	// failed). The binary exits so the service manager restarts it (≥ 3 unclean starts
	// in 5 minutes lead to safe mode, §10.12). Default: only logged.
	OnFatal func(error)

	// followHosts: HostsPath was defaulted, so the hosts file is resolved again while
	// running (set by withDefaults).
	followHosts bool
}

// Runner is the running guardian: it implements svc.Runner and svc.ShutdownRunner.
type Runner struct {
	o Options

	mu      sync.Mutex
	started bool
	stopped bool
	cancel  context.CancelFunc
	eng     *engine.Engine
	srv     *api.Server
	fake    *fakeClock
	// up is closed once the API server was started; done once the bring-up goroutine
	// ended (with or without starting it); failed is the startup error, if any.
	up     chan struct{}
	done   chan struct{}
	failed error
}

// New prepares a Runner without touching the system (svc.NewRunner's contract): no
// file is read, no lock taken and no socket bound before Start.
func New(o Options) *Runner {
	return &Runner{o: o, up: make(chan struct{}), done: make(chan struct{})}
}

// withDefaults fills the zero Options (paths only: the rest needs the data directory).
func (o Options) withDefaults() Options {
	if o.DataDir == "" {
		o.DataDir = platform.DataDir()
	}
	if o.HostsPath == "" {
		o.HostsPath = platform.HostsPath()
		o.followHosts = true
	}
	if o.Logger == nil {
		o.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if o.PurgeLogs != nil {
		o.Logger = slog.New(purgeHandler{Handler: o.Logger.Handler(), purge: o.PurgeLogs})
	}
	if o.Version == "" {
		o.Version = version.Version
	}
	if o.ShuttingDown == nil {
		o.ShuttingDown = SystemShuttingDown
	}
	return o
}

// hostsManager is the default hosts layer's Manager: HostsPath with its backups in
// DataDir/backups. A defaulted HostsPath is resolved again every
// hosts.DefaultResolveEvery (platform.HostsPath follows the Windows DataBasePath value),
// so the guardian writes the file the resolver reads, not the one it read at start.
func (o Options) hostsManager() *hosts.Manager {
	m := &hosts.Manager{Path: o.HostsPath, BackupDir: filepath.Join(o.DataDir, "backups"), Logger: o.Logger}
	if o.followHosts {
		m.Resolve = platform.HostsPath
	}
	return m
}

// currentHostsPath returns the hosts file the layer h writes now: its CurrentPath when
// it has one (hosts.Manager), else the fixed path.
func currentHostsPath(h engine.HostsManager, path string) func() string {
	if c, ok := h.(interface{ CurrentPath() string }); ok {
		return c.CurrentPath
	}
	return func() string { return path }
}

// Start implements svc.Runner. It returns at once: the startup ladder (§10.12) runs in
// the background, and the API is opened only once it reconciled enforcement (step
// 11-12). A failed ladder is logged and reported to OnFatal; the API is never opened
// then.
func (r *Runner) Start(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.started || r.stopped {
		return errors.New("daemon: already started or stopped")
	}
	o := r.o.withDefaults()
	r.o = o
	log := o.Logger

	cfg := api.DefaultConfig()
	if o.Config != nil {
		cfg = *o.Config
	} else {
		c, err := api.LoadConfig(o.DataDir)
		if err != nil {
			log.Warn("guardian config unreadable or invalid; defaults used", "err", err)
		}
		cfg = c
	}

	clk, netTime := o.Clock, o.NetworkTime
	if clk == nil && api.TestHooksEnabled() {
		fc, err := openFakeClock(filepath.Join(o.DataDir, fakeClockFileName), time.Now())
		if err != nil {
			return fmt.Errorf("daemon: test clock: %w", err)
		}
		r.fake = fc
		clk = fc.clock
		if netTime == nil {
			netTime = engine.NewFakeNetworkTime(fc.clock.Real)
		}
		log.Warn("testhooks build: the guardian runs on a fake clock driven by POST /v1/_test/clock")
	}
	hl := o.Hosts
	if hl == nil {
		hl = &hostsLayer{Manager: o.hostsManager()}
	}
	dns := o.DNS
	if dns == nil {
		dns = defaultFlusher(currentHostsPath(hl, o.HostsPath), log)
	}
	newInhibitor := o.NewInhibitor
	if newInhibitor == nil && api.TestHooksEnabled() {
		newInhibitor = func(onChange func()) awake.Inhibitor { return awake.NewFake(onChange) }
	}
	nuc := o.Nuclear
	if nuc == nil {
		// The app config.json names is the only one relaunched (§10.5); without it the
		// supervisor relies on the overlay heartbeat and cannot bring the app back.
		if rl := nuclear.New(cfg.AppPath); rl != nil {
			nuc = rl
		}
	}

	eng, err := engine.New(engine.Options{
		DataDir:         o.DataDir,
		Clock:           clk,
		Hosts:           hl,
		DNS:             dns,
		NetworkTime:     netTime,
		Nuclear:         nuc,
		ProcessLister:   o.ProcessLister,
		ProcessKiller:   o.ProcessKiller,
		Anchor:          o.Anchor,
		Logger:          log,
		Version:         o.Version,
		Port:            cfg.Port,
		ServiceManager:  o.ServiceManager,
		TestHooks:       api.TestHooksEnabled(),
		LogonBoot:       o.LogonBoot,
		HostsPath:       o.HostsPath,
		DetectTimezone:  o.DetectTimezone,
		DisableWatchers: o.DisableWatchers,
		NewInhibitor:    newInhibitor,
	})
	if err != nil {
		return fmt.Errorf("daemon: engine: %w", err)
	}
	var apiEng api.Engine = eng
	if r.fake != nil {
		apiEng = testClockEngine{Engine: eng, save: r.saveFakeClock}
	}
	srv, err := api.New(api.Options{
		Engine:  apiEng,
		DataDir: o.DataDir,
		Config:  &cfg,
		Version: o.Version,
		Logger:  log,
		Peers:   o.Peers,
		Listen:  o.Listen,
	})
	if err != nil {
		return fmt.Errorf("daemon: api: %w", err)
	}
	runCtx, cancel := context.WithCancel(ctx)
	if err := eng.Start(runCtx); err != nil {
		cancel()
		return fmt.Errorf("daemon: engine start: %w", err)
	}
	r.started, r.cancel, r.eng, r.srv = true, cancel, eng, srv
	go r.bringUp(runCtx)
	return nil
}

// bringUp waits for the startup ladder and opens the API (§10.12 steps 11-12).
func (r *Runner) bringUp(ctx context.Context) {
	defer close(r.done)
	select {
	case <-r.eng.Ready():
	case <-ctx.Done():
		return
	}
	if err := r.eng.OpenErr(); err != nil {
		r.mu.Lock()
		r.failed = err
		stopped := r.stopped
		r.mu.Unlock()
		if stopped {
			return
		}
		r.o.Logger.Error("guardian startup failed", "err", err)
		if r.o.OnFatal != nil {
			r.o.OnFatal(err)
		}
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped {
		return
	}
	// The data folder exists now and the ladder is done with its stale temporary files.
	r.saveFakeClockLocked()
	if err := r.srv.Start(ctx); err != nil {
		// Only a second Start fails; the port being taken is retried by the server.
		r.failed = err
		r.o.Logger.Error("guardian API did not start", "err", err)
		return
	}
	close(r.up)
}

// Stop implements svc.Runner: the API first (in-flight requests get their grace), then
// the engine's clean shutdown (§13: state, clock snapshot, clean-shutdown marker, lock
// released). When the OS is shutting down it writes the planned-stop marker first, like
// Shutdown. It never touches the hosts section.
func (r *Runner) Stop() error {
	r.mu.Lock()
	f := r.o.ShuttingDown
	r.mu.Unlock()
	return r.stop(context.Background(), f != nil && f())
}

// Shutdown implements svc.ShutdownRunner (Windows SERVICE_CONTROL_SHUTDOWN): the
// planned-stop marker, so the next start in the same boot is never priced as a stop
// during a block (§10.12 step 9), then the engine's clean stop and the API.
func (r *Runner) Shutdown(ctx context.Context) error {
	return r.stop(ctx, true)
}

func (r *Runner) stop(ctx context.Context, osShutdown bool) error {
	r.mu.Lock()
	if !r.started || r.stopped {
		r.stopped = true
		r.mu.Unlock()
		return nil
	}
	r.stopped = true
	eng, srv, cancel := r.eng, r.srv, r.cancel
	r.mu.Unlock()

	var errs []error
	if osShutdown {
		// The marker matters most and the OS gives little time: the engine writes it
		// before anything else, then stops; open requests just get 503 stopping.
		r.o.Logger.Info("stopping for an OS shutdown; writing the planned-stop marker")
		if err := eng.Shutdown(ctx); err != nil {
			errs = append(errs, err)
		}
		if err := srv.Stop(); err != nil {
			errs = append(errs, err)
		}
	} else {
		if err := srv.Stop(); err != nil {
			errs = append(errs, err)
		}
		if err := eng.Stop(); err != nil {
			errs = append(errs, err)
		}
	}
	cancel()
	<-r.done
	r.mu.Lock()
	r.saveFakeClockLocked()
	r.mu.Unlock()
	return errors.Join(errs...)
}

// WaitBound waits until the API listens. It returns the startup error instead when the
// guardian could not start, or ctx's error.
func (r *Runner) WaitBound(ctx context.Context) error {
	select {
	case <-r.up:
	case <-r.done:
		select {
		case <-r.up:
		default:
			r.mu.Lock()
			err := r.failed
			r.mu.Unlock()
			if err == nil {
				err = errors.New("daemon: stopped before the API opened")
			}
			return err
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-r.Server().Bound():
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Engine is the running engine (nil before Start).
func (r *Runner) Engine() *engine.Engine {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.eng
}

// Server is the API server (nil before Start).
func (r *Runner) Server() *api.Server {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.srv
}

// Addr is the API's bound address (nil before it binds).
func (r *Runner) Addr() net.Addr {
	if srv := r.Server(); srv != nil {
		return srv.Addr()
	}
	return nil
}

// saveFakeClock persists the testhooks fake clock (after every POST /v1/_test/clock).
func (r *Runner) saveFakeClock() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.saveFakeClockLocked()
}

func (r *Runner) saveFakeClockLocked() {
	if r.fake == nil {
		return
	}
	if err := r.fake.save(); err != nil {
		r.o.Logger.Warn("test clock not saved", "err", err)
	}
}

// testClockEngine is the engine as the API of a testhooks build sees it: every
// POST /v1/_test/clock also persists the fake clock, so a restarted guardian resumes
// the test's time instead of today's.
type testClockEngine struct {
	*engine.Engine
	save func()
}

// TestClock implements api.TestClocker.
func (t testClockEngine) TestClock(ctx context.Context, req engine.TestClockRequest) (engine.TestClockResponse, error) {
	res, err := t.Engine.TestClock(ctx, req)
	t.save()
	return res, err
}

var _ api.TestClocker = testClockEngine{}
