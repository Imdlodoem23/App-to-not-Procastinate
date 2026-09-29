package svc

import (
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

func TestWritePlannedStopWritesTheMarker(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Centrate")
	t.Setenv(platform.EnvDataDir, dir) // honoured by test binaries
	if err := WritePlannedStop(PlannedStopUpdate); err == nil {
		t.Fatal("without run/ the marker cannot be written")
	}
	if err := os.MkdirAll(filepath.Join(dir, "run"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, reason := range []string{PlannedStopUpdate, PlannedStopInstall, PlannedStopShutdown} {
		if err := WritePlannedStop(reason); err != nil {
			t.Fatalf("%s: %v", reason, err)
		}
		b, err := os.ReadFile(filepath.Join(dir, "run", "planned-stop"))
		if err != nil || !strings.Contains(string(b), `"reason":"`+reason+`"`) {
			t.Fatalf("marker = %q, %v", b, err)
		}
	}
	if err := WritePlannedStop("Not A Reason"); err == nil {
		t.Fatal("an invalid reason must be refused")
	}
}

func TestStopPlannedWritesMarkerFirst(t *testing.T) {
	prev := WritePlannedStop
	t.Cleanup(func() { WritePlannedStop = prev })
	var order []string
	WritePlannedStop = func(reason string) error {
		order = append(order, "marker:"+reason)
		return nil
	}
	stop := func() error { order = append(order, "stop"); return ErrNotInstalled }
	if err := stopPlanned(slog.New(slog.DiscardHandler), PlannedStopUpdate, stop); !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("err = %v", err)
	}
	if strings.Join(order, ",") != "marker:update,stop" {
		t.Fatalf("order = %v", order)
	}
	// A marker that cannot be written never blocks the stop.
	var log syncBuffer
	WritePlannedStop = func(string) error { return errors.New("read-only disk") }
	stopped := false
	if err := stopPlanned(slog.New(slog.NewTextHandler(&log, nil)), PlannedStopUpdate, func() error { stopped = true; return nil }); err != nil || !stopped {
		t.Fatalf("err = %v, stopped = %v", err, stopped)
	}
	if !strings.Contains(log.String(), "read-only disk") {
		t.Fatalf("log = %q", log.String())
	}
}

// A stop during an OS shutdown goes to ShutdownRunner.Shutdown (which writes
// the planned-stop marker); a plain stop to Stop.
func TestProgramStopDuringShutdownUsesShutdown(t *testing.T) {
	for _, stopping := range []bool{true, false} {
		r := &shutdownRunner{}
		p := testProgram(r, nil)
		asked := 0
		p.stopping = func() bool { asked++; return stopping }
		if err := p.Start(nil); err != nil {
			t.Fatal(err)
		}
		if err := p.Stop(nil); err != nil {
			t.Fatal(err)
		}
		if asked != 1 {
			t.Fatalf("stopping asked %d times", asked)
		}
		if stopping && (r.shutdown != 1 || r.stops != 0) || !stopping && (r.shutdown != 0 || r.stops != 1) {
			t.Fatalf("stopping=%v: shutdown=%d stops=%d", stopping, r.shutdown, r.stops)
		}
		if stopping && (r.deadline <= 0 || r.deadline > StopTimeout) {
			t.Fatalf("shutdown deadline = %v", r.deadline)
		}
	}
	// A Runner without Shutdown is stopped, and systemd is not even asked.
	r := &fakeRunner{}
	p := testProgram(r, nil)
	p.stopping = func() bool { t.Fatal("asked for a plain Runner"); return true }
	if err := p.Start(nil); err != nil {
		t.Fatal(err)
	}
	if err := p.Stop(nil); err != nil || r.stops != 1 {
		t.Fatalf("err = %v, stops = %d", err, r.stops)
	}
}

func TestSystemdUnitHardening(t *testing.T) {
	if !strings.Contains(systemdScript, "NoNewPrivileges=yes\n") || strings.Contains(systemdScript, "ProtectSystem") {
		t.Fatal("the unit needs NoNewPrivileges=yes and no ProtectSystem (it writes /etc/hosts)")
	}
}
