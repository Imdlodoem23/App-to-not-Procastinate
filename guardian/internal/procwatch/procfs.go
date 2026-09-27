package procwatch

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// commMax is the length at which Linux cuts /proc/<pid>/comm (TASK_COMM_LEN-1).
const commMax = 15

// pfKthread is PF_KTHREAD from <linux/sched.h>: the task is a kernel thread.
const pfKthread = 0x00200000

// defaultUIDMin is the first UID of a human account when /etc/login.defs does
// not say (the default of shadow-utils).
const defaultUIDMin = 1000

// procFS reads processes from a Linux procfs mounted at root. It has no build
// tag so tests on every OS can run it against a fake tree; readlink is
// injectable because creating symlinks needs privileges on Windows.
type procFS struct {
	root     string
	readlink func(string) (string, error)
	// uidMin returns the first UID of a human account (UID_MIN); nil means
	// defaultUIDMin.
	uidMin func() int
}

// list returns every process under root. Processes that exit while being read
// (and zombies) are skipped.
func (f procFS) list() ([]Process, error) {
	entries, err := os.ReadDir(f.root)
	if err != nil {
		return nil, fmt.Errorf("procwatch: read procfs: %w", err)
	}
	procs := make([]Process, 0, len(entries))
	for _, e := range entries {
		pid, ok := parsePID(e.Name())
		if !ok {
			continue
		}
		if p, err := f.read(pid); err == nil {
			procs = append(procs, p)
		}
	}
	return procs, nil
}

// read returns one process. Name is the basename of the exe link when it can
// be read (it cannot for kernel threads, or for other users' processes
// without root); otherwise comm, or CmdName when comm was cut at 15 bytes and
// the command line continues it. Comm, PPID and the kernel-thread flag
// come from /proc/<pid>/stat and the effective UID from /proc/<pid>/status.
// It returns an error wrapping ErrNotFound when the process does not exist or
// is a zombie.
func (f procFS) read(pid int) (Process, error) {
	dir := filepath.Join(f.root, strconv.Itoa(pid))
	b, err := os.ReadFile(filepath.Join(dir, "stat"))
	if err != nil {
		return Process{}, procErr(pid, "stat", err)
	}
	st, ok := parseStat(b)
	if !ok {
		return Process{}, fmt.Errorf("procwatch: malformed stat of pid %d", pid)
	}
	if st.state == 'Z' || st.state == 'X' || st.state == 'x' {
		return Process{}, fmt.Errorf("%w: pid %d is a zombie", ErrNotFound, pid)
	}
	b, err = os.ReadFile(filepath.Join(dir, "status"))
	if err != nil {
		return Process{}, procErr(pid, "status", err)
	}
	euid, ok := statusEUID(b)
	if !ok {
		return Process{}, fmt.Errorf("procwatch: malformed status of pid %d", pid)
	}
	uidMin := defaultUIDMin
	if f.uidMin != nil {
		uidMin = f.uidMin()
	}
	p := Process{
		PID:    pid,
		PPID:   st.ppid,
		Comm:   st.comm,
		System: st.flags&pfKthread != 0 || !linuxHumanUID(euid, uidMin),
	}

	// The command line is only read when comm was cut, and a name from it is
	// only kept when it continues comm.
	cmdName := ""
	if len(p.Comm) == commMax {
		for _, arg := range readArgs(filepath.Join(dir, "cmdline"), 3) {
			if base := baseName(arg); len(base) > commMax && strings.HasPrefix(base, p.Comm) {
				cmdName = base
				break
			}
		}
	}

	if exe, err := f.readlink(filepath.Join(dir, "exe")); err == nil {
		exe = strings.TrimSuffix(exe, " (deleted)")
		if name := exe[strings.LastIndexByte(exe, '/')+1:]; name != "" {
			p.Name, p.Path = name, exe
			if cmdName != name {
				p.CmdName = cmdName
			}
			return p, nil
		}
	}

	p.Name = p.Comm
	if cmdName != "" {
		p.Name = cmdName
	}
	if p.Name == "" {
		return Process{}, fmt.Errorf("%w: pid %d has no name", ErrNotFound, pid)
	}
	return p, nil
}

