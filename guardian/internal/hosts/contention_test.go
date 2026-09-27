package hosts

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestContentionBacksOff(t *testing.T) {
	var logs bytes.Buffer
	c := &Contention{Logger: slog.New(slog.NewTextHandler(&logs, nil))}
	t0 := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	now := t0
	// Defender-like loop: a rewrite 2 s after every re-apply.
	for i := range DefaultContentionThreshold - 1 {
		if d := c.Rewritten(now); d != 0 {
			t.Fatalf("rewrite %d: delay %v, want 0", i+1, d)
		}
		now = now.Add(2 * time.Second)
	}
	if c.Contested(now) {
		t.Fatal("contested before the threshold")
	}
	want := DefaultContentionMinDelay
	for i := range 8 {
		d := c.Rewritten(now)
		if d != want {
			t.Fatalf("contested rewrite %d: delay %v, want %v", i+1, d, want)
		}
		if !c.Contested(now) {
			t.Fatal("not contested")
		}
		now = now.Add(d + 2*time.Second) // re-applied after d, rewritten 2 s later
		want = min(2*want, DefaultContentionMaxDelay)
	}
	if n := strings.Count(logs.String(), "level=WARN"); n != 1 {
		t.Fatalf("%d warnings, want 1:\n%s", n, logs.String())
	}

	// The other program stops: contention ends after the delay plus Window
	// have passed since its latest rewrite.
	last := now.Add(-DefaultContentionMaxDelay - 2*time.Second) // the latest rewrite
	if !c.Contested(last.Add(DefaultContentionMaxDelay + DefaultContentionWindow)) {
		t.Fatal("contention ended too early")
	}
	quiet := last.Add(DefaultContentionMaxDelay + DefaultContentionWindow + time.Second)
	if c.Contested(quiet) {
		t.Fatal("still contested after a quiet period")
	}
	if d := c.Rewritten(quiet); d != 0 {
		t.Fatalf("first rewrite after a quiet period: delay %v", d)
	}
	if strings.Count(logs.String(), "level=WARN") != 1 {
		t.Fatal("warning logged again")
	}
}

func TestContentionSlowRewritesNeverContested(t *testing.T) {
	c := &Contention{}
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	for range 50 {
		if d := c.Rewritten(now); d != 0 {
			t.Fatalf("delay %v for rewrites 20 s apart", d)
		}
		now = now.Add(20 * time.Second) // 3 per minute, under the threshold
	}
}

func TestContentionCustomParamsAndReset(t *testing.T) {
	c := &Contention{Window: 10 * time.Second, Threshold: 2, MinDelay: time.Second, MaxDelay: time.Second}
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	if d := c.Rewritten(now); d != 0 {
		t.Fatal(d)
	}
	for range 3 {
		now = now.Add(time.Second)
		if d := c.Rewritten(now); d != time.Second {
			t.Fatalf("fixed delay = %v", d)
		}
	}
	c.Reset()
	if c.Contested(now) {
		t.Fatal("contested after Reset")
	}
	if d := c.Rewritten(now); d != 0 {
		t.Fatalf("delay after Reset = %v", d)
	}
}
