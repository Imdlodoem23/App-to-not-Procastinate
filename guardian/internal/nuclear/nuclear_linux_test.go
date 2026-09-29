//go:build linux

package nuclear

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
)

// fakeLinux builds a /proc with one process per exe path (all owned by uid) and a
// seat0 file naming activeUID.
func fakeLinux(t *testing.T, app string, activeUID int, owner int, exes ...string) *Relauncher {
	t.Helper()
	base := t.TempDir()
	proc := filepath.Join(base, "proc")
	for i, exe := range exes {
		dir := filepath.Join(proc, strconv.Itoa(100+i))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(exe, filepath.Join(dir, "exe")); err != nil {
			t.Fatal(err)
		}
		if owner != os.Getuid() {
			if err := os.Chown(dir, owner, owner); err != nil {
				t.Skipf("cannot give the fake process to uid %d: %v", owner, err)
			}
		}
	}
	if err := os.MkdirAll(filepath.Join(proc, "self"), 0o755); err != nil { // not a PID
		t.Fatal(err)
	}
	seat := filepath.Join(base, "seat0")
	if activeUID >= 0 {
		if err := os.WriteFile(seat, []byte("IS_SEAT0=1\nACTIVE_UID="+strconv.Itoa(activeUID)+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	r := New(app)
	r.procDir, r.seatFile = proc, seat
	return r
}

// userUID is a non-root uid owning the fake processes: ours, or an arbitrary one when
// the tests run as root (root never counts as the console user).
func userUID() int {
	if uid := os.Getuid(); uid != 0 {
		return uid
	}
	return 4242
}

func TestLinuxAppRunning(t *testing.T) {
	const app = "/opt/Centrate/centrate"
	uid := userUID()
	for _, tc := range []struct {
		name   string
		active int
		exes   []string
		want   bool
	}{
		{"the app runs as the console user", uid, []string{"/usr/bin/bash", app}, true},
		{"only a look-alike runs", uid, []string{"/home/u/centrate", "/opt/Centrate/centrate (deleted)"}, false},
		{"another user runs it", uid + 1, []string{app}, false},
		{"nobody at the console", -1, []string{app}, false},
		{"root at the console", 0, []string{app}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := fakeLinux(t, app, tc.active, uid, tc.exes...)
			got, err := r.AppRunning()
			if err != nil || got != tc.want {
				t.Fatalf("AppRunning = %v, %v; want %v", got, err, tc.want)
			}
		})
	}
}

func TestLinuxRelaunch(t *testing.T) {
	const app = "/opt/Centrate/centrate"
	r := fakeLinux(t, app, 1000, userUID())
	r.systemctl = "/usr/bin/systemctl"
	var got []string
	r.run = func(_ context.Context, name string, args ...string) ([]byte, error) {
		got = append([]string{name}, args...)
		return nil, nil
	}
	if err := r.Relaunch(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{"/usr/bin/systemctl", "--user", "--machine=1000@.host", "start", "centrate-nuclear.service"}
	if !slices.Equal(got, want) {
		t.Fatalf("argv = %q, want %q", got, want)
	}
	r.run = func(context.Context, string, ...string) ([]byte, error) {
		return []byte("Failed to connect to bus\n"), errors.New("exit status 1")
	}
	if err := r.Relaunch(context.Background()); err == nil {
		t.Fatal("a failed start must be reported")
	}
	for _, active := range []int{-1, 0} {
		r := fakeLinux(t, app, active, userUID())
		r.systemctl = "/usr/bin/systemctl"
		r.run = func(context.Context, string, ...string) ([]byte, error) {
			t.Fatal("nothing may run without a console user")
			return nil, nil
		}
		if err := r.Relaunch(context.Background()); !errors.Is(err, ErrNoConsoleUser) {
			t.Fatalf("active uid %d: %v", active, err)
		}
	}
}