// procErr maps a missing procfs file to ErrNotFound.
func procErr(pid int, file string, err error) error {
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%w: pid %d", ErrNotFound, pid)
	}
	return fmt.Errorf("procwatch: read %s of pid %d: %w", file, pid, err)
}

// statFields are the fields of /proc/<pid>/stat the package uses.
type statFields struct {
	comm  string
	state byte
	ppid  int
	flags uint64
}

// parseStat parses "pid (comm) state ppid pgrp session tty_nr tpgid flags …".
// comm may contain spaces and parentheses, so the other fields are read after
// the last ')'.
func parseStat(b []byte) (statFields, bool) {
	open := bytes.IndexByte(b, '(')
	end := bytes.LastIndexByte(b, ')')
	if open < 0 || end < open {
		return statFields{}, false
	}
	rest := strings.Fields(string(b[end+1:]))
	if len(rest) < 7 || len(rest[0]) != 1 {
		return statFields{}, false
	}
	ppid, err := strconv.Atoi(rest[1])
	if err != nil || ppid < 0 {
		return statFields{}, false
	}
	flags, err := strconv.ParseUint(rest[6], 10, 64)
	if err != nil {
		return statFields{}, false
	}
	return statFields{comm: string(b[open+1 : end]), state: rest[0][0], ppid: ppid, flags: flags}, true
}

// statusEUID returns the effective UID from the "Uid:" line of
// /proc/<pid>/status (real, effective, saved, file system).
func statusEUID(b []byte) (uint32, bool) {
	for _, line := range strings.Split(string(b), "\n") {
		rest, ok := strings.CutPrefix(line, "Uid:")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) < 2 {
			return 0, false
		}
		uid, err := strconv.ParseUint(f[1], 10, 32)
		if err != nil {
			return 0, false
		}
		return uint32(uid), true
	}
	return 0, false
}

// linuxHumanUID reports whether uid is a human account: at least uidMin and
// none of the system ranges above it (nobody, the 16-bit -1, systemd's
// dynamic users and the 32-bit -1).
func linuxHumanUID(uid uint32, uidMin int) bool {
	switch {
	case uid == 0 || int64(uid) < int64(uidMin):
		return false
	case uid == 65534 || uid == 65535:
		return false
	case uid >= 61184 && uid <= 65519:
		return false
	case uid == math.MaxUint32:
		return false
	}
	return true
}

// readUIDMin returns UID_MIN from a login.defs file, or defaultUIDMin when the
// file or the setting is missing or implausible (below 100).
func readUIDMin(path string) int {
	b, err := os.ReadFile(path)
	if err != nil {
		return defaultUIDMin
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 || f[0] != "UID_MIN" {
			continue
		}
		n, err := strconv.Atoi(f[1])
		if err != nil || n < 100 || n > 1<<31-1 {
			return defaultUIDMin
		}
		return n
	}
	return defaultUIDMin
}

// exited reports whether pid is gone or a zombie, from /proc/<pid>/stat.
func (f procFS) exited(pid int) bool {
	b, err := os.ReadFile(filepath.Join(f.root, strconv.Itoa(pid), "stat"))
	if err != nil {
		return errors.Is(err, fs.ErrNotExist)
	}
	state, ok := statState(b)
	return ok && (state == 'Z' || state == 'X' || state == 'x')
}

// statState extracts the state field of /proc/<pid>/stat ("pid (comm) S …").
// comm may contain spaces and parentheses, so it looks after the last ')'.
func statState(b []byte) (byte, bool) {
	i := bytes.LastIndexByte(b, ')')
	if i < 0 || i+2 >= len(b) || b[i+1] != ' ' {
		return 0, false
	}
	return b[i+2], true
}

// readArgs returns up to n leading NUL-separated fields of a cmdline file.
func readArgs(path string, n int) []string {
	b, err := os.ReadFile(path)
	if err != nil || len(b) == 0 {
		return nil
	}
	args := strings.SplitN(strings.TrimSuffix(string(b), "\x00"), "\x00", n+1)
	return args[:min(len(args), n)]
}

// parsePID accepts only plain positive decimal PIDs ("self", "1a", "+1" and
// "01" are not processes).
func parsePID(s string) (int, bool) {
	if s == "" || len(s) > 10 || s[0] == '0' {
		return 0, false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.Atoi(s)
	return n, err == nil && n > 0
}
