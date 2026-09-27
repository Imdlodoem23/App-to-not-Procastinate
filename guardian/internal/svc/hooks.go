package svc

import (
	"errors"
	"log/slog"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// Hooks the coordinator or the engine plug in at startup (in main, before any
// command runs). They are plain variables, not synchronised: set them once,
// before use.

var (
	// ErrHostsCleanupNotWired is returned by the default CleanupHook while
	// RemoveHostsSection has not been set.
	ErrHostsCleanupNotWired = errors.New("svc: hosts cleanup is not wired (set svc.RemoveHostsSection)")
	// ErrActiveBlocksNotWired is returned by the default HasActiveBlocks: until
	// the engine answers, "no active block" would be a guess.
	ErrActiveBlocksNotWired = errors.New("svc: active-block check is not wired (set svc.HasActiveBlocks)")
)

// RemoveHostsSection removes the Céntrate section (between the
// "# >>> CENTRATE START" and "# <<< CENTRATE END" markers) from the hosts file
// at hostsPath. It must leave the rest of the file untouched, succeed when the
// section is absent, and flush the DNS cache. cmd/centrate-guardian wires it
// to hosts.Manager.Remove.
var RemoveHostsSection func(hostsPath string) error

// CleanupHook undoes the guardian's system changes. uninstall and
// cleanup-hosts call it after stopping the service. The default removes the
// hosts section of platform.HostsPath() with RemoveHostsSection.
var CleanupHook = func() error {
	if RemoveHostsSection == nil {
		return ErrHostsCleanupNotWired
	}
	return RemoveHostsSection(platform.HostsPath())
}

// HasActiveBlocks reports whether at least one block is active right now
// (used by has-active, which installers call to warn before uninstalling).
// The default fails with ErrActiveBlocksNotWired; the engine replaces it.
var HasActiveBlocks = func() (bool, error) {
	return false, ErrActiveBlocksNotWired
}

// NewRunner builds the Runner that run executes. It is called only when the
// service starts (never by status, stop, install and the other control
// commands), and it must not open files, take locks or bind sockets: do that
// in Runner.Start. The default is a HeartbeatRunner logging every
// HeartbeatInterval; the engine replaces it.
var NewRunner = func(logger *slog.Logger) Runner {
	return NewHeartbeatRunner(logger, HeartbeatInterval)
}
