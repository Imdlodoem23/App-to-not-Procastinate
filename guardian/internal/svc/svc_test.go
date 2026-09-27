package svc

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

func TestNewConfig(t *testing.T) {
	cfg := newConfig("/opt/centrate/centrate-guardian")
	if cfg.Name != ServiceID() || cfg.DisplayName != DisplayName || cfg.Description != Description {
		t.Fatalf("unexpected identity %+v", cfg)
	}
	if len(cfg.Arguments) != 1 || cfg.Arguments[0] != RunArg {
		t.Fatalf("Arguments = %v, want [run]", cfg.Arguments)
	}
	switch runtime.GOOS {
	case "windows":
		if ServiceID() != "CentrateGuardian" {
			t.Fatalf("ServiceID() = %q", ServiceID())
		}
		if cfg.Option["StartType"] != "automatic" || cfg.Option["DelayedAutoStart"] != false ||
			cfg.Option["OnFailure"] != "restart" || cfg.Option["OnFailureDelayDuration"] != "5s" {
			t.Fatalf("options = %v", cfg.Option)
		}
	case "darwin":
		if ServiceID() != "io.github.imdlodoem23.centrate.guardian" {
			t.Fatalf("ServiceID() = %q", ServiceID())
		}
		if cfg.Option["KeepAlive"] != true || cfg.Option["RunAtLoad"] != true {
			t.Fatalf("options = %v", cfg.Option)
		}
		if cfg.Option["LogDirectory"] != "/var/log" || cfg.Option["LaunchdConfig"] != launchdPlist {
			t.Fatalf("launchd logs must go to /var/log with the custom plist: %v", cfg.Option)
		}
	default:
		if ServiceID() != "CentrateGuardian" {
			t.Fatalf("ServiceID() = %q", ServiceID())
		}
		if cfg.Option["SystemdScript"] != systemdScript {
			t.Fatal("custom systemd unit not configured")
		}
	}
}

func TestSystemdUnit(t *testing.T) {
	for _, want := range []string{
		"Restart=always\n",
		"RestartSec=2\n",
		"WantedBy=multi-user.target\n",
		"StartLimitIntervalSec=0\n",
		"ExecStart={{Path | cmdEscape}}{{range Arguments}} {{. | cmd}}{{end}}\n",
	} {
		if !strings.Contains(systemdScript, want) {
			t.Errorf("systemd unit lacks %q", want)
		}
	}
}

func TestDescriptionIsSpanish(t *testing.T) {
	if !strings.Contains(Description, "bloqueos") || DisplayName != "Céntrate Guardian" {
		t.Fatalf("Description = %q, DisplayName = %q", Description, DisplayName)
	}
	if DarwinHelperPath != "/Library/PrivilegedHelperTools/io.github.imdlodoem23.centrate.guardian" {
		t.Fatalf("DarwinHelperPath = %q", DarwinHelperPath)
	}
}

func TestRegisteredExecutable(t *testing.T) {
	const stable = "/opt/Centrate/resources/guardian/centrate-guardian"
	switch runtime.GOOS {
	case "darwin":
		if got := registeredExecutable(stable); got != DarwinHelperPath {
			t.Fatalf("got %q", got)
		}
	case "windows":
		if got := registeredExecutable(`C:\Program Files\Centrate\guardian.exe`); got != `C:\Program Files\Centrate\guardian.exe` {
			t.Fatalf("got %q", got)
		}
	default:
		// A path that does not exist cannot be proven root-only.
		if got := registeredExecutable(stable); got != LinuxStablePath {
			t.Fatalf("got %q", got)
		}
		if got := registeredExecutable("/tmp/.mount_CentrXYZ/resources/centrate-guardian"); got != LinuxStablePath {
			t.Fatalf("got %q", got)
		}
	}
}

