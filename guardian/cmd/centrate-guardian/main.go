// Command centrate-guardian is the Céntrate system service that enforces
// blocks. It is also its own installer and control tool:
//
//	centrate-guardian run                     run the guardian (used by the service manager)
//	centrate-guardian install [--app-path P]  install or update the service and (re)start it
//	centrate-guardian prepare-update          planned stop before an installer replaces the files
//	centrate-guardian uninstall [--keep-data] stop and remove the service, clean the hosts file, delete data
//	centrate-guardian start | stop | restart
//	centrate-guardian status                  {"installed":…,"running":…,"version":…,"problems":[…]}
//	centrate-guardian has-active              exit 10 (normal/strict) or 11 (hardcore/exam/punishment) if a block is active, 0 if not, 1 on error
//	centrate-guardian cleanup-hosts           remove the Céntrate section from the hosts file
//	centrate-guardian version                 {"version":…}
//
// Exit codes: 0 success; 1 error; 2 usage; 3 not installed (start and
// restart; stop and prepare-update exit 0 because nothing is running); 10 and
// 11 a block is active (has-active).
//
// Human messages go to stderr in Spanish; machine output is JSON on stdout.
// Every command is safe to run twice. Installers pass fixed arguments only;
// --app-path is the one value they may supply, the desktop app's own absolute
// path. Without it, install takes the app the binary ships in (bundledAppPath).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
	// IANA time zones for schedules (Intl names such as "Europe/Madrid"):
	// Windows has no zoneinfo database, so the binary embeds one.
	_ "time/tzdata"

	"github.com/kardianos/service"

	"github.com/imdlodoem23/centrate/guardian/internal/api"
	"github.com/imdlodoem23/centrate/guardian/internal/daemon"
	"github.com/imdlodoem23/centrate/guardian/internal/engine"
	"github.com/imdlodoem23/centrate/guardian/internal/hosts"
	"github.com/imdlodoem23/centrate/guardian/internal/logx"
	"github.com/imdlodoem23/centrate/guardian/internal/nuclear"
	"github.com/imdlodoem23/centrate/guardian/internal/platform"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
	"github.com/imdlodoem23/centrate/guardian/internal/svc"
	"github.com/imdlodoem23/centrate/guardian/internal/version"
)

func init() {
	// The svc hooks are wired here, for every build and for this package's tests,
	// before any command runs.
	svc.RemoveHostsSection = removeHostsSection
	svc.HasActiveBlocks = engine.HasActiveBlocks
	svc.NewRunner = newGuardianRunner
}

func main() {
	os.Exit(defaultApp().run(os.Args[1:]))
}

func defaultApp() *app {
	return &app{
		stdout:        os.Stdout,
		stderr:        os.Stderr,
		version:       version.Version,
		interactive:   svc.Interactive,
		elevated:      platform.IsElevated,
		useSystemPATH: platform.UseSystemPATH,
		newManager: func(o svc.Options) (serviceManager, error) {
			return svc.New(o)
		},
		newRunner:    func(l *slog.Logger) svc.Runner { return svc.NewRunner(l) },
		openLogger:   openLogger,
		prepareDirs:  prepareDirs,
		cleanupHosts: func() error { return svc.CleanupHook() },
		hasActive:    func() (engine.ActiveLevel, error) { return engine.HasActive(platform.DataDir()) },
		removeData:   platform.RemoveDataDir,
		removeExtras: removeSystemExtras,
		dataDir:      platform.DataDir,
		writeConfig:  writeConfig,
		bundledApp:   bundledApp,
		plannedStop:  func() error { return svc.WritePlannedStop(svc.PlannedStopInstall) },
		probeAPI:     probeAPI,
	}
}

// newGuardianRunner is svc.NewRunner: the engine, the API and the OS watchers
// (internal/daemon). Building it touches nothing; Start does the work.
func newGuardianRunner(logger *slog.Logger) svc.Runner {
	return daemon.New(daemon.Options{
		Logger:         logger,
		PurgeLogs:      purgeLogs,
		ServiceManager: serviceManagerName(),
		OnFatal:        exitOnFatal,
	})
}

// exitOnFatal ends the process when the guardian cannot start (the lock is held
// by another instance, the data folder is unusable…): the service manager
// restarts it, and repeated failures put it in safe mode (§10.12).
func exitOnFatal(err error) {
	_, _ = fmt.Fprintf(os.Stderr, "El guardián no pudo arrancar: %v\n", err)
	os.Exit(exitError)
}

// serviceManagerName names what started the guardian, for diagnostics.
func serviceManagerName() string {
	if svc.Interactive() {
		return "interactive"
	}
	if s := service.ChosenSystem(); s != nil {
		return s.String()
	}
	return runtime.GOOS
}

