// Package logx provides the guardian's local logs: plain-text slog records in
// size-rotated files (guardian.log, 1 MB, 5 backups) inside platform.LogDir(),
// mirrored to stderr when the guardian runs interactively.
//
// Privacy: these logs feed the app's «Copiar diagnóstico» button, so they must
// never contain personal data. Log event kinds, counts, durations, versions,
// OS facts and error messages only. Never log domains or URLs the user
// blocks or visits, window titles, process or app names chosen by the user,
// user names, e-mail addresses, home-directory paths, camera data or API
// tokens. As a safety net, attributes whose key is in the redacted list (see
// RedactedKeys) are replaced with "[redacted]", but callers must not rely on it.
package logx

import (
	"io"
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

const (
	// FileName is the active log file name; backups get a numeric suffix.
	FileName = "guardian.log"
	// MaxSize is the default rotation threshold in bytes.
	MaxSize int64 = 1 << 20
	// MaxBackups is the default number of rotated files kept.
	MaxBackups = 5

	redacted = "[redacted]"
)

// RedactedKeys lists attribute keys (case-insensitive) whose values are never
// written to the logs.
var RedactedKeys = []string{
	"token", "password", "secret", "authorization", "cookie",
	"url", "domain", "domains", "title", "username", "email",
}

// Options configures New. Zero values select the defaults.
type Options struct {
	Dir        string       // defaults to platform.LogDir()
	FileName   string       // defaults to FileName
	MaxSize    int64        // defaults to MaxSize
	MaxBackups int          // defaults to MaxBackups; negative means none
	Console    io.Writer    // extra sink, typically os.Stderr when interactive
	Level      slog.Leveler // defaults to slog.LevelInfo
}

// Logger is a slog.Logger backed by a RotatingFile. Close it on exit.
type Logger struct {
	*slog.Logger
	file *RotatingFile
}

// New creates the log directory if needed (see platform.EnsureDir) and opens
// the rotating log file.
func New(opts Options) (*Logger, error) {
	dir := opts.Dir
	if dir == "" {
		dir = platform.LogDir()
	}
	name := opts.FileName
	if name == "" {
		name = FileName
	}
	size := opts.MaxSize
	if size <= 0 {
		size = MaxSize
	}
	backups := opts.MaxBackups
	switch {
	case backups == 0:
		backups = MaxBackups
	case backups < 0:
		backups = 0
	}
	if err := platform.EnsureDir(dir); err != nil {
		return nil, err
	}
	rf, err := OpenRotatingFile(filepath.Join(dir, name), size, backups)
	if err != nil {
		return nil, err
	}
	var w io.Writer = rf
	if opts.Console != nil {
		w = teeWriter{file: rf, console: opts.Console}
	}
	return &Logger{Logger: slog.New(newHandler(w, opts.Level)), file: rf}, nil
}

// Path returns the active log file path.
func (l *Logger) Path() string {
	return l.file.Path()
}

// Close flushes and closes the log file.
func (l *Logger) Close() error {
	return l.file.Close()
}

// NewConsole returns a logger that only writes to w, with the same format and
// redaction as New. Use it when the log file cannot be opened.
func NewConsole(w io.Writer) *slog.Logger {
	return slog.New(newHandler(w, nil))
}

func newHandler(w io.Writer, level slog.Leveler) slog.Handler {
	if level == nil {
		level = slog.LevelInfo
	}
	return slog.NewTextHandler(w, &slog.HandlerOptions{Level: level, ReplaceAttr: redact})
}

func redact(_ []string, a slog.Attr) slog.Attr {
	for _, k := range RedactedKeys {
		if strings.EqualFold(a.Key, k) {
			return slog.String(a.Key, redacted)
		}
	}
	return a
}

// teeWriter writes to the log file and, best effort, to the console: a
// Windows service has no usable stderr, and that must never lose file logs.
type teeWriter struct {
	file    io.Writer
	console io.Writer
}

func (t teeWriter) Write(p []byte) (int, error) {
	_, _ = t.console.Write(p)
	return t.file.Write(p)
}
