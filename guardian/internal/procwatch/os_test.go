package procwatch

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

// helperEnv makes the test binary act as a helper process instead of running
// the tests (see TestMain).
const helperEnv = "PROCWATCH_TEST_HELPER"

// fakeSelfPID stands for the guardian's own PID in tests that describe
// processes with made-up PIDs (100, 800…). With the test binary's real PID,
// a fixture that happens to use it would describe a second process with the
// guardian's PID, which is protected, and the test would fail at random:
// Windows hands out low PIDs again and again, and containers count from 1.
// fakeSelfPID is odd, which no Windows PID is (they are multiples of 4), and
// above the PID limits of Linux (2^22) and macOS (99 999), so it is never a
// real process either. Tests of the real OS protect the real PID instead (see
// supportedOS).
const fakeSelfPID = 1<<22 + 1

func TestMain(m *testing.M) {
	if mode := os.Getenv(helperEnv); mode != "" {
		runHelper(mode)
		return
	}
	selfPID = fakeSelfPID
	os.Exit(m.Run())
}

// runHelper sleeps until killed. "ignore-term" ignores SIGTERM first.
func runHelper(mode string) {
	if mode == "ignore-term" {
		signal.Ignore(syscall.SIGTERM)
	}
	fmt.Println("ready")
	time.Sleep(2 * time.Minute)
	os.Exit(3)
}

// supportedOS starts a test of the real processes: it skips the test where
// listing them is not implemented, and runs it with the real PID protected.
func supportedOS(t *testing.T) {
	t.Helper()
	switch runtime.GOOS {
	case "windows", "linux", "darwin":
	default:
		t.Skip("process listing is not implemented on", runtime.GOOS)
	}
	useRealSelfPID(t)
}

// useRealSelfPID protects the test binary's real PID, as production protects
// the guardian's, until the test ends (see fakeSelfPID).
func useRealSelfPID(t *testing.T) {
	t.Helper()
	selfPID = os.Getpid()
	t.Cleanup(func() { selfPID = fakeSelfPID })
}

// helperName is the executable name of the helper copies: not the test
// binary's own name, which is protected like the guardian's.
func helperName() string {
	if runtime.GOOS == "windows" {
		return "pwhelper.exe"
	}
	return "pwhelper"
}

// skipIfSystem skips a test that needs the package to match or kill the
// test's own child processes when the tests run as a system account (root,
// or a Windows service in session 0): such processes are never matched or
// killed.
func skipIfSystem(t *testing.T) {
	t.Helper()
	procs, err := List()
	if err != nil {
		t.Fatal(err)
	}
	if findPID(t, procs, os.Getpid()).System {
		t.Skip("the tests run as a system account (root or session 0), whose processes are never matched or killed")
	}
}

// startHelper copies the test binary as helperName into a temp dir and runs
// it in the given mode. The caller must not reap it before Kill returns, so
// Kill also meets zombies (Unix).
func startHelper(t *testing.T, mode string) *exec.Cmd { return startHelperAs(t, mode, "") }

// startHelperAs is startHelper with argv[0] set to arg0 when it is not "".
func startHelperAs(t *testing.T, mode, arg0 string) *exec.Cmd {
	t.Helper()
	skipIfSystem(t)
	return spawnHelper(t, mode, arg0)
}