// removeHostsSection is svc.RemoveHostsSection. It takes the Céntrate section
// out of the hosts file at path. When an interrupted write left the file
// damaged (see hosts.Manager.Damaged) it restores the newest backup instead,
// which comes back without the section. The DNS cache is flushed only for the
// real system hosts file.
func removeHostsSection(path string) error {
	m := &hosts.Manager{
		Path:      path,
		BackupDir: hostsBackupDir(),
		AutoFlush: path == platform.DefaultHostsPath(),
	}
	if m.BackupDir != "" {
		if damaged, err := m.Damaged(); err == nil && damaged {
			if err := m.RestoreFromBackup(); err == nil {
				return nil
			}
		}
	}
	return m.Remove()
}

// hostsBackupDir returns the guardian's hosts backup folder, secured, or ""
// when the data folder does not exist (nothing to restore from, and cleanup
// must not create it) or cannot be secured (cleanup goes on without backups).
func hostsBackupDir() string {
	if _, err := os.Lstat(platform.DataDir()); err != nil {
		return ""
	}
	if err := platform.EnsureDataDir(); err != nil {
		return ""
	}
	dir := platform.BackupDir()
	if err := platform.EnsureDir(dir); err != nil {
		return ""
	}
	return dir
}

// prepareDirs creates the data and log directories with their permissions.
func prepareDirs() error {
	if err := platform.EnsureDataDir(); err != nil {
		return err
	}
	return platform.EnsureDir(platform.LogDir())
}

// openLogger opens the rotating log, mirrored to console when non-nil, at the
// level config.json asks for (default info).
func openLogger(console io.Writer) (*slog.Logger, func(), error) {
	if err := prepareDirs(); err != nil {
		return nil, nil, err
	}
	cfg, _ := api.LoadConfig(platform.DataDir())
	l, err := logx.New(logx.Options{Console: console, Level: parseLogLevel(cfg.LogLevel)})
	if err != nil {
		return nil, nil, err
	}
	return l.Logger, func() { _ = l.Close() }, nil
}

// parseLogLevel maps config.json's logLevel to a slog level (default info).
func parseLogLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	}
	return slog.LevelInfo
}

