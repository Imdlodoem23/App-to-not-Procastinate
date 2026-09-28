package hosts

import (
	"os"

	"github.com/imdlodoem23/centrate/guardian/internal/procwatch"
)

// LockHolder is a process that holds the hosts file open in a way that keeps
// the guardian from writing it (Windows share modes are mandatory: any user
// can read the hosts file, and a reader that denies write sharing blocks
// every writer).
type LockHolder struct {
	// PID is the process ID.
	PID int
	// Name is the executable file name ("powershell.exe"), or "" when it
	// could not be read.
	Name string
	// Session is the Windows session the process runs in (0: services).
	Session uint32
	// Service reports a Windows service, and Critical a process the system
	// cannot run without (Restart Manager's RmService and RmCritical); the
	// shell (RmExplorer) is reported as Critical too.
	Service, Critical bool
}

// breakable reports whether the guardian may close h to free the hosts file:
// an ordinary process in an interactive session, never a service, a critical
// or protected process, the guardian itself, or PIDs 0 to 4. Session-0 and
// system holders (antivirus, backup, indexer) are waited for instead;
// procwatch.Kill also refuses processes running as LocalSystem,
// LocalService or NetworkService in a user session.
func breakable(h LockHolder, self int) bool {
	return h.PID > 4 && h.PID != self && h.Session != 0 && !h.Service && !h.Critical &&
		h.Name != "" && !procwatch.IsProtected(h.Name)
}

// breakLocks closes the breakable processes that hold target open and
// returns the ones it closed. Callers hold m.mu.
func (m *Manager) breakLocks(target string) []LockHolder {
	find, kill := m.lockHolders, m.killHolder
	if find == nil {
		find = osLockHolders
	}
	if kill == nil {
		kill = osKillHolder
	}
	holders, err := find(target)
	if err != nil {
		m.logger().Warn("hosts: cannot list the processes holding the file", "err", err)
		return nil
	}
	self := os.Getpid()
	var closed []LockHolder
	for _, h := range holders {
		if !breakable(h, self) {
			m.logger().Info("hosts: file held by a system process, waiting", "pid", h.PID)
			continue
		}
		if err := kill(h); err != nil {
			m.logger().Warn("hosts: could not close a process holding the file", "pid", h.PID, "err", err)
			continue
		}
		closed = append(closed, h)
	}
	if len(closed) > 0 {
		m.logger().Warn("hosts: closed processes that kept the file from being written", "count", len(closed))
	}
	return closed
}

// osKillHolder closes a holder the way blocked apps are closed.
func osKillHolder(h LockHolder) error { return procwatch.Kill(h.PID, h.Name) }
