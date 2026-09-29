package hosts

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestFlushWindowsRunsIpconfig(t *testing.T) {
	var calls [][]string
	run := func(_ context.Context, path string, args ...string) ([]byte, error) {
		calls = append(calls, append([]string{path}, args...))
		return nil, nil
	}
	if err := flushDNS(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	sys, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	want := [][]string{{filepath.Join(sys, "ipconfig.exe"), "/flushdns"}}
	if !slices.EqualFunc(calls, want, slices.Equal) {
		t.Fatalf("calls = %q, want %q", calls, want)
	}
	if !strings.EqualFold(filepath.Base(calls[0][0]), "ipconfig.exe") {
		t.Fatalf("binary %q", calls[0][0])
	}
}

func TestNewCommandHidesWindow(t *testing.T) {
	cmd := newCommand(context.Background(), `C:\Windows\System32\ipconfig.exe`, "/flushdns")
	a := cmd.SysProcAttr
	if a == nil || !a.HideWindow || a.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Fatalf("SysProcAttr = %+v", a)
	}
}
