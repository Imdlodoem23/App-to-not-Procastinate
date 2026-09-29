package procwatch

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

// fakeProc is a process behind a fake procTarget.
type fakeProc struct {
	name       string
	bundle     string
	path       string
	system     bool
	gone       bool   // exited (identity says ErrNotFound)
	ignoreTerm bool   // survives SIGTERM
	unkillable bool   // survives SIGKILL too
	reusedAs   string // after an ignored SIGTERM, the PID shows this name
	signalErr  error  // returned by every signal call

	signals []string        // "term" / "kill"
	waits   []time.Duration // durations passed to wait
	closed  bool
}

type fakeTarget struct {
	f   *fakeProc
	pid int
}

func (t fakeTarget) identity() (Process, error) {
	if t.f.gone {
		return Process{}, ErrNotFound
	}
	return Process{PID: t.pid, Name: t.f.name, Bundle: t.f.bundle, Path: t.f.path, System: t.f.system}, nil
}

func (t fakeTarget) signal(force bool) error {
	if t.f.signalErr != nil {
		return t.f.signalErr
	}
	if t.f.gone {
		return ErrNotFound
	}
	if force {
		t.f.signals = append(t.f.signals, "kill")
		t.f.gone = !t.f.unkillable
		return nil
	}
	t.f.signals = append(t.f.signals, "term")
	if !t.f.ignoreTerm {
		t.f.gone = true
	} else if t.f.reusedAs != "" {
		t.f.name = t.f.reusedAs
	}
	return nil
}

func (t fakeTarget) wait(d time.Duration) bool {
	t.f.waits = append(t.f.waits, d)
	return t.f.gone
}

func (t fakeTarget) close() { t.f.closed = true }

func fakePlan(goos string, graceful bool, f *fakeProc, openErr error) (killPlan, *int) {
	opened := new(int)
	return killPlan{
		goos: goos,
		open: func(pid int) (procTarget, error) {
			*opened++
			if openErr != nil {
				return nil, openErr
			}
			return fakeTarget{f: f, pid: pid}, nil
		},
		graceful:  graceful,
		grace:     1500 * time.Millisecond,
		forceWait: time.Second,
	}, opened
}

