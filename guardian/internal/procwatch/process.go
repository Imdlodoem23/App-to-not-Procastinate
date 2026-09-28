package procwatch

import (
	"errors"
	"time"
)

// Process is one running process as seen by List.
type Process struct {
	// PID is the operating system process ID.
	PID int
	// Name is the executable file name, for example "Discord.exe",
	// "RobloxPlayerBeta.exe", "Discord" or "steam".
	Name string
	// Path is the full executable path when the OS gives a trustworthy one
	// without extra work: /proc/<pid>/exe on Linux, and on macOS the exec path
	// the kernel saved when it agrees with the kernel's name for the process.
	// List leaves it empty on Windows (resolving it means opening every
	// process); OSLister fills it there for processes in user sessions, and
	// Kill reads it through the process handle.
	Path string
	// Identity is what the executable file says it is, whatever its name
	// (docs/ARCHITECTURE.md §10.8): on Windows the OriginalFilename of its
	// version resource (InternalName when that is missing), on macOS the
	// identifier of its code signature (see PEIdentity and MachOIdentity).
	// OSLister fills it for processes that are not System; List does not.
	// Empty on Linux. It only widens matching and never protects.
	Identity string
	// Bundle is, on macOS, the name of the innermost .app bundle that holds
	// the executable, without ".app" ("Discord" for
	// /Applications/Discord.app/Contents/MacOS/Discord), taken from Path.
	// It only widens matching: a bundle can be renamed, so it never protects.
	// Empty elsewhere.
	Bundle string
	// Comm is, on Linux, the kernel task name from /proc/<pid>/comm (at most
	// 15 bytes; for a script it is the script name while Name is the
	// interpreter). Empty elsewhere.
	Comm string
	// CmdName is, on Linux, the full name a cut Comm stands for, taken from
	// the command line: the base name (split on '/' and '\', so Wine's
	// "C:\Games\RobloxPlayerBeta.exe" gives "RobloxPlayerBeta.exe") of the
	// first of argv[0], argv[1] or argv[2] that continues Comm when Comm was
	// cut at 15 bytes. argv[1] and argv[2] cover scripts run through their #!
	// line, where argv[0] is the interpreter. Empty otherwise, or when it
	// equals Name. Like Comm it only widens matching and never protects: the
	// process chose it.
	CmdName string
	// PPID is the parent process ID, or 0 when unknown.
	PPID int
	// created is the Windows creation time (FILETIME) from the process
	// table, which with PID identifies the process for OSLister's cache.
	created int64
	// System reports that the process does not belong to an interactive user
	// and must never be matched or killed: on Windows it runs in session 0
	// (services) or, when checked before a kill, as LocalSystem,
	// LocalService or NetworkService; on Linux its effective UID is root or
	// a system account (below UID_MIN from /etc/login.defs, nobody, systemd
	// dynamic users) or it is a kernel thread; on macOS its effective UID is
	// below 501. Fakes leave it false.
	System bool
}

// Lister lists the running processes.
type Lister interface {
	List() ([]Process, error)
}

// Killer closes the process with the given PID, but only if its executable
// name is still name (see Kill).
type Killer interface {
	Kill(pid int, name string) error
}

// ListerFunc adapts a function to Lister.
type ListerFunc func() ([]Process, error)

// List calls f.
func (f ListerFunc) List() ([]Process, error) { return f() }

// KillerFunc adapts a function to Killer.
type KillerFunc func(pid int, name string) error

// Kill calls f.
func (f KillerFunc) Kill(pid int, name string) error { return f(pid, name) }

// OSLister is the Lister backed by the operating system (see List). On top
// of List it fills Process.Identity (Windows, macOS) and Process.Path
// (Windows) for processes that are not System, reading each executable once
// (results are cached by process and by file size and modification time).
type OSLister struct{}

// List calls the package-level List and adds the identities.
func (OSLister) List() ([]Process, error) {
	procs, err := List()
	if err != nil {
		return nil, err
	}
	identify(procs)
	return procs, nil
}

// OSKiller is the Killer backed by the operating system.
type OSKiller struct {
	// Grace is how long a process gets to exit after SIGTERM before SIGKILL
	// (Linux, macOS), or after TerminateProcess before Kill gives up waiting
	// (Windows). Zero means DefaultGrace.
	Grace time.Duration
}

// Kill closes the process; see the package-level Kill.
func (k OSKiller) Kill(pid int, name string) error {
	grace := k.Grace
	if grace <= 0 {
		grace = DefaultGrace
	}
	return osKillPlan(grace).kill(pid, name)
}

// Kill closes the process pid if its executable name (as List reports it) is
// still name, compared the way the Matcher compares names on this OS.
//
// On Linux and macOS it sends SIGTERM, waits up to DefaultGrace for the
// process to exit and then sends SIGKILL. On Windows it calls TerminateProcess
// (see the package documentation). It returns nil once the process has exited.
//
// It returns ErrProtected for protected PIDs, names and directories (see
// IsProtected and ProtectDir) and for system processes (Process.System, read
// again right before the first signal), ErrNotFound when the process is
// already gone, ErrNameMismatch when the PID now belongs to another
// executable, and ErrStillRunning when the process outlived the forced
// termination.
func Kill(pid int, name string) error { return OSKiller{}.Kill(pid, name) }

const (
	// DefaultInterval is the Watcher's default polling interval.
	DefaultInterval = 1500 * time.Millisecond
	// DefaultGrace is the default time between SIGTERM and SIGKILL.
	DefaultGrace = 1500 * time.Millisecond
	// forceWait is how long Kill waits for a process to exit after SIGKILL.
	forceWait = time.Second
	// exitPoll is how often Kill checks whether a process has exited when
	// the OS gives no way to wait for it.
	exitPoll = 25 * time.Millisecond
)

// Errors returned by Kill. Their messages never contain process names.
var (
	ErrNotFound     = errors.New("procwatch: process not found")
	ErrNameMismatch = errors.New("procwatch: PID now belongs to another executable")
	ErrProtected    = errors.New("procwatch: refusing to kill a protected process")
	ErrStillRunning = errors.New("procwatch: process still running after forced termination")
	ErrInvalid      = errors.New("procwatch: invalid PID or name")
)
