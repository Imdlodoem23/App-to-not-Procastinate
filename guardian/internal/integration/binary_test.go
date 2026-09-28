package integration

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

// buildGuardian builds cmd/centrate-guardian into a temporary folder. The
// centrate_dev tag makes the binary honour CENTRATE_DATA_DIR even when the tests run
// elevated (CI runners, containers as root); release builds never do.
func buildGuardian(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("builds the guardian binary")
	}
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("no go tool in PATH")
	}
	root, err := moduleRoot()
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "centrate-guardian")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	cmd := exec.Command(goBin, "build", "-tags", "centrate_dev", "-o", bin, "./cmd/centrate-guardian")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

// moduleRoot is the guardian module's folder (the one with go.mod).
func moduleRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("go.mod not found")
		}
		dir = parent
	}
}

// runHasActive runs `centrate-guardian has-active` on the system's data folder and
// returns its exit code and stdout.
func runHasActive(t *testing.T, bin string, sys *system) (int, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	cmd := exec.Command(bin, "has-active")
	cmd.Env = append(os.Environ(), "CENTRATE_DATA_DIR="+sys.dataDir, "CENTRATE_HOSTS_PATH="+sys.hostsPath)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return 0, strings.TrimSpace(stdout.String())
	case errors.As(err, &exit):
		return exit.ExitCode(), strings.TrimSpace(stdout.String())
	}
	t.Fatalf("has-active: %v (%s)", err, stderr.String())
	return 0, ""
}

// TestBinaryHasActiveExitCodes runs the real binary's has-active against a data folder
// the guardian wrote: exit 10 for a normal block, 11 for a hardcore one, 0 once they
// ended and 1 when state.json is unreadable. The binary uses the machine's real clocks
// (another boot for it: it trusts the later of the saved time and the wall clock), so
// the fake clock starts now.
func TestBinaryHasActiveExitCodes(t *testing.T) {
	bin := buildGuardian(t)
	clk := engine.NewFakeClock(time.Now().UTC().Truncate(time.Millisecond))
	sys := newSystem(t, clk)

	if code, out := runHasActive(t, bin, sys); code != 0 || out != `{"active":false}` {
		t.Fatalf("never installed: exit %d %s", code, out)
	}
	sys.start()
	sys.createBlock(engine.ModeNormal, 60, "youtube")
	sys.stop()
	if code, out := runHasActive(t, bin, sys); code != 10 || out != `{"active":true}` {
		t.Fatalf("normal block: exit %d %s", code, out)
	}
	sys.start()
	sys.createBlock(engine.ModeHardcore, 30, "tiktok")
	sys.stop()
	if code, _ := runHasActive(t, bin, sys); code != 11 {
		t.Fatalf("hardcore block: exit %d, want 11", code)
	}
	sys.start()
	sys.advance(61 * time.Minute)
	sys.stop()
	if code, out := runHasActive(t, bin, sys); code != 0 || out != `{"active":false}` {
		t.Fatalf("after the ends: exit %d %s", code, out)
	}
	for _, name := range []string{"state.json", "state.prev.json"} {
		if err := os.WriteFile(filepath.Join(sys.dataDir, name), []byte("{"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if code, _ := runHasActive(t, bin, sys); code != 1 {
		t.Fatalf("unreadable state: exit %d, want 1", code)
	}
}
