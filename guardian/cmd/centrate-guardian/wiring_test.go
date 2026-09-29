package main

import (
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/api"
	"github.com/imdlodoem23/centrate/guardian/internal/daemon"
	"github.com/imdlodoem23/centrate/guardian/internal/logx"
	"github.com/imdlodoem23/centrate/guardian/internal/nuclear"
	"github.com/imdlodoem23/centrate/guardian/internal/platform"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
	"github.com/imdlodoem23/centrate/guardian/internal/svc"
)

func TestSvcHooksAreWired(t *testing.T) {
	if _, ok := svc.NewRunner(slog.New(slog.DiscardHandler)).(*daemon.Runner); !ok {
		t.Fatal("svc.NewRunner must build the guardian (daemon.Runner), not the placeholder")
	}
	if _, ok := svc.NewRunner(nil).(svc.ShutdownRunner); !ok {
		t.Fatal("the guardian runner must handle OS shutdowns (svc.ShutdownRunner)")
	}
	testSystem(t)
	active, err := svc.HasActiveBlocks()
	if err != nil || active {
		t.Fatalf("HasActiveBlocks on an empty data folder = %v, %v", active, err)
	}
}

// appExecutable creates a fake app executable and returns its path.
func appExecutable(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "Centrate App", "centrate")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("app"), 0o755); err != nil {
		t.Fatal(err)
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return real
}

func TestInstallPassesTheAppPath(t *testing.T) {
	app := appExecutable(t)
	for _, args := range [][]string{{"install", "--app-path", app}, {"install", "--app-path=" + app}} {
		a, calls, _, stderr := newTestApp(env{elevated: true})
		if code := a.run(args); code != exitOK {
			t.Fatalf("%v = %d: %s", args, code, stderr)
		}
		want := []string{"prepareDirs", "appPath=" + app, "writeConfig", "newManager", "status", "install"}
		if strings.Join(*calls, "|") != strings.Join(want, "|") {
			t.Fatalf("%v: calls = %v, want %v", args, *calls, want)
		}
	}
	for _, args := range [][]string{
		{"install", "--app-path", app, "--app-path", app},
		{"install", "--app-path", filepath.Dir(app)},
		{"install", "--app-path", filepath.Join(filepath.Dir(app), "missing")},
	} {
		a, calls, _, _ := newTestApp(env{elevated: true})
		if code := a.run(args); code != exitUsage {
			t.Fatalf("%v = %d, want %d", args, code, exitUsage)
		}
		if len(*calls) != 0 {
			t.Fatalf("%v changed the system: %v", args, *calls)
		}
	}
}

func TestWriteConfigKeepsValues(t *testing.T) {
	dataDir, _ := testSystem(t)
	if err := platform.EnsureDataDir(); err != nil {
		t.Fatal(err)
	}
	if err := writeConfig(""); err != nil {
		t.Fatal(err)
	}
	cfg, err := api.LoadConfig(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Port != api.DefaultConfig().Port || cfg.AppPath != "" {
		t.Fatalf("fresh config = %+v", cfg)
	}
	// An administrator's port, extension ids and log level survive an update that
	// also sets the app path; a later install without --app-path keeps it.
	custom := `{"schemaVersion":1,"port":47611,"appPath":"","extraExtensionIds":["abcdefghijklmnopabcdefghijklmnop"],"logLevel":"debug"}`
	if err := os.WriteFile(filepath.Join(dataDir, api.ConfigFileName), []byte(custom), 0o644); err != nil {
		t.Fatal(err)
	}
	app := appExecutable(t)
	if err := writeConfig(app); err != nil {
		t.Fatal(err)
	}
	if err := writeConfig(""); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dataDir, api.ConfigFileName))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got["port"] != float64(47611) || got["appPath"] != app || got["logLevel"] != "debug" || got["schemaVersion"] != float64(1) {
		t.Fatalf("config.json = %s", raw)
	}
	if ids, _ := got["extraExtensionIds"].([]any); len(ids) != 1 {
		t.Fatalf("extraExtensionIds lost: %s", raw)
	}
}

