// Package svc registers and runs the guardian as a system service with
// kardianos/service, adding what that library does not do on its own:
//
//   - Windows: automatic start (not delayed) and recovery actions (restart
//     after 5 s, 10 s and 30 s; the SCM repeats the last action for every
//     later failure, so it keeps restarting every 30 s; the count resets after
//     a day without failures) set through x/sys/windows/svc/mgr; idempotent
//     install (updates an existing registration in place) that refuses a
//     binary in a folder normal users can write, waits for a registration
//     still marked for deletion and checks that the service reaches RUNNING;
//     stop waits for the service process to exit; status needs no
//     administrator rights.
//   - macOS: a LaunchDaemon (KeepAlive, RunAtLoad, ThrottleInterval 5) that
//     runs a copy of the binary in /Library/PrivilegedHelperTools, so the app
//     bundle can move. Install, start and restart clear launchd's "disabled"
//     override first.
//   - Linux: a systemd unit with Restart=always and RestartSec=2. The unit runs
//     the binary in place only when root owns it and every folder above it and
//     none is writable by group or others; otherwise install copies it to a
//     root-only location.
//
// An explicit stop always ends with exit code 0, so failure recovery only
// applies to crashes and start failures. A stop that is part of an OS
// shutdown (Windows SERVICE_CONTROL_SHUTDOWN; systemd reporting the system
// as stopping) goes to ShutdownRunner.Shutdown, which writes the planned-stop
// marker. Installers and updaters stop the service with StopPlanned (or call
// WritePlannedStop first), so a stop to replace the files is not penalized
// (docs/ARCHITECTURE.md §10.12 step 9, §13). CheckActive answers has-active
// with exit code 0, 10 or 11 (HasActiveLevel). Every command it runs is a
// fixed binary with fixed arguments; nothing is built from external data.
package svc

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/kardianos/service"
)

const (
	// Name is the service name on Windows and Linux (systemd unit CentrateGuardian.service).
	Name = "CentrateGuardian"
	// DisplayName is the human name shown by the service manager.
	DisplayName = "Céntrate Guardian"
	// Description is shown by the service manager (Spanish, user-facing).
	Description = "Mantiene activos los bloqueos de Céntrate hasta que terminan, aunque la app esté cerrada. Solo escucha en 127.0.0.1."
	// AppBundleID is the desktop app's bundle identifier. macOS 13+ lists the
	// LaunchDaemon under it in Login Items.
	AppBundleID = "io.github.imdlodoem23.centrate"
	// LaunchdLabel is the macOS LaunchDaemon label (and plist name).
	LaunchdLabel = "io.github.imdlodoem23.centrate.guardian"
	// DarwinHelperPath is where install copies the binary on macOS.
	DarwinHelperPath = "/Library/PrivilegedHelperTools/" + LaunchdLabel
	// DarwinPlistPath is the LaunchDaemon definition written on macOS.
	DarwinPlistPath = "/Library/LaunchDaemons/" + LaunchdLabel + ".plist"
	// DarwinStderrLog receives the daemon's stderr (Go panics only; the real
	// log is logx's). It lives in /var/log, which always exists, so launchd can
	// always spawn the job.
	DarwinStderrLog = "/var/log/" + LaunchdLabel + ".err.log"
	// DarwinNewsyslogPath rotates DarwinStderrLog.
	DarwinNewsyslogPath = "/etc/newsyslog.d/" + LaunchdLabel + ".conf"
	// LinuxStablePath is where install copies the binary on Linux when it runs
	// from a location that is not root-only (an AppImage mount, a temp dir, a
	// home folder).
	LinuxStablePath = "/usr/local/lib/centrate/centrate-guardian"
	// LinuxFallbackPath is used instead of LinuxStablePath when /usr/local is
	// read-only (image-based distributions) or writable by non-root users.
	LinuxFallbackPath = "/var/lib/centrate-guardian/centrate-guardian"
	// SystemdUnitPath is the unit file written on Linux with systemd.
	SystemdUnitPath = "/etc/systemd/system/" + Name + ".service"
	// RunArg is the subcommand the service manager passes to the binary.
	RunArg = "run"

	// StopTimeout bounds Runner.Stop after an explicit stop. Past it the
	// service reports stopped anyway and the process exits.
	StopTimeout = 10 * time.Second
	// ShutdownTimeout bounds the Runner's work when the computer shuts down
	// (Windows gives services about 5 s in total).
	ShutdownTimeout = 3 * time.Second
)