func TestKillPlan(t *testing.T) {
	errDenied := errors.New("access denied")
	tests := []struct {
		name     string
		goos     string
		graceful bool
		proc     fakeProc
		openErr  error
		pid      int
		kill     string // name passed to kill
		wantErr  error
		wantSigs []string
		wantWait []time.Duration
	}{
		{
			name: "exits after SIGTERM", goos: "linux", graceful: true,
			proc: fakeProc{name: "Discord"}, pid: 100, kill: "Discord",
			wantSigs: []string{"term"}, wantWait: []time.Duration{1500 * time.Millisecond},
		},
		{
			name: "ignores SIGTERM, SIGKILL after the grace period", goos: "linux", graceful: true,
			proc: fakeProc{name: "Discord", ignoreTerm: true}, pid: 100, kill: "Discord",
			wantSigs: []string{"term", "kill"}, wantWait: []time.Duration{1500 * time.Millisecond, time.Second},
		},
		{
			name: "survives everything", goos: "linux", graceful: true,
			proc: fakeProc{name: "Discord", ignoreTerm: true, unkillable: true}, pid: 100, kill: "Discord",
			wantErr: ErrStillRunning, wantSigs: []string{"term", "kill"},
			wantWait: []time.Duration{1500 * time.Millisecond, time.Second},
		},
		{
			name: "PID reused during the grace period: no SIGKILL", goos: "linux", graceful: true,
			proc: fakeProc{name: "Discord", ignoreTerm: true, reusedAs: "bash"}, pid: 100, kill: "Discord",
			wantSigs: []string{"term"}, wantWait: []time.Duration{1500 * time.Millisecond},
		},
		{
			name: "no graceful step (Windows)", goos: "windows", graceful: false,
			proc: fakeProc{name: "Discord.exe"}, pid: 100, kill: "discord.EXE",
			wantSigs: []string{"kill"}, wantWait: []time.Duration{time.Second},
		},
		{
			name: "name changed before the first signal", goos: "linux", graceful: true,
			proc: fakeProc{name: "bash"}, pid: 100, kill: "Discord",
			wantErr: ErrNameMismatch,
		},
		{
			name: "name comparison follows the OS: exact on Linux", goos: "linux", graceful: true,
			proc: fakeProc{name: "discord"}, pid: 100, kill: "Discord",
			wantErr: ErrNameMismatch,
		},
		{
			name: "already gone at open", goos: "linux", graceful: true,
			openErr: ErrNotFound, pid: 100, kill: "Discord",
			wantErr: ErrNotFound,
		},
		{
			name: "already gone at identity", goos: "linux", graceful: true,
			proc: fakeProc{name: "Discord", gone: true}, pid: 100, kill: "Discord",
			wantErr: ErrNotFound,
		},
		{
			name: "signal error is returned", goos: "linux", graceful: true,
			proc: fakeProc{name: "Discord", signalErr: errDenied}, pid: 100, kill: "Discord",
			wantErr: errDenied,
		},
		{
			name: "current process is a system process (root, session 0, service account)", goos: "linux", graceful: true,
			proc: fakeProc{name: "python3", system: true}, pid: 100, kill: "python3",
			wantErr: ErrProtected,
		},
		{
			name: "windows service found at kill time", goos: "windows", graceful: false,
			proc: fakeProc{name: "SteamService.exe", system: true}, pid: 100, kill: "SteamService.exe",
			wantErr: ErrProtected,
		},
		{
			name: "current process has a protected executable path", goos: "windows", graceful: false,
			proc: fakeProc{name: "Helper.exe", path: `C:\Windows\explorer.exe`}, pid: 100, kill: "Helper.exe",
			wantErr: ErrProtected,
		},
		{
			name: "a renamed bundle does not protect", goos: "darwin", graceful: true,
			proc: fakeProc{name: "Discord", bundle: "Céntrate"}, pid: 100, kill: "Discord",
			wantSigs: []string{"term"}, wantWait: []time.Duration{1500 * time.Millisecond},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := tc.proc
			kp, opened := fakePlan(tc.goos, tc.graceful, &f, tc.openErr)
			err := kp.kill(tc.pid, tc.kill)
			if !errors.Is(err, tc.wantErr) || (tc.wantErr == nil && err != nil) {
				t.Fatalf("kill = %v, want %v", err, tc.wantErr)
			}
			if !reflect.DeepEqual(f.signals, tc.wantSigs) {
				t.Errorf("signals = %q, want %q", f.signals, tc.wantSigs)
			}
			if !reflect.DeepEqual(f.waits, tc.wantWait) {
				t.Errorf("waits = %v, want %v", f.waits, tc.wantWait)
			}
			if *opened == 1 && tc.openErr == nil && !f.closed {
				t.Error("target not closed")
			}
		})
	}
}

func TestKillPlanRefusesBeforeOpening(t *testing.T) {
	tests := []struct {
		goos string
		pid  int
		name string
		want error
	}{
		{"linux", 0, "Discord", ErrInvalid},
		{"linux", -3, "Discord", ErrInvalid},
		{"linux", 100, "", ErrInvalid},
		{"linux", 1, "Discord", ErrProtected},
		{"windows", 4, "Discord.exe", ErrProtected},
		{"linux", selfPID, "Discord", ErrProtected},
		{"windows", 100, "explorer.exe", ErrProtected},
		{"windows", 100, "EXPLORER", ErrProtected},
		{"darwin", 100, "Finder", ErrProtected},
		{"linux", 100, "Céntrate", ErrProtected},
	}
	for _, tc := range tests {
		f := fakeProc{name: tc.name}
		kp, opened := fakePlan(tc.goos, true, &f, nil)
		if err := kp.kill(tc.pid, tc.name); !errors.Is(err, tc.want) {
			t.Errorf("kill(%s, %d, %q) = %v, want %v", tc.goos, tc.pid, tc.name, err, tc.want)
		}
		if *opened != 0 {
			t.Errorf("kill(%s, %d, %q) opened the process", tc.goos, tc.pid, tc.name)
		}
	}
}

func TestKillPlanGoneAfterTerm(t *testing.T) {
	// SIGTERM ignored, then the process exits by itself right before SIGKILL:
	// the signal fails with ErrNotFound, which counts as closed.
	f := fakeProc{name: "Discord", ignoreTerm: true}
	kp, _ := fakePlan("linux", true, &f, nil)
	kp.open = func(pid int) (procTarget, error) { return exitBeforeKill{fakeTarget{f: &f, pid: pid}}, nil }
	if err := kp.kill(100, "Discord"); err != nil {
		t.Fatalf("kill = %v", err)
	}
}

// exitBeforeKill reports the process alive until SIGKILL, which finds it gone.
type exitBeforeKill struct{ fakeTarget }

func (t exitBeforeKill) signal(force bool) error {
	if force {
		return ErrNotFound
	}
	return t.fakeTarget.signal(false)
}