func TestIsEphemeralPath(t *testing.T) {
	cases := map[string]bool{
		"/tmp/.mount_Centr1a2b/resources/guardian/centrate-guardian": true,
		"/home/u/Apps/.mount_x/g":                                    true,
		"/tmp/go-build123/centrate-guardian":                         true,
		"/var/tmp/g":                                                 true,
		"/opt/Céntrate/resources/guardian/centrate-guardian":         false,
		"/usr/local/lib/centrate/centrate-guardian":                  false,
		"/tmpfoo/centrate-guardian":                                  false,
	}
	for in, want := range cases {
		if got := isEphemeralPath(in); got != want {
			t.Errorf("isEphemeralPath(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestLaunchdRunning(t *testing.T) {
	running := "system/io.github.imdlodoem23.centrate.guardian = {\n\tactive count = 1\n\tstate = running\n\n\tprogram = /Library/PrivilegedHelperTools/x\n\tpid = 412\n}\n"
	if !launchdRunning(running) {
		t.Fatal("want running")
	}
	stopped := "system/io.github.imdlodoem23.centrate.guardian = {\n\tstate = not running\n\tlast exit code = 1\n}\n"
	if launchdRunning(stopped) {
		t.Fatal("want not running")
	}
	if launchdRunning("") {
		t.Fatal("empty output must not be running")
	}
}

func TestLaunchdDisabled(t *testing.T) {
	const label = "io.github.imdlodoem23.centrate.guardian"
	modern := "disabled services = {\n\t\"com.apple.ftpd\" => disabled\n\t\"" + label + "\" => disabled\n}\nlogin item associations = {\n}\n"
	if !launchdDisabled(modern, label) {
		t.Fatal("want disabled (macOS 11+ format)")
	}
	if launchdDisabled(strings.Replace(modern, label+"\" => disabled", label+"\" => enabled", 1), label) {
		t.Fatal("want enabled")
	}
	if !launchdDisabled("\t\""+label+"\" => true\n", label) {
		t.Fatal("want disabled (old format)")
	}
	if launchdDisabled("\t\""+label+".other\" => disabled\n", label) || launchdDisabled("", label) {
		t.Fatal("other labels must not match")
	}
}

// renderPlist mimics kardianos' mini template on launchdPlist well enough to
// check that the result is well-formed XML.
func renderPlist(t *testing.T) string {
	t.Helper()
	out := strings.NewReplacer(
		"{{KeepAlive}}", "true",
		"{{RunAtLoad}}", "true",
		"{{Name | html}}", LaunchdLabel,
		"{{Path | html}}", DarwinHelperPath,
		"{{StandardErrorPath | html}}", DarwinStderrLog,
		"{{range Arguments}}", "",
		"{{. | html}}", RunArg,
		"{{end}}", "",
	).Replace(launchdPlist)
	if strings.Contains(out, "{{") {
		t.Fatalf("unhandled template action in %q", out)
	}
	return out
}

func TestLaunchdPlist(t *testing.T) {
	out := renderPlist(t)
	dec := xml.NewDecoder(strings.NewReader(out))
	dec.Strict = true
	for {
		if _, err := dec.Token(); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			t.Fatalf("plist is not well-formed XML: %v\n%s", err, out)
		}
	}
	for _, want := range []string{
		"<key>AssociatedBundleIdentifiers</key>\n\t<array>\n\t\t<string>io.github.imdlodoem23.centrate</string>",
		"<key>StandardOutPath</key>\n\t<string>/dev/null</string>",
		"<key>StandardErrorPath</key>\n\t<string>/var/log/io.github.imdlodoem23.centrate.guardian.err.log</string>",
		"<key>ThrottleInterval</key>\n\t<integer>5</integer>",
		"<key>KeepAlive</key>\n\t<true/>",
		"<string>/Library/PrivilegedHelperTools/io.github.imdlodoem23.centrate.guardian</string>\n\t\t<string>run</string>",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("plist lacks %q", want)
		}
	}
	if !strings.Contains(newsyslogConf, DarwinStderrLog+"  root:wheel") {
		t.Errorf("newsyslog rule = %q", newsyslogConf)
	}
}

func TestInstallExecutableCopiesAtomically(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src-bin")
	if err := os.WriteFile(src, []byte("new binary"), 0o700); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(dir, "PrivilegedHelperTools", "helper")
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, []byte("old binary, longer than the new one"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := installExecutable(src, dst); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new binary" {
		t.Fatalf("dst = %q", got)
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(dst)
		if fi.Mode().Perm() != 0o755 {
			t.Fatalf("mode = %v", fi.Mode().Perm())
		}
	}
	entries, _ := os.ReadDir(filepath.Dir(dst))
	if len(entries) != 1 {
		t.Fatalf("temp files left behind: %v", entries)
	}
	// Copying onto itself is a no-op, and running twice is fine.
	if err := installExecutable(dst, dst); err != nil {
		t.Fatal(err)
	}
	if err := installExecutable(src, dst); err != nil {
		t.Fatal(err)
	}
}

func TestInstallExecutableMissingSource(t *testing.T) {
	dir := t.TempDir()
	if err := installExecutable(filepath.Join(dir, "nope"), filepath.Join(dir, "dst")); err == nil {
		t.Fatal("want error")
	}
	if err := installExecutable(dir, filepath.Join(dir, "dst")); err == nil {
		t.Fatal("want error for a directory source")
	}
}

func TestRemoveFileIgnoresMissing(t *testing.T) {
	if err := removeFile(filepath.Join(t.TempDir(), "missing")); err != nil {
		t.Fatal(err)
	}
}

func TestNewDoesNotTouchSystem(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "centrate-guardian")
	m, err := New(Options{Executable: exe})
	if err != nil {
		t.Fatal(err)
	}
	if m.Executable() == "" {
		t.Fatal("empty executable")
	}
}