var (
	// ErrNotInstalled is returned by Start, Stop and Restart when the service
	// is not registered with the service manager.
	ErrNotInstalled = errors.New("svc: the guardian service is not installed")
	// ErrMarkedForDeletion is returned by Install on Windows when a previous
	// registration is still marked for deletion (a Services console or another
	// handle keeps it alive) after waiting for it to go away.
	ErrMarkedForDeletion = errors.New("svc: the previous service registration is still marked for deletion")
	// ErrDisabledByUser is returned on macOS when launchd keeps the job
	// disabled (switched off in System Settings > General > Login Items).
	ErrDisabledByUser = errors.New("svc: the guardian is disabled in Login Items")
	// ErrUntrustedExecutable is returned by Install when the binary lives
	// where a non-administrator could replace it, and it cannot be copied to a
	// protected location.
	ErrUntrustedExecutable = errors.New("svc: the guardian binary is in a folder other users can modify")
)

// Status is the service state reported by Manager.Status.
type Status struct {
	Installed bool `json:"installed"`
	Running   bool `json:"running"`
}

// Runner is the guardian's work, implemented by the engine.
//
// Start launches the background work and must return within a few seconds
// (the service manager waits for it). ctx is cancelled when the service stops.
// Stop must wait for the background work to finish; it is called at most once
// after a successful Start and is given StopTimeout, after which the process
// exits anyway. Stopping must never remove the hosts section.
type Runner interface {
	Start(ctx context.Context) error
	Stop() error
}

// ShutdownRunner is a Runner that handles a system shutdown differently from
// an explicit stop (Windows only; Unix service managers send the same signal
// for both). Shutdown must only persist what the next boot needs, finish
// before ctx's deadline (ShutdownTimeout) and never touch the hosts file.
// Runners without it get Stop, bounded by ShutdownTimeout.
type ShutdownRunner interface {
	Runner
	Shutdown(ctx context.Context) error
}

// Options configures New.
type Options struct {
	// Runner is what Run executes. Nil selects NewRunner(Logger), built only
	// when the service actually starts.
	Runner Runner
	// Logger receives lifecycle messages. Nil discards them.
	Logger *slog.Logger
	// Executable overrides the binary to register (default: the running one,
	// symlinks resolved). On macOS and for untrusted Linux paths it is the
	// source that install copies to a stable location.
	Executable string
}

// Manager installs, controls and runs the guardian service.
type Manager struct {
	logger    *slog.Logger
	sourceExe string // binary being run or given in Options
	cfg       *service.Config
	svc       service.Service
}

// Interactive reports whether the process was started from a terminal rather
// than by the service manager.
func Interactive() bool {
	return service.Interactive()
}

// ServiceID returns the name the OS service manager knows the guardian by:
// LaunchdLabel on macOS, Name elsewhere.
func ServiceID() string {
	return serviceID()
}

// New prepares a Manager. It does not change the system, and it does not
// build the Runner: control commands (status, stop, install…) never construct
// the engine.
func New(opts Options) (*Manager, error) {
	logger := opts.Logger
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	newRunner := func() Runner { return NewRunner(logger) }
	if opts.Runner != nil {
		r := opts.Runner
		newRunner = func() Runner { return r }
	}
	src := opts.Executable
	if src == "" {
		var err error
		if src, err = currentExecutable(); err != nil {
			return nil, err
		}
	}
	cfg := newConfig(registeredExecutable(src))
	s, err := service.New(newProgram(newRunner, logger), cfg)
	if err != nil {
		return nil, fmt.Errorf("svc: %w", err)
	}
	return &Manager{logger: logger, sourceExe: src, cfg: cfg, svc: s}, nil
}

// Executable returns the path the service manager starts.
func (m *Manager) Executable() string {
	return m.cfg.Executable
}

// Run hands control to the service manager (or waits for Ctrl+C when
// interactive), calling the Runner's Start and Stop. It blocks until stopped.
func (m *Manager) Run() error {
	return m.svc.Run()
}

// Install registers the service or updates an existing registration (binary
// path, start mode, recovery), then starts or restarts it. Running it twice is
// safe. It needs administrator rights.
func (m *Manager) Install() error {
	if err := m.install(); err != nil {
		return fmt.Errorf("svc: install: %w", err)
	}
	m.logger.Info("service installed", "platform", m.svc.Platform())
	return nil
}

// Uninstall stops the service and removes its registration and any binary
// copy made by Install. It succeeds when nothing is installed. It does not
// touch the hosts file or the data directory.
func (m *Manager) Uninstall() error {
	if err := m.uninstall(); err != nil {
		return fmt.Errorf("svc: uninstall: %w", err)
	}
	m.logger.Info("service uninstalled")
	return nil
}

