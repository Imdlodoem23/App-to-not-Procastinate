package hosts

import (
	"context"
	"errors"
	"os/exec"
	"slices"
	"strings"
	"testing"
)

type fakeRun struct {
	calls   [][]string
	replies map[string]fakeReply
}

type fakeReply struct {
	out string
	err error
}

func (f *fakeRun) run(_ context.Context, path string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, append([]string{path}, args...))
	r := f.replies[path]
	return []byte(r.out), r.err
}

func finder(present ...string) func(string) string {
	return func(name string) string {
		if slices.Contains(present, name) {
			return "/usr/bin/" + name
		}
		return ""
	}
}

func TestFlushLinux(t *testing.T) {
	exitErr := errors.New("exit status 1")
	cases := []struct {
		name    string
		present []string
		replies map[string]fakeReply
		calls   [][]string
		wantErr bool
	}{
		{
			name:    "resolvectl works",
			present: []string{"resolvectl", "systemd-resolve"},
			calls:   [][]string{{"/usr/bin/resolvectl", "flush-caches"}},
		},
		{
			name:    "resolved not running is fine",
			present: []string{"resolvectl", "systemd-resolve"},
			replies: map[string]fakeReply{"/usr/bin/resolvectl": {
				out: "Failed to flush caches: Unit dbus-org.freedesktop.resolve1.service not found.", err: exitErr}},
			calls: [][]string{{"/usr/bin/resolvectl", "flush-caches"}},
		},
		{
			name:    "falls back to systemd-resolve",
			present: []string{"systemd-resolve"},
			calls:   [][]string{{"/usr/bin/systemd-resolve", "--flush-caches"}},
		},
		{
			name:    "falls back when resolvectl vanished",
			present: []string{"resolvectl", "systemd-resolve"},
			replies: map[string]fakeReply{"/usr/bin/resolvectl": {err: exec.ErrNotFound}},
			calls: [][]string{
				{"/usr/bin/resolvectl", "flush-caches"},
				{"/usr/bin/systemd-resolve", "--flush-caches"},
			},
		},
		{
			name: "no systemd-resolved at all",
		},
		{
			name:    "both fail",
			present: []string{"resolvectl", "systemd-resolve"},
			replies: map[string]fakeReply{
				"/usr/bin/resolvectl":      {out: "Access denied", err: exitErr},
				"/usr/bin/systemd-resolve": {out: "Access denied", err: exitErr},
			},
			calls: [][]string{
				{"/usr/bin/resolvectl", "flush-caches"},
				{"/usr/bin/systemd-resolve", "--flush-caches"},
			},
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeRun{replies: tc.replies}
			err := flushLinux(context.Background(), f.run, finder(tc.present...))
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if tc.wantErr && (!strings.Contains(err.Error(), "resolvectl") || !strings.Contains(err.Error(), "systemd-resolve")) {
				t.Fatalf("error does not name both commands: %v", err)
			}
			if !slices.EqualFunc(f.calls, tc.calls, slices.Equal) {
				t.Fatalf("calls = %q, want %q", f.calls, tc.calls)
			}
		})
	}
}

func TestFindBinaryOnlyFixedDirs(t *testing.T) {
	if p := findBinary("definitely-not-a-real-binary-centrate"); p != "" {
		t.Fatalf("found %q", p)
	}
	if p := findBinary("sh"); p != "" && !strings.HasPrefix(p, "/usr/bin/") && !strings.HasPrefix(p, "/bin/") {
		t.Fatalf("sh found outside the fixed dirs: %q", p)
	}
}
