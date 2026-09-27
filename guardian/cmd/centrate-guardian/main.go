// Command centrate-guardian is the Céntrate system service that enforces
// blocks. It is also its own installer and control tool:
//
//	centrate-guardian run                     run the guardian (used by the service manager)
//	centrate-guardian install                 install or update the service and (re)start it
//	centrate-guardian uninstall [--keep-data] stop and remove the service, clean the hosts file, delete data
//	centrate-guardian start | stop | restart
//	centrate-guardian status                  {"installed":…,"running":…,"version":…}
//	centrate-guardian has-active              exit 10 if a block is active, 0 if not, 1 on error
//	centrate-guardian cleanup-hosts           remove the Céntrate section from the hosts file
//	centrate-guardian version                 {"version":…}
//
// Exit codes: 0 success; 1 error; 2 usage; 3 not installed (start and
// restart; stop exits 0 because nothing is running); 10 a block is active
// (has-active).
//
// Human messages go to stderr in Spanish; machine output is JSON on stdout.
// Every command is safe to run twice.
package main

import (
	"io"
	"log/slog"
	"os"
	// IANA time zones for schedules (Intl names such as "Europe/Madrid"):
	// Windows has no zoneinfo database, so the binary embeds one.
	_ "time/tzdata"

	"github.com/imdlodoem23/centrate/guardian/internal/hosts"
	"github.com/imdlodoem23/centrate/guardian/internal/logx"
	"github.com/imdlodoem23/centrate/guardian/internal/platform"
	"github.com/imdlodoem23/centrate/guardian/internal/svc"
	"github.com/imdlodoem23/centrate/guardian/internal/version"
)

func init() {
	// Hosts cleanup does not depend on the engine, so it is wired here for
	// every build (and for this package's tests), not in main.
	svc.RemoveHostsSection = removeHostsSection
}

func main() {
	// The engine wires itself here, before running any command:
	//   svc.HasActiveBlocks = engine.HasActiveBlocks
	//   svc.NewRunner       = engine.NewRunner
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
		hasActive:    func() (bool, error) { return svc.HasActiveBlocks() },
		removeData:   platform.RemoveDataDir,
		dataDir:      platform.DataDir,
	}
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

// openLogger opens the rotating log, mirrored to console when non-nil.
func openLogger(console io.Writer) (*slog.Logger, func(), error) {
	if err := prepareDirs(); err != nil {
		return nil, nil, err
	}
	l, err := logx.New(logx.Options{Console: console})
	if err != nil {
		return nil, nil, err
	}
	return l.Logger, func() { _ = l.Close() }, nil
}
