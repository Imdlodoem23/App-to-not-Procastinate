package daemon

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
	"github.com/imdlodoem23/centrate/guardian/internal/hosts"
	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// hostsLayer is the real hosts layer: the hosts.Manager plus what data deletion needs
// from it (engine.HostsBackupScrubber, §10.11 step 3).
type hostsLayer struct {
	*hosts.Manager
}

var (
	_ engine.HostsManager        = (*hostsLayer)(nil)
	_ engine.HostsBackupScrubber = (*hostsLayer)(nil)
)

// ScrubBackups strips the Céntrate section from the rotating hosts backups: they list
// the domains the user blocked. The user's own lines stay, so a damaged hosts file can
// still be restored from them.
func (h *hostsLayer) ScrubBackups() error {
	if h.BackupDir == "" {
		return nil
	}
	var errs []error
	for i := range hosts.BackupKeep {
		p := h.BackupPath(i)
		if _, err := os.Lstat(p); errors.Is(err, fs.ErrNotExist) {
			continue
		}
		// A Manager on the backup file rewrites it atomically without the section; it
		// keeps no backups of its own.
		if err := (&hosts.Manager{Path: p, Logger: h.Logger}).Remove(); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// defaultFlusher flushes the system DNS cache after hosts changes, but only while the
// guardian manages the system hosts file: a test or development file
// (CENTRATE_HOSTS_PATH) never touches the system resolver. Both paths are read at
// every flush, since either can move while the guardian runs (the Windows DataBasePath
// value, §10.10).
func defaultFlusher(current func() string, logger *slog.Logger) engine.DNSFlusher {
	return pathFlusher(current, platform.DefaultHostsPath, func(ctx context.Context) error {
		return hosts.FlushDNS(ctx, logger)
	})
}

// pathFlusher runs flush when current() is system().
func pathFlusher(current, system func() string, flush func(context.Context) error) engine.DNSFlusher {
	return engine.DNSFlusherFunc(func(ctx context.Context) error {
		if !samePath(current(), system()) {
			return nil
		}
		return flush(ctx)
	})
}

// samePath compares two paths the way the OS does (case-insensitively on Windows and
// macOS).
func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// purgeHandler is the logger's handler with engine.LogPurger: data deletion starts the
// guardian logs afresh (§10.11 step 3).
type purgeHandler struct {
	slog.Handler
	purge func() error
}

var _ engine.LogPurger = purgeHandler{}

// PurgeLogs implements engine.LogPurger.
func (h purgeHandler) PurgeLogs() error { return h.purge() }

// WithAttrs keeps the purger on derived handlers.
func (h purgeHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return purgeHandler{Handler: h.Handler.WithAttrs(attrs), purge: h.purge}
}

// WithGroup keeps the purger on derived handlers.
func (h purgeHandler) WithGroup(name string) slog.Handler {
	return purgeHandler{Handler: h.Handler.WithGroup(name), purge: h.purge}
}
