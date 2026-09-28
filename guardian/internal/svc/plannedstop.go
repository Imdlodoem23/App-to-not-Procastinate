package svc

import (
	"log/slog"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// Planned-stop reasons (store.WritePlannedStop accepts [a-z][a-z0-9_]{0,31}).
const (
	// PlannedStopUpdate: an installer or updater replaces the binary (NSIS
	// customInit, the macOS/AppImage updater, the .deb prerm on upgrade).
	PlannedStopUpdate = "update"
	// PlannedStopInstall: install or reinstall of the service.
	PlannedStopInstall = "install"
	// PlannedStopShutdown: the OS is shutting down or rebooting.
	PlannedStopShutdown = "shutdown"
)

// WritePlannedStop writes run/planned-stop in platform.DataDir()
// (docs/ARCHITECTURE.md §10.12 step 9): a stop of the service within the
// marker's TTL (store.PlannedStopTTL) is not penalized at the next start as
// a stop during a block. It needs administrator rights: only a
// root/SYSTEM-owned marker is honoured, and run/ must exist (the guardian ran
// at least once). A variable so tests can fake it.
var WritePlannedStop = func(reason string) error {
	return store.WritePlannedStop(platform.DataDir(), reason)
}

// StopPlanned writes the planned-stop marker with reason and stops the
// service (see Stop). A marker that cannot be written is logged and the stop
// goes on: an update must always be able to replace the files. The stop's
// outcome is returned (ErrNotInstalled when there is no service).
func (m *Manager) StopPlanned(reason string) error {
	return stopPlanned(m.logger, reason, m.Stop)
}

// stopPlanned writes the marker, then runs stop.
func stopPlanned(logger *slog.Logger, reason string, stop func() error) error {
	if err := WritePlannedStop(reason); err != nil {
		logger.Warn("planned-stop marker not written", "reason", reason, "err", err)
	}
	return stop()
}

// systemStopping reports whether a stop request is part of an OS shutdown or
// reboot (see osSystemStopping). A variable so tests can fake it.
var systemStopping = osSystemStopping
