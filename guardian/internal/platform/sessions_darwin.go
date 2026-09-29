package platform

import (
	"fmt"
	"os"
	"syscall"
)

// osSessions reports the user who owns /dev/console (loginwindow hands it
// to the user at login and back to root at logout), the documented way to
// find the console user without CoreFoundation. Its logon time is unknown
// here; SessionWatcher records the moment it sees the owner change. Fast
// user switching changes the owner without a logoff, which the watcher then
// reports as one (docs/ARCHITECTURE.md §16.3).
func osSessions() ([]LogonSession, error) {
	fi, err := os.Stat("/dev/console")
	if err != nil {
		return nil, err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || st.Uid < 501 {
		return nil, nil
	}
	return []LogonSession{{ID: fmt.Sprintf("console:%d", st.Uid), Console: true}}, nil
}