// Start starts the installed service; starting a running service is a no-op.
func (m *Manager) Start() error {
	return wrap("start", m.start())
}

// Stop stops the service and waits for it; stopping a stopped service is a no-op.
func (m *Manager) Stop() error {
	return wrap("stop", m.stop())
}

// Restart stops (if running) and starts the service.
func (m *Manager) Restart() error {
	return wrap("restart", m.restart())
}

// Status reports whether the service is installed and running. It works
// without administrator rights.
func (m *Manager) Status() (Status, error) {
	st, err := m.status()
	if err != nil {
		return Status{}, fmt.Errorf("svc: status: %w", err)
	}
	return st, nil
}

func wrap(op string, err error) error {
	if err == nil || errors.Is(err, ErrNotInstalled) {
		return err
	}
	return fmt.Errorf("svc: %s: %w", op, err)
}

func newConfig(exe string) *service.Config {
	return &service.Config{
		Name:        serviceID(),
		DisplayName: DisplayName,
		Description: Description,
		Arguments:   []string{RunArg},
		Executable:  exe,
		Option:      platformOptions(),
	}
}

// program adapts a Runner to kardianos' service.Interface (and Shutdowner).
type program struct {
	newRunner       func() Runner
	logger          *slog.Logger
	stopTimeout     time.Duration
	shutdownTimeout time.Duration
	// stopping reports whether a stop is part of an OS shutdown (systemd).
	stopping func() bool

	mu     sync.Mutex
	runner Runner
	cancel context.CancelFunc
}

func newProgram(newRunner func() Runner, logger *slog.Logger) *program {
	return &program{
		newRunner:       newRunner,
		logger:          logger,
		stopTimeout:     StopTimeout,
		shutdownTimeout: ShutdownTimeout,
		stopping:        systemStopping,
	}
}

// Start builds the Runner (once) and starts it. An error makes the service
// fail to start, which the service manager's recovery handles.
func (p *program) Start(service.Service) error {
	p.mu.Lock()
	if p.runner == nil {
		p.runner = p.newRunner()
	}
	r := p.runner
	p.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	if err := r.Start(ctx); err != nil {
		cancel()
		p.logger.Error("runner failed to start", "err", err)
		return err
	}
	p.mu.Lock()
	p.cancel = cancel
	p.mu.Unlock()
	p.logger.Info("runner started")
	return nil
}

// Stop cancels the Runner's context and waits up to stopTimeout for its Stop.
// When the stop is part of an OS shutdown (systemd reports the system as
// stopping; Windows calls Shutdown instead) a ShutdownRunner gets Shutdown,
// which writes the planned-stop marker first (docs/ARCHITECTURE.md §13).
// It always returns nil: an error would make the service exit with a failure
// code, and Windows would then "recover" an intentional stop by restarting
// the guardian (during an update, while its files are being replaced).
func (p *program) Stop(service.Service) error {
	r, cancel := p.take()
	if cancel == nil {
		return nil
	}
	cancel()
	op, fn := "stop", func(context.Context) error { return r.Stop() }
	if sr, ok := r.(ShutdownRunner); ok && p.stopping != nil && p.stopping() {
		op, fn = "shutdown", sr.Shutdown
	}
	p.bounded(op, p.stopTimeout, fn)
	return nil
}

// Shutdown is called instead of Stop when Windows shuts down. It gives the
// Runner shutdownTimeout (ShutdownRunner.Shutdown if implemented, else Stop)
// and always returns nil.
func (p *program) Shutdown(service.Service) error {
	r, cancel := p.take()
	if cancel == nil {
		return nil
	}
	cancel()
	fn := func(context.Context) error { return r.Stop() }
	if sr, ok := r.(ShutdownRunner); ok {
		fn = sr.Shutdown
	}
	p.bounded("shutdown", p.shutdownTimeout, fn)
	return nil
}

func (p *program) take() (Runner, context.CancelFunc) {
	p.mu.Lock()
	defer p.mu.Unlock()
	cancel := p.cancel
	p.cancel = nil
	return p.runner, cancel
}

// bounded runs fn with a deadline and logs its outcome. If fn outlives the
// deadline it keeps running in the background while the service exits.
func (p *program) bounded(op string, d time.Duration, fn func(context.Context) error) {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- fn(ctx) }()
	select {
	case err := <-done:
		if err != nil {
			p.logger.Error("runner failed to stop cleanly", "op", op, "err", err)
			return
		}
		p.logger.Info("runner stopped", "op", op)
	case <-ctx.Done():
		p.logger.Error("runner did not stop in time; exiting anyway", "op", op, "timeout", d.String())
	}
}
