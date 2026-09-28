//go:build unix && !darwin

package svc

import "testing"

func TestIsStoppingState(t *testing.T) {
	for out, want := range map[string]bool{
		"stopping\n": true,
		"stopping":   true,
		"running\n":  false,
		"degraded\n": false,
		"offline\n":  false,
		"":           false,
		"stopping x": false,
	} {
		if got := isStoppingState(out); got != want {
			t.Errorf("isStoppingState(%q) = %v", out, got)
		}
	}
	// The real check never fails, with or without systemd.
	_ = osSystemStopping()
}
