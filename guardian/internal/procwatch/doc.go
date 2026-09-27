// Package procwatch finds and closes blocked desktop apps: layer 3 of the
// block, «Vigilante de procesos» (PROMPT.md section 5). Every 1–2 s it lists
// the running processes, closes the ones whose executable name is blocked and
// reports each launch it closed so the engine can count the attempt.
//
// # Building blocks
//
//   - [List] returns the running processes with their executable file name
//     (Process.Name, without truncation where the OS allows), parent PID and
//     whether they belong to the system (Process.System), without running any
//     other program:
//     Windows: NtQuerySystemInformation(SystemProcessInformation), which gives
//     the image name, PID, parent PID and session of every process without
//     opening any of them; Path stays empty.
//     Linux: readlink /proc/<pid>/exe (basename, " (deleted)" removed), with
//     comm, parent PID and flags from /proc/<pid>/stat and the effective UID
//     from /proc/<pid>/status. When exe cannot be read Name falls back to
//     comm. Process.Comm keeps comm, so a script run by an interpreter (exe
//     python3, comm lutris) can match too, and when comm was cut at 15 bytes
//     Process.CmdName holds the full name from argv[0], argv[1] or argv[2]
//     ("minecraft-launcher" for a script, "RobloxPlayerBeta.exe" under Wine).
//     macOS (no cgo, no exec): sysctl kern.proc.all for PID, parent PID,
//     effective UID and p_comm (the name of the file the kernel executed, cut
//     at 16 bytes; unlike argv[0] the launcher cannot choose it), and sysctl
//     kern.procargs2 for the exec path, used for the full name, Path and the
//     .app bundle (Process.Bundle) only when its base name agrees with
//     p_comm. See kinfo.go.
//   - [Matcher] decides which processes are blocked. It is built from the
//     catalog's process names for the current OS: case-insensitive on Windows
//     and macOS, exact on Linux, ".exe" optional on Windows and ".app"
//     optional on macOS; composed and decomposed accents (macOS file names
//     come decomposed) compare equal for Latin-1 letters.
//   - [Kill] closes one process: SIGTERM, then SIGKILL after 1.5 s if it is
//     still alive (Linux and macOS); TerminateProcess on Windows. It first
//     checks that the PID still belongs to a process with the listed name and
//     that it is not protected or a system process, so a PID reused since the
//     listing is never hit.
//   - [Watcher] ties them together in a loop and reports [Killed] once per
//     launch: the processes of one target in one scan (Chromium, Electron,
//     Steam and games run several), with the matching processes they started
//     folded into their ancestor's report. It reports again when the app comes
//     back in a later scan (relaunched by the user, a launcher, an updater or
//     a KeepAlive agent), so the engine must debounce per target before
//     counting an attempt (docs/ARCHITECTURE.md §10.8 merges detections of a
//     target within 30 s).
//
// # What is never touched
//
// Some processes are never matched and never killed, whatever the targets
// say:
//
//   - System processes (Process.System): on Windows everything in session 0
//     (services) and, checked through the process handle right before a
//     kill, anything running as LocalSystem, LocalService or NetworkService
//     in a user session; on Linux processes whose effective UID is root or a
//     system account (below UID_MIN from /etc/login.defs, nobody, systemd
//     dynamic users) and kernel threads; on macOS processes whose effective
//     UID is below 501. A target such as "python3", "java" or "node" therefore
//     closes only the user's own processes, never daemons, services or the
//     package manager. The guardian runs as root or LocalSystem; this is what
//     keeps it from acting on everything.
//   - The hard deny-list: the guardian itself (its PID and its executable
//     name), Céntrate (any name starting with "centrate" once lowercased and
//     without accents, which covers "Céntrate.exe", "Céntrate Helper (GPU)" and
//     "centrate-guardian"), and the processes in [IsProtected]: the shell and
//     compositor, task managers, elevation prompts and package managers used
//     to update or uninstall Céntrate, installers and accessibility tools
//     (explorer.exe, consent.exe, Finder, Installer, gnome-shell, pkexec…).
//     The list mirrors packages/shared/src/catalog/data/protected.ts, and tests
//     on both sides keep them in sync. PIDs 0 and 4 on Windows, 0, 1 and 2 on
//     Linux and 0 and 1 on macOS are protected too.
//   - Executables inside a directory given to [ProtectDir], such as the
//     Céntrate install directory, whatever their name.
//
// Protection is decided by the executable name, the kernel's path and the
// owner, never by names the process or the user can choose freely: comm,
// argv and .app bundle names only ever widen matching (renaming Discord.app
// to «Céntrate.app» must not protect it).
//
// # Known limitations
//
// Matching is by executable file name only. A copy of a blocked executable
// under another name (Discord.exe copied to x.exe in a folder the user can
// write to, or a renamed macOS binary) is not recognised; identity by
// version resource (Windows OriginalFilename) or code signature (macOS bundle
// id) is not implemented yet. On macOS the name comes from p_comm, cut at 16
// bytes: when the exec path cannot confirm the full name, only a target equal
// to the cut name matches. Processes of other interactive users (fast user
// switching, RDP) are matched like the current user's; the engine decides
// whose blocks apply. A user who runs an app as root (sudo) or as a service
// is out of reach by design.
//
// # Closing apps without a graceful step on Windows
//
// The guardian runs as a service in session 0 and cannot post WM_CLOSE to the
// user's windows, so on Windows Kill calls TerminateProcess directly and waits
// up to the grace period for the process to exit.
//
// # PID reuse
//
// Linux opens a pidfd (pidfd_open, 5.3+) before checking the name and signals
// through it, so the check and the signal refer to the same process; Windows
// does the same with a process handle, which also keeps the PID from being
// reused while it is open. macOS binds the kill to the process's start time,
// so a PID reused after the process exited reads as gone; only the few
// microseconds between that check and kill(2) remain, as on Linux kernels
// older than 5.3 (where the name is re-read right before each signal).
//
// # Privacy
//
// Process and app names are chosen by the user. Nothing in this package logs
// them: log records carry PIDs, counts and error messages only (see logx).
package procwatch
