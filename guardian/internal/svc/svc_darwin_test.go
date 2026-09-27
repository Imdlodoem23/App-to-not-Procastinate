package svc

import (
	"errors"
	"strings"
	"testing"
)

// fakeLaunchctl replaces runCmd; reply maps "arg0 arg1 …" (without the
// launchctl path) to its output and error. Unknown commands fail.
func fakeLaunchctl(t *testing.T, reply func(args string) (string, error)) *[]string {
	t.Helper()
	var calls []string
	prev := runCmd
	runCmd = func(name string, args ...string) (string, error) {
		if name != launchctl {
			t.Fatalf("unexpected binary %q", name)
		}
		joined := strings.Join(args, " ")
		calls = append(calls, joined)
		return reply(joined)
	}
	t.Cleanup(func() { runCmd = prev })
	return &calls
}

var errLaunchctl = errors.New("exit status 5")

func TestBootstrapEnablesFirst(t *testing.T) {
	calls := fakeLaunchctl(t, func(args string) (string, error) {
		switch args {
		case "enable " + launchdTarget, "bootstrap system " + DarwinPlistPath:
			return "", nil
		}
		return "", errLaunchctl
	})
	if err := bootstrap(); err != nil {
		t.Fatal(err)
	}
	if len(*calls) < 2 || (*calls)[0] != "enable "+launchdTarget || (*calls)[1] != "bootstrap system "+DarwinPlistPath {
		t.Fatalf("calls = %v", *calls)
	}
}

func TestBootstrapReportsDisabledByUser(t *testing.T) {
	fakeLaunchctl(t, func(args string) (string, error) {
		switch args {
		case "enable " + launchdTarget:
			return "", nil
		case "print-disabled system":
			return "disabled services = {\n\t\"" + LaunchdLabel + "\" => disabled\n}\n", nil
		}
		return "Bootstrap failed: 5: Input/output error", errLaunchctl
	})
	if err := bootstrap(); !errors.Is(err, ErrDisabledByUser) {
		t.Fatalf("bootstrap = %v, want ErrDisabledByUser", err)
	}
}

func TestKickstartEnablesAndReportsDisabled(t *testing.T) {
	calls := fakeLaunchctl(t, func(args string) (string, error) {
		switch args {
		case "enable " + launchdTarget:
			return "", nil
		case "print-disabled system":
			return "\t\"" + LaunchdLabel + "\" => disabled\n", nil
		}
		return "119: Service is disabled", errLaunchctl
	})
	if err := kickstart("-k"); !errors.Is(err, ErrDisabledByUser) {
		t.Fatalf("kickstart = %v, want ErrDisabledByUser", err)
	}
	if (*calls)[0] != "enable "+launchdTarget || (*calls)[1] != "kickstart -k "+launchdTarget {
		t.Fatalf("calls = %v", *calls)
	}
}
