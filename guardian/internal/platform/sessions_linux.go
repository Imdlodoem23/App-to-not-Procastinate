package platform

import (
	"time"

	"golang.org/x/sys/unix"

	"github.com/imdlodoem23/centrate/guardian/internal/clock"
)

// logindSessionsDir holds one file per logind session.
var logindSessionsDir = "/run/systemd/sessions"

func osSessions() ([]LogonSession, error) {
	var ts unix.Timespec
	mono := time.Duration(-1)
	if err := unix.ClockGettime(unix.CLOCK_MONOTONIC, &ts); err == nil {
		mono = time.Duration(ts.Nano())
	}
	return readLogindSessions(logindSessionsDir, clock.BootTime(), mono)
}