// fakeRunner records calls and exposes the context it received.
type fakeRunner struct {
	mu       sync.Mutex
	ctx      context.Context
	startErr error
	stopErr  error
	starts   int
	stops    int
}

func (f *fakeRunner) Start(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts++
	f.ctx = ctx
	return f.startErr
}

func (f *fakeRunner) Stop() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stops++
	return f.stopErr
}

func testProgram(r Runner, logger *slog.Logger) *program {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return newProgram(func() Runner { return r }, logger)
}

func TestProgramStartStop(t *testing.T) {
	r := &fakeRunner{}
	p := testProgram(r, nil)
	if err := p.Start(nil); err != nil {
		t.Fatal(err)
	}
	if r.ctx.Err() != nil {
		t.Fatal("context cancelled too early")
	}
	if err := p.Stop(nil); err != nil {
		t.Fatal(err)
	}
	if r.ctx.Err() == nil {
		t.Fatal("Stop must cancel the runner context")
	}
	if err := p.Stop(nil); err != nil {
		t.Fatal(err)
	}
	if r.starts != 1 || r.stops != 1 {
		t.Fatalf("starts=%d stops=%d", r.starts, r.stops)
	}
}

func TestProgramBuildsRunnerOnceOnStart(t *testing.T) {
	built := 0
	p := newProgram(func() Runner { built++; return &fakeRunner{} }, slog.New(slog.DiscardHandler))
	if built != 0 {
		t.Fatal("the runner must not be built before Start")
	}
	for range 2 {
		if err := p.Start(nil); err != nil {
			t.Fatal(err)
		}
		if err := p.Stop(nil); err != nil {
			t.Fatal(err)
		}
	}
	if built != 1 {
		t.Fatalf("runner built %d times", built)
	}
}

func TestProgramStartError(t *testing.T) {
	boom := errors.New("boom")
	r := &fakeRunner{startErr: boom}
	p := testProgram(r, nil)
	if err := p.Start(nil); !errors.Is(err, boom) {
		t.Fatalf("Start = %v", err)
	}
	if r.ctx.Err() == nil {
		t.Fatal("failed start must cancel its context")
	}
	if err := p.Stop(nil); err != nil {
		t.Fatal(err)
	}
	if r.stops != 0 {
		t.Fatal("Stop must not reach a runner that never started")
	}
}

// A failing Runner.Stop must not turn an explicit stop into a failure exit
// (Windows would "recover" it by restarting the guardian): it is logged.
func TestProgramStopErrorIsLoggedNotReturned(t *testing.T) {
	var out syncBuffer
	p := testProgram(&fakeRunner{stopErr: errors.New("disk full")}, slog.New(slog.NewTextHandler(&out, nil)))
	if err := p.Start(nil); err != nil {
		t.Fatal(err)
	}
	if err := p.Stop(nil); err != nil {
		t.Fatalf("Stop = %v, want nil", err)
	}
	if !strings.Contains(out.String(), "disk full") {
		t.Fatalf("log = %q", out.String())
	}
}

// blockingRunner never finishes stopping until released.
type blockingRunner struct {
	fakeRunner
	release chan struct{}
}

func (b *blockingRunner) Stop() error {
	<-b.release
	return nil
}

func TestProgramStopIsBounded(t *testing.T) {
	var out syncBuffer
	r := &blockingRunner{release: make(chan struct{})}
	defer close(r.release)
	p := testProgram(r, slog.New(slog.NewTextHandler(&out, nil)))
	p.stopTimeout = 20 * time.Millisecond
	if err := p.Start(nil); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- p.Stop(nil) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Stop did not return after its timeout")
	}
	if !strings.Contains(out.String(), "did not stop in time") {
		t.Fatalf("log = %q", out.String())
	}
}

// shutdownRunner records how it was stopped.
type shutdownRunner struct {
	fakeRunner
	deadline time.Duration
	shutdown int
}

func (s *shutdownRunner) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.shutdown++
	if d, ok := ctx.Deadline(); ok {
		s.deadline = time.Until(d)
	}
	return nil
}

