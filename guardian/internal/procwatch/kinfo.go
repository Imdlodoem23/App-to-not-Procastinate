package procwatch

import (
	"bytes"
	"math"
	"path"
	"strings"
)

// macOS identifies processes from the kernel, without exec and without cgo:
//
//   - sysctl kern.proc.all (kern.proc.pid for one process) gives every
//     process's PID, parent PID, effective UID, state, start time and p_comm:
//     the name of the file the kernel executed, cut at 16 bytes (MAXCOMLEN).
//     Unlike argv[0], which `ps -o comm` prints, the launcher cannot choose
//     it.
//   - sysctl kern.procargs2 gives argc followed by the exec path the kernel
//     saved at execve, then argv. The exec path is the path the launcher
//     passed (it may be relative or go through a symlink), so it is only used
//     when its base name agrees with p_comm; it then gives the full name
//     (p_comm is cut) and the .app bundle.
//
// The helpers in this file have no build tag so tests run on every OS.

// maxComLen is MAXCOMLEN from <sys/param.h>: p_comm holds at most 16 bytes.
const maxComLen = 16

// darwinFirstUserUID is the first UID macOS gives to user accounts.
const darwinFirstUserUID = 501

// darwinProcess builds a Process from kernel data: comm is p_comm, uid the
// effective UID and execPath the exec path from kern.procargs2 ("" when it was
// not read).
func darwinProcess(pid, ppid int, uid uint32, comm, execPath string) Process {
	p := Process{PID: pid, PPID: ppid, Name: comm, System: !darwinHumanUID(uid)}
	if comm == "" || execPath == "" {
		return p
	}
	base := execPath[strings.LastIndexByte(execPath, '/')+1:]
	if !commAgrees(comm, base) {
		// A symlink or a hard link with another name: keep the kernel's name
		// and ignore the path.
		return p
	}
	p.Name = base
	if strings.HasPrefix(execPath, "/") && path.Clean(execPath) == execPath {
		p.Path = execPath
		p.Bundle = bundleName(execPath)
	}
	return p
}

// commAgrees reports whether base is the file name p_comm was taken from:
// equal to it, or continuing it when p_comm was cut at maxComLen bytes.
func commAgrees(comm, base string) bool {
	if len(comm) < maxComLen {
		return base == comm
	}
	return strings.HasPrefix(base, comm)
}

// darwinHumanUID reports whether uid belongs to a user account: 501 or above,
// excluding nobody (-2) and the other negative IDs.
func darwinHumanUID(uid uint32) bool {
	return uid >= darwinFirstUserUID && uid <= math.MaxInt32
}

// execPathFromProcargs2 returns the exec path from a kern.procargs2 buffer:
// a native-endian int32 argc, then the NUL-terminated exec path. It returns
// "" for malformed buffers.
func execPathFromProcargs2(b []byte) string {
	if len(b) <= 4 {
		return ""
	}
	b = b[4:]
	i := bytes.IndexByte(b, 0)
	if i <= 0 {
		return ""
	}
	return string(b[:i])
}

// bundleName returns the name of the innermost .app bundle whose
// Contents/MacOS holds the executable, without ".app"; "" if there is none.
func bundleName(path string) string {
	const marker = ".app/Contents/MacOS/"
	i := strings.LastIndex(path, marker)
	if i < 0 {
		return ""
	}
	dir := path[:i]
	return dir[strings.LastIndexByte(dir, '/')+1:]
}

// cString returns b up to its first NUL.
func cString(b []byte) string {
	if i := bytes.IndexByte(b, 0); i >= 0 {
		b = b[:i]
	}
	return string(b)
}
