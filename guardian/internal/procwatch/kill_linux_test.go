package procwatch

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// withoutPidfd runs f with the PID-only fallback used on kernels older than
// 5.3.
func withoutPidfd(t *testing.T, f func()) {
	t.Helper()
	usePidfd = false
	defer func() { usePidfd = true }()
	f()
}

func TestKillWithoutPidfd(t *testing.T) {
	withoutPidfd(t, func() {
		cmd := startHelper(t, "sleep")
		if err := Kill(cmd.Process.Pid, helperName()); err != nil {
			t.Fatalf("Kill = %v", err)
		}
		waitExit(t, cmd)

		cmd = startHelper(t, "ignore-term")
		if err := (OSKiller{Grace: 200 * time.Millisecond}).Kill(cmd.Process.Pid, helperName()); err != nil {
			t.Fatalf("Kill (ignoring SIGTERM) = %v", err)
		}
		waitExit(t, cmd)

		cmd = startHelper(t, "sleep")
		if err := Kill(cmd.Process.Pid, "other"); !errors.Is(err, ErrNameMismatch) {
			t.Fatalf("Kill with another name = %v, want ErrNameMismatch", err)
		}
	})
}

func TestProcFSReadsSelf(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Skip(err)
	}
	p, err := sysProc.read(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if p.Name != filepath.Base(exe) || p.Comm == "" || p.Path == "" {
		t.Errorf("read(self) = %+v, want name %q", p, filepath.Base(exe))
	}
	if sysProc.exited(os.Getpid()) {
		t.Error("exited(self) = true")
	}
}