func TestProgramShutdownUsesShutdownRunner(t *testing.T) {
	r := &shutdownRunner{}
	p := testProgram(r, nil)
	if err := p.Start(nil); err != nil {
		t.Fatal(err)
	}
	if err := p.Shutdown(nil); err != nil {
		t.Fatal(err)
	}
	if r.shutdown != 1 || r.stops != 0 {
		t.Fatalf("shutdown=%d stops=%d", r.shutdown, r.stops)
	}
	if r.deadline <= 0 || r.deadline > ShutdownTimeout {
		t.Fatalf("shutdown deadline = %v, want within %v", r.deadline, ShutdownTimeout)
	}
	if r.ctx.Err() == nil {
		t.Fatal("Shutdown must cancel the runner context")
	}
	if err := p.Stop(nil); err != nil || r.stops != 0 {
		t.Fatalf("Stop after Shutdown: err=%v stops=%d", err, r.stops)
	}
}

func TestProgramShutdownFallsBackToStop(t *testing.T) {
	r := &fakeRunner{}
	p := testProgram(r, nil)
	if err := p.Start(nil); err != nil {
		t.Fatal(err)
	}
	if err := p.Shutdown(nil); err != nil {
		t.Fatal(err)
	}
	if r.stops != 1 {
		t.Fatalf("stops = %d", r.stops)
	}
}

func TestNewDoesNotBuildRunner(t *testing.T) {
	prev := NewRunner
	t.Cleanup(func() { NewRunner = prev })
	built := 0
	NewRunner = func(*slog.Logger) Runner { built++; return &fakeRunner{} }
	if _, err := New(Options{Executable: filepath.Join(t.TempDir(), "centrate-guardian")}); err != nil {
		t.Fatal(err)
	}
	if built != 0 {
		t.Fatal("New must not build the engine runner (control commands would construct it)")
	}
}

// syncBuffer is a goroutine-safe bytes.Buffer for log capture.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestHeartbeatRunner(t *testing.T) {
	var out syncBuffer
	r := NewHeartbeatRunner(slog.New(slog.NewTextHandler(&out, nil)), time.Hour)
	tick := make(chan time.Time)
	stopped := make(chan struct{})
	var gotInterval time.Duration
	r.newTicker = func(d time.Duration) (<-chan time.Time, func()) {
		gotInterval = d
		return tick, func() { close(stopped) }
	}
	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if gotInterval != time.Hour {
		t.Fatalf("interval = %v", gotInterval)
	}
	if err := r.Start(context.Background()); err == nil {
		t.Fatal("second Start must fail")
	}
	tick <- time.Now()
	tick <- time.Now()
	waitFor(t, func() bool { return strings.Count(out.String(), "msg=heartbeat") == 2 })
	if !strings.Contains(out.String(), "n=2") {
		t.Fatalf("log = %q", out.String())
	}
	if err := r.Stop(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stopped:
	default:
		t.Fatal("ticker not stopped")
	}
	if err := r.Stop(); err != nil {
		t.Fatalf("second Stop: %v", err)
	}
}

func TestHeartbeatRunnerStopsWithContext(t *testing.T) {
	r := NewHeartbeatRunner(nil, 0)
	if r.interval != HeartbeatInterval {
		t.Fatalf("default interval = %v", r.interval)
	}
	stopped := make(chan struct{})
	r.newTicker = func(time.Duration) (<-chan time.Time, func()) {
		return make(chan time.Time), func() { close(stopped) }
	}
	ctx, cancel := context.WithCancel(context.Background())
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("loop did not exit on context cancel")
	}
	if err := r.Stop(); err != nil {
		t.Fatal(err)
	}
}

func TestStopWithoutStart(t *testing.T) {
	if err := NewHeartbeatRunner(nil, time.Second).Stop(); err != nil {
		t.Fatal(err)
	}
}

func TestCleanupHookNotWired(t *testing.T) {
	prev := RemoveHostsSection
	t.Cleanup(func() { RemoveHostsSection = prev })
	RemoveHostsSection = nil
	if err := CleanupHook(); !errors.Is(err, ErrHostsCleanupNotWired) {
		t.Fatalf("CleanupHook = %v", err)
	}
}

func TestCleanupHookUsesHostsPath(t *testing.T) {
	hosts := filepath.Join(t.TempDir(), "hosts")
	t.Setenv(platform.EnvHostsPath, hosts)
	prev := RemoveHostsSection
	t.Cleanup(func() { RemoveHostsSection = prev })
	var got string
	RemoveHostsSection = func(p string) error { got = p; return nil }
	if err := CleanupHook(); err != nil {
		t.Fatal(err)
	}
	if got != hosts {
		t.Fatalf("RemoveHostsSection got %q, want %q", got, hosts)
	}
}

func TestDefaultHooks(t *testing.T) {
	active, err := HasActiveBlocks()
	if !errors.Is(err, ErrActiveBlocksNotWired) || active {
		t.Fatalf("HasActiveBlocks() = %v, %v; want the not-wired error", active, err)
	}
	if _, ok := NewRunner(nil).(*HeartbeatRunner); !ok {
		t.Fatal("default runner must be the heartbeat runner")
	}
}
