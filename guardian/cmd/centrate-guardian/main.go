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
// Human messages go to stderr in Spanish; machine output is JSON on stdout.
// Every command is safe to run twice.
package main

import (
	"io"
	"log/slog"
	"os"

	"github.com/imdlodoem23/centrate/guardian/internal/logx"
	"github.com/imdlodoem23/centrate/guardian/internal/platform"
	"github.com/imdlodoem23/centrate/guardian/internal/svc"
	"github.com/imdlodoem23/centrate/guardian/internal/version"
)

func main() {
	// The coordinator wires the engine here, before running any command:
	//   svc.RemoveHostsSection = hosts.RemoveSection
	//   svc.HasActiveBlocks    = engine.HasActiveBlocks
	//   svc.NewRunner          = engine.NewRunner
	os.Exit(defaultApp().run(os.Args[1:]))
}

func defaultApp() *app {
	return &app{
		stdout:      os.Stdout,
		stderr:      os.Stderr,
		version:     version.Version,
		interactive: svc.Interactive,
		elevated:    platform.IsElevated,
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
