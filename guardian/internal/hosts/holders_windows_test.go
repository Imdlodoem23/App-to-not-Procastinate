package hosts

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// holdShareRead opens path the way an unprivileged user can: read access,
// sharing only reads, so every writer fails with a sharing violation.
func holdShareRead(t *testing.T, path string) {
	t.Helper()
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = windows.CloseHandle(h) })
}

func TestRestartManagerFindsShareReadHolder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hosts")
	if err := os.WriteFile(path, []byte(windowsDefaultHosts), 0o644); err != nil {
		t.Fatal(err)
	}
	holdShareRead(t, path)
	holders, err := osLockHolders(path)
	if err != nil {
		t.Skipf("Restart Manager unavailable: %v", err)
	}
	self := os.Getpid()
	for _, h := range holders {
		if h.PID == self {
			if breakable(h, self) {
				t.Fatal("the guardian's own process is breakable")
			}
			return
		}
	}
	t.Fatalf("holders %+v do not include this process (%d)", holders, self)
}

// A FILE_SHARE_READ holder makes both write paths fail with a lock error,
// which is what triggers BreakLocks; the holder here is the test process
// itself, which is never closed.
func TestShareReadHolderBlocksWrites(t *testing.T) {
	m, path := newManager(t, []byte(windowsDefaultHosts))
	m.sleep = func(time.Duration) {}
	holdShareRead(t, path)
	m.BreakLocks = true
	var looked bool
	m.lockHolders = func(p string) ([]LockHolder, error) {
		looked = true
		return osLockHolders(p)
	}
	m.killHolder = func(h LockHolder) error { t.Fatalf("closed %+v", h); return nil }
	err := m.Apply([]string{"a.com"})
	if err == nil || !isTransientLock(err) {
		t.Fatalf("Apply = %v, want a lock error", err)
	}
	if !looked {
		t.Fatal("BreakLocks did not look for the holders")
	}
}