// purgeLogs deletes the rotated logs and empties the active one (data deletion,
// §10.11 step 3). The open log keeps appending to the emptied file.
func purgeLogs() error {
	dir := platform.LogDir()
	var errs []error
	for i := 1; i <= logx.MaxBackups; i++ {
		p := filepath.Join(dir, logx.FileName+"."+strconv.Itoa(i))
		if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	if err := os.Truncate(filepath.Join(dir, logx.FileName), 0); err != nil && !errors.Is(err, fs.ErrNotExist) {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// nuclearAgentPath is the Nuclear LaunchAgent the macOS installer writes
// (§10.5); a variable so tests never touch the real one.
var nuclearAgentPath = nuclear.DarwinAgentPath

// removeSystemExtras removes what the guardian keeps outside its data folder:
// the rollback anchor (§11.1) and, on macOS, the Nuclear LaunchAgent (§13).
func removeSystemExtras() error {
	var errs []error
	if err := store.RemoveAnchor(); err != nil {
		errs = append(errs, fmt.Errorf("anchor: %w", err))
	}
	// Linux keeps the anchor in /etc/centrate, created for it: leave no empty folder.
	if fa, ok := store.DefaultAnchor().(*store.FileAnchor); ok && fa.CreateDir {
		_ = os.Remove(filepath.Dir(fa.Path))
	}
	if runtime.GOOS == "darwin" && platform.IsElevated() {
		if err := os.Remove(nuclearAgentPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// writeConfig writes config.json (§11.1): the existing values (port, extra
// extension ids, log level) are kept, appPath is replaced when given.
func writeConfig(appPath string) error {
	dir := platform.DataDir()
	cfg, _ := api.LoadConfig(dir) // invalid values fall back to their defaults
	if appPath != "" {
		cfg.AppPath = appPath
	}
	cfg.SchemaVersion = 1
	if cfg.ExtraExtensionIDs == nil {
		cfg.ExtraExtensionIDs = []string{}
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return store.WriteAtomic(filepath.Join(dir, api.ConfigFileName), append(raw, '\n'), platform.FileMode)
}

// validAppPath checks the --app-path value: an absolute path to an existing
// regular file (the desktop app's executable). Links are resolved, because the
// guardian compares it with the real image path of the app's process. The path
// must be valid UTF-8: config.json is JSON, which cannot carry other bytes
// unchanged.
func validAppPath(p string) (string, error) {
	if p == "" || !filepath.IsAbs(p) {
		return "", errors.New("la ruta de la app debe ser absoluta")
	}
	if !utf8.ValidString(p) || strings.ContainsFunc(p, unicode.IsControl) {
		return "", errors.New("la ruta de la app tiene caracteres no válidos")
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(p))
	if err != nil {
		return "", fmt.Errorf("no se encuentra la app en %s", p)
	}
	fi, err := os.Stat(resolved)
	if err != nil || !fi.Mode().IsRegular() {
		return "", fmt.Errorf("%s no es el ejecutable de la app", p)
	}
	return resolved, nil
}

// appExecutableName is the desktop app's executable name (executableName in
// apps/desktop/electron-builder.yml): centrate.exe on Windows, centrate on Linux and
// in the macOS bundle's Contents/MacOS.
const appExecutableName = "centrate"

// bundledAppPath returns where electron-builder puts the desktop app's executable
// when exe is the guardian it ships in extraResources (resources/guardian), or ""
// when exe is not in that layout:
//
//	windows  <dir>\resources\guardian\centrate-guardian.exe → <dir>\centrate.exe
//	linux    /opt/Céntrate/resources/guardian/centrate-guardian → /opt/Céntrate/centrate
//	darwin   X.app/Contents/Resources/guardian/centrate-guardian → X.app/Contents/MacOS/centrate
//
// The result keeps exe's own bytes for every folder, so it is spelled exactly like
// the image path the OS reports for the app's process (no Unicode normalization of
// "Céntrate" happens here).
func bundledAppPath(exe, goos string) string {
	guardianDir := filepath.Dir(filepath.Clean(exe))
	resourcesDir := filepath.Dir(guardianDir)
	if !sameName(filepath.Base(guardianDir), "guardian", goos) || !sameName(filepath.Base(resourcesDir), "resources", goos) {
		return ""
	}
	root := filepath.Dir(resourcesDir)
	switch goos {
	case "windows":
		return filepath.Join(root, appExecutableName+".exe")
	case "darwin":
		if !sameName(filepath.Base(root), "Contents", goos) {
			return ""
		}
		return filepath.Join(root, "MacOS", appExecutableName)
	default:
		return filepath.Join(root, appExecutableName)
	}
}

// sameName compares one path element the way goos's default file system does.
func sameName(a, b, goos string) bool {
	if goos == "windows" || goos == "darwin" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// ephemeralPath reports whether p lives somewhere that does not outlast the app's
// run: an AppImage mount (/tmp/.mount_*), a temporary folder or a macOS App
// Translocation copy. The app's image path there changes from one launch to the
// next, so it is useless as config.json appPath.
func ephemeralPath(p string) bool {
	s := filepath.ToSlash(filepath.Clean(p))
	if strings.Contains(s, "/.mount_") || strings.Contains(s, "/AppTranslocation/") {
		return true
	}
	prefixes := []string{"/tmp/", "/var/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"}
	if tmp := filepath.ToSlash(filepath.Clean(os.TempDir())); tmp != "/" && tmp != "." {
		prefixes = append(prefixes, strings.TrimSuffix(tmp, "/")+"/")
	}
	for _, prefix := range prefixes {
		if len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix) {
			return true
		}
	}
	return false
}

// appPathFor is the app shipped with the guardian binary at exe (see
// bundledAppPath), checked like --app-path.
func appPathFor(exe string) (string, error) {
	p := bundledAppPath(exe, runtime.GOOS)
	if p == "" {
		return "", fmt.Errorf("%s no está dentro de una app de Céntrate", exe)
	}
	return validAppPath(p)
}

// bundledApp is the app shipped with the running binary: what install writes to
// config.json appPath when the installer passes no --app-path. A binary run from
// a temporary place (an AppImage mount, a download folder) has none.
func bundledApp() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	if ephemeralPath(exe) {
		return "", fmt.Errorf("%s es una ubicación temporal", filepath.Dir(exe))
	}
	return appPathFor(exe)
}

// probeTimeout bounds the status command's health check.
const probeTimeout = 3 * time.Second

// probeAPI reports whether the guardian's API answers GET /v1/health on its
// configured port.
func probeAPI() bool {
	cfg, _ := api.LoadConfig(platform.DataDir())
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.Port))
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+addr+"/v1/health", nil)
	if err != nil {
		return false
	}
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: probeTimeout}
	res, err := client.Do(req)
	if err != nil {
		return false
	}
	_ = res.Body.Close()
	// Any answer of the guardian's API counts, 503 "starting" included: the port is
	// bound and the API is up.
	return res.Header.Get("X-Centrate-Api-Version") != ""
}