func TestParseLogLevel(t *testing.T) {
	for in, want := range map[string]slog.Level{
		"": slog.LevelInfo, "info": slog.LevelInfo, "DEBUG": slog.LevelDebug, " warn ": slog.LevelWarn,
		"warning": slog.LevelWarn, "error": slog.LevelError, "verbose": slog.LevelInfo,
	} {
		if got := parseLogLevel(in); got != want {
			t.Errorf("parseLogLevel(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestPurgeLogs(t *testing.T) {
	testSystem(t)
	dir := platform.LogDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{logx.FileName, logx.FileName + ".1", logx.FileName + ".3"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("old line\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := purgeLogs(); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 || entries[0].Name() != logx.FileName {
		t.Fatalf("left %v", entries)
	}
	if fi, _ := os.Stat(filepath.Join(dir, logx.FileName)); fi.Size() != 0 {
		t.Fatalf("active log not emptied: %d bytes", fi.Size())
	}
	if err := purgeLogs(); err != nil { // twice is fine
		t.Fatal(err)
	}
}

func TestRemoveSystemExtrasRemovesTheAnchor(t *testing.T) {
	dataDir, _ := testSystem(t)
	agent := filepath.Join(t.TempDir(), "nuclear.plist")
	saved := nuclearAgentPath
	nuclearAgentPath = agent
	t.Cleanup(func() { nuclearAgentPath = saved })
	anchor := store.DefaultAnchor()
	fa, ok := anchor.(*store.FileAnchor)
	if !ok || fa.Path != dataDir+".anchor.json" {
		t.Fatalf("development anchor = %#v", anchor)
	}
	if err := os.WriteFile(fa.Path, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := removeSystemExtras(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(fa.Path); !os.IsNotExist(err) {
		t.Fatalf("anchor left behind: %v", err)
	}
	if err := removeSystemExtras(); err != nil { // twice is fine
		t.Fatal(err)
	}
}

func TestProbeAPI(t *testing.T) {
	dataDir, _ := testSystem(t)
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	var guardian atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if guardian.Load() {
			w.Header().Set("X-Centrate-Api-Version", "1")
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	_, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
	cfg := `{"schemaVersion":1,"port":` + port + `}`
	if err := os.WriteFile(filepath.Join(dataDir, api.ConfigFileName), []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
	if probeAPI() {
		t.Fatal("a server that is not the guardian counted as its API")
	}
	guardian.Store(true)
	if !probeAPI() {
		t.Fatal("the guardian's API (even starting, 503) must count as available")
	}
	srv.Close()
	if probeAPI() {
		t.Fatal("a closed port counted as available")
	}
}

func TestBundledAppPath(t *testing.T) {
	for _, tc := range []struct {
		goos, exe, want string
	}{
		{"windows", "/Program Files/Céntrate/resources/guardian/centrate-guardian.exe", "/Program Files/Céntrate/centrate.exe"},
		{"windows", "/Program Files/Céntrate/Resources/Guardian/centrate-guardian.exe", "/Program Files/Céntrate/centrate.exe"},
		{"linux", "/opt/Céntrate/resources/guardian/centrate-guardian", "/opt/Céntrate/centrate"},
		{"linux", "/opt/Céntrate/Resources/guardian/centrate-guardian", ""}, // case matters on Linux
		{"darwin", "/Applications/centrate.app/Contents/Resources/guardian/centrate-guardian", "/Applications/centrate.app/Contents/MacOS/centrate"},
		{"darwin", "/Applications/centrate.app/resources/guardian/centrate-guardian", ""}, // not inside Contents
		{"linux", "/usr/local/lib/centrate/centrate-guardian", ""},                        // the service's own copy
		{"windows", "/src/guardian/centrate-guardian.exe", ""},                            // a development build
	} {
		exe, want := filepath.FromSlash(tc.exe), filepath.FromSlash(tc.want)
		if got := bundledAppPath(exe, tc.goos); got != want {
			t.Errorf("%s %s: got %q, want %q", tc.goos, tc.exe, got, want)
		}
	}
	// The folders keep their exact bytes (a decomposed "é" stays decomposed), so the
	// path equals the image path the OS reports for the app's process.
	nfd := filepath.FromSlash("/opt/Ce\u0301ntrate/resources/guardian/centrate-guardian")
	if got := bundledAppPath(nfd, "linux"); got != filepath.FromSlash("/opt/Ce\u0301ntrate/centrate") {
		t.Errorf("NFD path rewritten: %q", got)
	}
}

func TestEphemeralPath(t *testing.T) {
	for p, want := range map[string]bool{
		"/tmp/.mount_centraAbC/resources/guardian/centrate-guardian":                                                       true,
		"/home/ana/.cache/.mount_centraX/resources/guardian/centrate-guardian":                                             true,
		"/private/var/folders/xy/abc/T/AppTranslocation/1234/d/centrate.app/Contents/Resources/guardian/centrate-guardian": true,
		"/var/tmp/centrate/resources/guardian/centrate-guardian":                                                           true,
		filepath.Join(os.TempDir(), "x", "centrate-guardian"):                                                              true,
		"/opt/Céntrate/resources/guardian/centrate-guardian":                                                               false,
		"/Applications/centrate.app/Contents/Resources/guardian/centrate-guardian":                                         false,
		"/tmpfoo/centrate-guardian":                                                                                        false,
	} {
		if got := ephemeralPath(p); got != want {
			t.Errorf("ephemeralPath(%q) = %v, want %v", p, got, want)
		}
	}
}

// bundledLayout lays out an installed app the way electron-builder does on this OS
// and returns the guardian binary's path and the app executable's path.
func bundledLayout(t *testing.T) (guardian, app string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "Céntrate")
	switch runtime.GOOS {
	case "windows":
		guardian = filepath.Join(root, "resources", "guardian", "centrate-guardian.exe")
		app = filepath.Join(root, "centrate.exe")
	case "darwin":
		contents := filepath.Join(root, "centrate.app", "Contents")
		guardian = filepath.Join(contents, "Resources", "guardian", "centrate-guardian")
		app = filepath.Join(contents, "MacOS", "centrate")
	default:
		guardian = filepath.Join(root, "resources", "guardian", "centrate-guardian")
		app = filepath.Join(root, "centrate")
	}
	for _, p := range []string{guardian, app} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("binary"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	real, err := filepath.EvalSymlinks(app)
	if err != nil {
		t.Fatal(err)
	}
	return guardian, real
}

func TestAppPathFor(t *testing.T) {
	guardian, app := bundledLayout(t)
	if got, err := appPathFor(guardian); err != nil || got != app {
		t.Fatalf("appPathFor = %q, %v; want %q", got, err, app)
	}
	if err := os.Remove(app); err != nil {
		t.Fatal(err)
	}
	if got, err := appPathFor(guardian); err == nil {
		t.Fatalf("a missing app was accepted: %q", got)
	}
	if got, err := appPathFor(filepath.Join(t.TempDir(), "centrate-guardian")); err == nil {
		t.Fatalf("a binary outside an app found one: %q", got)
	}
	// The test binary itself is no installed app.
	if got, err := bundledApp(); err == nil {
		t.Fatalf("bundledApp from the test binary = %q", got)
	}
}

// Installers run `install` without --app-path (NSIS customInstall, the .deb
// postinst, the app's own elevated install): config.json must still get appPath,
// or the Nuclear supervisor never relaunches the app and refuses its heartbeats
// (daemon: nuclear.New(""), api: peer_not_app).
func TestInstallWithoutAppPathConfiguresTheBundledApp(t *testing.T) {
	dataDir, _ := testSystem(t)
	guardian, app := bundledLayout(t)
	a, calls, _, stderr := newTestApp(env{elevated: true})
	a.prepareDirs = prepareDirs
	a.writeConfig = writeConfig
	a.bundledApp = func() (string, error) { return appPathFor(guardian) }
	if code := a.run([]string{"install"}); code != exitOK {
		t.Fatalf("install = %d (%v): %s", code, *calls, stderr)
	}
	cfg, err := api.LoadConfig(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AppPath != app {
		t.Fatalf("config.json appPath = %q, want %q", cfg.AppPath, app)
	}
	if rl := nuclear.New(cfg.AppPath); rl == nil || rl.AppPath() != app {
		t.Fatalf("the Nuclear supervisor stays disabled: %v", rl)
	}
	// An install from somewhere without an app keeps what is configured.
	a, _, _, stderr = newTestApp(env{elevated: true})
	a.prepareDirs, a.writeConfig = prepareDirs, writeConfig
	a.bundledApp = func() (string, error) { return appPathFor(filepath.Join(t.TempDir(), "centrate-guardian")) }
	if code := a.run([]string{"install"}); code != exitOK {
		t.Fatalf("second install = %d: %s", code, stderr)
	}
	if cfg, _ := api.LoadConfig(dataDir); cfg.AppPath != app {
		t.Fatalf("appPath lost: %q", cfg.AppPath)
	}
}

func TestValidAppPathRejectsBytesJSONCannotKeep(t *testing.T) {
	for _, p := range []string{"/opt/C\xe9ntrate/centrate", "/opt/Centrate\n/centrate"} {
		if got, err := validAppPath(p); err == nil {
			t.Errorf("validAppPath(%q) = %q", p, got)
		}
	}
}
