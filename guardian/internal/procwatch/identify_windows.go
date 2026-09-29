package procwatch

import (
	"sync"

	"golang.org/x/sys/windows"
)

var (
	peIdentities = fileIdentities{read: PEIdentity}

	winIdentMu sync.Mutex
	winIdent   = map[winProcKey]winIdentEntry{}
)

// winProcKey identifies one process: a PID is only reused by a process with
// another creation time.
type winProcKey struct {
	pid     int
	created int64
}

type winIdentEntry struct{ path, id string }

// identify fills Path and Identity of the processes in user sessions. Each
// process is opened (PROCESS_QUERY_LIMITED_INFORMATION) once in its life;
// entries of processes no longer listed are dropped.
func identify(procs []Process) {
	winIdentMu.Lock()
	defer winIdentMu.Unlock()
	seen := make(map[winProcKey]bool, len(procs))
	for i := range procs {
		p := &procs[i]
		if p.System || p.PID <= 4 {
			continue
		}
		k := winProcKey{p.PID, p.created}
		seen[k] = true
		e, ok := winIdent[k]
		if !ok {
			e.path = queryImagePath(p.PID)
			e.id = peIdentities.get(e.path)
			winIdent[k] = e
		}
		if e.path != "" && sameName("windows", baseName(e.path), p.Name) {
			p.Path, p.Identity = e.path, e.id
		}
	}
	for k := range winIdent {
		if !seen[k] {
			delete(winIdent, k)
		}
	}
}

// queryImagePath returns the image path of pid, or "".
func queryImagePath(pid int) string {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return ""
	}
	defer func() { _ = windows.CloseHandle(h) }()
	path, err := imagePath(h)
	if err != nil {
		return ""
	}
	return path
}
