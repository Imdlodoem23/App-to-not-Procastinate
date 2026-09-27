package main

import (
	"bytes"
	"errors"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/hosts"
	"github.com/imdlodoem23/centrate/guardian/internal/platform"
	"github.com/imdlodoem23/centrate/guardian/internal/svc"
)

const userHosts = "127.0.0.1 localhost\n::1 localhost\n"

// testSystem points the data folder and the hosts file at temporary paths
// and returns them. The hosts file holds userHosts plus a Céntrate section.
func testSystem(t *testing.T) (dataDir, hostsPath string) {
	t.Helper()
	base := t.TempDir()
	dataDir = filepath.Join(base, "Centrate")
	hostsPath = filepath.Join(base, "hosts")
	t.Setenv(platform.EnvDataDir, dataDir)
	t.Setenv(platform.EnvHostsPath, hostsPath)
	if err := os.WriteFile(hostsPath, []byte(userHosts), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := (&hosts.Manager{Path: hostsPath}).Apply([]string{"youtube.com", "www.youtube.com"}); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(hostsPath); bytes.Equal(got, []byte(userHosts)) {
		t.Fatal("setup: no section written")
	}
	return dataDir, hostsPath
}

func TestHostsCleanupIsWired(t *testing.T) {
	if svc.RemoveHostsSection == nil {
		t.Fatal("svc.RemoveHostsSection must be wired for every build")
	}
}

func TestDefaultAppCleansHostsSection(t *testing.T) {
	dataDir, hostsPath := testSystem(t)
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := defaultApp().cleanupHosts(); err != nil {
		t.Fatalf("cleanupHosts = %v", err)
	}
	if got, _ := os.ReadFile(hostsPath); string(got) != userHosts {
		t.Fatalf("hosts = %q, want %q", got, userHosts)
	}
	// The pre-change copy went to the guardian's backup folder.
	if _, err := os.Stat(filepath.Join(platform.BackupDir(), hosts.BackupName)); err != nil {
		t.Fatalf("no backup: %v", err)
	}
	// Twice is fine.
	if err := defaultApp().cleanupHosts(); err != nil {
		t.Fatalf("second cleanupHosts = %v", err)
	}
}

func TestCleanupWithoutDataDirDoesNotCreateIt(t *testing.T) {
	dataDir, hostsPath := testSystem(t)
	if err := defaultApp().cleanupHosts(); err != nil {
		t.Fatalf("cleanupHosts = %v", err)
	}
	if got, _ := os.ReadFile(hostsPath); string(got) != userHosts {
		t.Fatalf("hosts = %q", got)
	}
	if _, err := os.Lstat(dataDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cleanup created the data folder: %v", err)
	}
}

func TestCleanupRestoresDamagedHosts(t *testing.T) {
	dataDir, hostsPath := testSystem(t)
	good, _ := os.ReadFile(hostsPath)
	backups := filepath.Join(dataDir, "backups")
	if err := os.MkdirAll(backups, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(backups, hosts.BackupName), good, 0o644); err != nil {
		t.Fatal(err)
	}
	// An interrupted in-place write left zero-filled blocks.
	if err := os.WriteFile(hostsPath, append([]byte("127.0.0.1 local"), make([]byte, 64)...), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := defaultApp().cleanupHosts(); err != nil {
		t.Fatalf("cleanupHosts = %v", err)
	}
	if got, _ := os.ReadFile(hostsPath); string(got) != userHosts {
		t.Fatalf("hosts = %q, want the backup without the section %q", got, userHosts)
	}
}

func TestUninstallCleansHostsAndData(t *testing.T) {
	dataDir, hostsPath := testSystem(t)
	if err := platform.EnsureDataDir(); err != nil {
		t.Fatal(err)
	}
	a, calls, _, stderr := newTestApp(env{elevated: true})
	d := defaultApp()
	a.cleanupHosts, a.removeData, a.dataDir = d.cleanupHosts, d.removeData, d.dataDir
	if code := a.run([]string{"uninstall"}); code != exitOK {
		t.Fatalf("uninstall = %d (%v): %s", code, *calls, stderr)
	}
	if got, _ := os.ReadFile(hostsPath); string(got) != userHosts {
		t.Fatalf("hosts = %q", got)
	}
	if _, err := os.Lstat(dataDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("data folder left behind: %v", err)
	}
}

func TestEmbedsTimeZones(t *testing.T) {
	f, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, parser.ImportsOnly)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, imp := range f.Imports {
		if p, _ := strconv.Unquote(imp.Path.Value); p == "time/tzdata" {
			found = true
		}
	}
	if !found {
		t.Fatal(`main.go must import _ "time/tzdata" (Windows has no zoneinfo database)`)
	}
	loc, err := time.LoadLocation("Europe/Madrid")
	if err != nil {
		t.Fatal(err)
	}
	summer := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC).In(loc)
	if _, offset := summer.Zone(); offset != 2*3600 {
		t.Fatalf("Europe/Madrid summer offset = %d", offset)
	}
}