// spawnHelper starts the helper whatever account the tests run as.
func spawnHelper(t *testing.T, mode, arg0 string) *exec.Cmd {
	t.Helper()
	useRealSelfPID(t)
	exe, err := os.Executable()
	if err != nil {
		t.Skip("os.Executable:", err)
	}
	dst := filepath.Join(t.TempDir(), helperName())
	copyFile(t, exe, dst)

	var cmd *exec.Cmd
	var stdout io.ReadCloser
	for attempt := 0; ; attempt++ {
		cmd = exec.Command(dst)
		if arg0 != "" {
			cmd.Args = []string{arg0}
		}
		cmd.Env = append(os.Environ(), helperEnv+"="+mode)
		if stdout, err = cmd.StdoutPipe(); err != nil {
			t.Fatal(err)
		}
		err = cmd.Start()
		// ETXTBSY: another test's fork still held the file open for writing.
		if err == nil || attempt == 10 || !strings.Contains(err.Error(), "busy") {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err != nil {
		t.Fatal("start helper:", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})

	ready := make(chan error, 1)
	go func() {
		line, err := bufio.NewReader(stdout).ReadString('\n')
		if err == nil && strings.TrimSpace(line) != "ready" {
			err = fmt.Errorf("unexpected helper output %q", line)
		}
		ready <- err
	}()
	select {
	case err := <-ready:
		if err != nil {
			t.Fatal("helper:", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("helper did not start")
	}
	return cmd
}

func copyFile(t *testing.T, src, dst string) {
	t.Helper()
	in, err := os.Open(src)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
}

// waitExit reaps the helper and fails if it exited on its own.
func waitExit(t *testing.T, cmd *exec.Cmd) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			t.Fatalf("helper Wait = %v, want it killed", err)
		}
		if exitErr.ExitCode() == 3 {
			t.Fatal("helper exited on its own")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("helper still running after Kill")
	}
}

func findPID(t *testing.T, procs []Process, pid int) Process {
	t.Helper()
	for _, p := range procs {
		if p.PID == pid {
			return p
		}
	}
	t.Fatalf("PID %d not in List() (%d processes)", pid, len(procs))
	return Process{}
}

// TestListFindsSelf lists the real processes (Toolhelp on Windows, /proc on
// Linux, ps on macOS) and finds the test binary itself, with its full name.
func TestListFindsSelf(t *testing.T) {
	supportedOS(t)
	exe, err := os.Executable()
	if err != nil {
		t.Skip("os.Executable:", err)
	}
	procs, err := List()
	if err != nil {
		t.Fatal(err)
	}
	if len(procs) < 2 {
		t.Fatalf("List returned %d processes", len(procs))
	}
	self := findPID(t, procs, os.Getpid())
	if !sameName(runtime.GOOS, self.Name, filepath.Base(exe)) {
		t.Errorf("own process listed as %q, want %q", self.Name, filepath.Base(exe))
	}
	// Windows lists no paths (it would have to open every process); Kill
	// reads it through the process handle.
	switch {
	case runtime.GOOS == "windows" && self.Path != "":
		t.Errorf("own process listed with path %q; List should not resolve paths on Windows", self.Path)
	case runtime.GOOS != "windows" && !self.System && self.Path == "":
		t.Error("own process listed without a path")
	case self.Path != "" && !sameName(runtime.GOOS, baseName(self.Path), filepath.Base(exe)):
		t.Errorf("own path %q does not end in %q", self.Path, filepath.Base(exe))
	}
	if self.PPID != os.Getppid() {
		t.Errorf("own parent PID listed as %d, want %d", self.PPID, os.Getppid())
	}
	if runtime.GOOS != "windows" && os.Geteuid() == 0 && !self.System {
		t.Error("own process runs as root but is not System")
	}
}

// TestListIgnoresArgv0 starts the helper with a decoy argv[0]: List still
// reports the executable's own name (the kernel's, not the launcher's), so
// the Matcher and Kill still find it.
func TestListIgnoresArgv0(t *testing.T) {
	supportedOS(t)
	cmd := startHelperAs(t, "sleep", "Notes")
	procs, err := List()
	if err != nil {
		t.Fatal(err)
	}
	p := findPID(t, procs, cmd.Process.Pid)
	if p.Name != helperName() {
		t.Errorf("helper started as %q listed as %q, want %q", "Notes", p.Name, helperName())
	}
	if _, ok := NewMatcher([]string{"Notes"}).Match(p); ok {
		t.Errorf("the decoy argv[0] matched: %+v", p)
	}
	if target, ok := NewMatcher([]string{"pwhelper"}).Match(p); !ok || target != "pwhelper" {
		t.Errorf("Matcher(pwhelper).Match(%+v) = %q, %v", p, target, ok)
	}
	if err := (OSKiller{Grace: 10 * time.Second}).Kill(cmd.Process.Pid, helperName()); err != nil {
		t.Fatalf("Kill = %v", err)
	}
	waitExit(t, cmd)
}

func TestListAndMatchHelper(t *testing.T) {
	supportedOS(t)
	cmd := startHelper(t, "sleep")
	procs, err := List()
	if err != nil {
		t.Fatal(err)
	}
	p := findPID(t, procs, cmd.Process.Pid)
	if p.Name != helperName() {
		t.Errorf("helper listed as %q, want %q", p.Name, helperName())
	}
	if target, ok := NewMatcher([]string{"pwhelper"}).Match(p); !ok || target != "pwhelper" {
		t.Errorf("Matcher(pwhelper).Match(%+v) = %q, %v", p, target, ok)
	}
}

func TestKillHelper(t *testing.T) {
	supportedOS(t)
	cmd := startHelper(t, "sleep")
	start := time.Now()
	if err := (OSKiller{Grace: 10 * time.Second}).Kill(cmd.Process.Pid, helperName()); err != nil {
		t.Fatalf("Kill = %v", err)
	}
	if d := time.Since(start); d > 8*time.Second {
		t.Errorf("Kill took %v; the process ignored SIGTERM or the exit was not noticed", d)
	}
	waitExit(t, cmd)
}

func TestKillChecksTheName(t *testing.T) {
	supportedOS(t)
	cmd := startHelper(t, "sleep")
	pid := cmd.Process.Pid
	if err := Kill(pid, "not-the-helper"); !errors.Is(err, ErrNameMismatch) {
		t.Fatalf("Kill with another name = %v, want ErrNameMismatch", err)
	}
	// Still alive: the right name kills it.
	if err := Kill(pid, helperName()); err != nil {
		t.Fatalf("Kill = %v", err)
	}
	waitExit(t, cmd)
}

func TestKillGoneProcess(t *testing.T) {
	supportedOS(t)
	cmd := startHelper(t, "sleep")
	pid := cmd.Process.Pid
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	err := Kill(pid, helperName())
	if !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrNameMismatch) {
		t.Fatalf("Kill of a reaped PID = %v, want ErrNotFound (or ErrNameMismatch if reused)", err)
	}
}

func TestKillRefusesProtected(t *testing.T) {
	useRealSelfPID(t)
	tests := []struct {
		pid  int
		name string
		want error
	}{
		{os.Getpid(), "anything", ErrProtected},
		{os.Getpid(), filepath.Base(os.Args[0]), ErrProtected},
		{123456, "explorer.exe", ErrProtected},
		{123456, "Céntrate", ErrProtected},
		{0, "Discord", ErrInvalid},
		{-1, "Discord", ErrInvalid},
		{123456, "", ErrInvalid},
	}
	for _, tc := range tests {
		if err := Kill(tc.pid, tc.name); !errors.Is(err, tc.want) {
			t.Errorf("Kill(%d, %q) = %v, want %v", tc.pid, tc.name, err, tc.want)
		}
	}
}

// TestWatcherClosesHelper runs the real lister and killer end to end.
func TestWatcherClosesHelper(t *testing.T) {
	supportedOS(t)
	cmd := startHelper(t, "sleep")
	killed := make(chan Killed, 4)
	ticker := &fakeTicker{c: make(chan time.Time)}
	w := &Watcher{
		Killer:    OSKiller{Grace: 10 * time.Second},
		NewTicker: func(time.Duration) Ticker { return ticker },
	}
	m := NewMatcher([]string{"pwhelper"})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		w.Run(ctx, func() Matcher { return m }, func(k Killed) { killed <- k })
	}()
	defer func() {
		cancel()
		<-done
	}()
	select {
	case k := <-killed:
		if len(k.PIDs) != 1 || k.PIDs[0] != cmd.Process.Pid || k.Name != helperName() || k.Target != "pwhelper" || k.At.IsZero() {
			t.Errorf("Killed = %+v", k)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the watcher did not close the helper")
	}
	waitExit(t, cmd)
}

// TestSystemHelperIsNeverTouched is the other side of skipIfSystem: when the
// tests run as a system account (root, or a Windows service in session 0, as
// in some CI containers), a real child process is listed as System, never
// matched, and Kill refuses it.
func TestSystemHelperIsNeverTouched(t *testing.T) {
	supportedOS(t)
	procs, err := List()
	if err != nil {
		t.Fatal(err)
	}
	if !findPID(t, procs, os.Getpid()).System {
		t.Skip("the tests run as an interactive user")
	}
	cmd := spawnHelper(t, "sleep", "")
	if procs, err = List(); err != nil {
		t.Fatal(err)
	}
	p := findPID(t, procs, cmd.Process.Pid)
	if !p.System {
		t.Errorf("helper of a system account listed as a user process: %+v", p)
	}
	if target, ok := NewMatcher([]string{"pwhelper"}).Match(p); ok {
		t.Errorf("system helper matched %q", target)
	}
	if err := Kill(cmd.Process.Pid, helperName()); !errors.Is(err, ErrProtected) {
		t.Errorf("Kill of a system helper = %v, want ErrProtected", err)
	}
	// Still running: List skips zombies and exited processes.
	if procs, err = List(); err != nil {
		t.Fatal(err)
	}
	findPID(t, procs, cmd.Process.Pid)
}
