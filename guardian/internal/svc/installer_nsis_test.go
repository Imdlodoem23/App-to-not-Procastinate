package svc

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// nsisMacro returns the body of `!macro name` in the NSIS script, or "" and false.
func nsisMacro(script, name string) (string, bool) {
	re := regexp.MustCompile(`(?ms)^\s*!macro\s+` + regexp.QuoteMeta(name) + `\b(.*?)^\s*!macroend`)
	m := re.FindStringSubmatch(script)
	if m == nil {
		return "", false
	}
	return m[1], true
}

// nsisCode drops NSIS comments (lines starting with ; or #).
func nsisCode(body string) string {
	var out []string
	for _, l := range strings.Split(body, "\n") {
		t := strings.TrimSpace(l)
		if t == "" || strings.HasPrefix(t, ";") || strings.HasPrefix(t, "#") {
			continue
		}
		out = append(out, t)
	}
	return strings.Join(out, "\n")
}

// TestNSISHooksStopGuardianOnlyInInstallSection is the regression test for the
// assisted NSIS wizard stopping the guardian in .onInit (customInit): a user who
// cancelled the wizard was left without blocking, and the stop was priced as
// service_stopped at the next start. The guardian must be stopped only in the
// install section (customCheckAppRunning, before files are replaced), as a
// planned update (prepare-update writes the planned-stop marker), and a failed
// install must start it again.
func TestNSISHooksStopGuardianOnlyInInstallSection(t *testing.T) {
	path := filepath.Join("..", "..", "..", "apps", "desktop", "build", "installer.nsh")
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		t.Skipf("%s not present (guardian built outside the monorepo)", path)
	}
	if err != nil {
		t.Fatal(err)
	}
	script := string(raw)

	if body, ok := nsisMacro(script, "customInit"); ok {
		code := nsisCode(body)
		if strings.Contains(code, "stop") || strings.Contains(code, "prepare-update") || strings.Contains(code, "centrateStopGuardian") {
			t.Errorf("customInit (runs in .onInit, before the wizard pages) stops the guardian:\n%s", code)
		}
	}
	if m := regexp.MustCompile(`(?ms)Function\s+\.onInit\b.*?FunctionEnd`).FindString(script); strings.Contains(nsisCode(m), "stop") {
		t.Errorf(".onInit stops the guardian:\n%s", m)
	}

	stop, ok := nsisMacro(script, "centrateStopGuardian")
	if !ok {
		t.Fatal("centrateStopGuardian macro missing")
	}
	stop = nsisCode(stop)
	pu, sc := strings.Index(stop, `" prepare-update'`), strings.Index(stop, `stop CentrateGuardian`)
	if pu < 0 {
		t.Errorf("centrateStopGuardian does not run prepare-update (planned-stop marker):\n%s", stop)
	}
	if sc >= 0 && sc < pu {
		t.Errorf("centrateStopGuardian runs the plain stop before prepare-update:\n%s", stop)
	}

	check, ok := nsisMacro(script, "customCheckAppRunning")
	if !ok {
		t.Fatal("customCheckAppRunning macro missing: nothing stops the guardian before files are replaced")
	}
	check = nsisCode(check)
	i, j := strings.Index(check, "centrateStopGuardian"), strings.Index(check, "_CHECK_APP_RUNNING")
	if i < 0 || j < 0 || i > j {
		t.Errorf("customCheckAppRunning must stop the guardian, then run the default app check:\n%s", check)
	}
	if !strings.Contains(check, "IS_POWERSHELL_AVAILABLE") {
		t.Errorf("customCheckAppRunning drops IS_POWERSHELL_AVAILABLE, which _CHECK_APP_RUNNING needs:\n%s", check)
	}
	// Overriding the hook skips the default's includes; the script must provide them.
	if !strings.Contains(script, `!include "getProcessInfo.nsh"`) || !regexp.MustCompile(`(?m)^\s*Var\s+pid\b`).MatchString(script) {
		t.Error(`customCheckAppRunning needs !include "getProcessInfo.nsh" and Var pid at top level`)
	}

	failed := regexp.MustCompile(`(?ms)Function\s+\.onInstFailed\b(.*?)FunctionEnd`).FindStringSubmatch(script)
	if failed == nil || !strings.Contains(failed[1], "start CentrateGuardian") {
		t.Error(".onInstFailed must start the guardian again")
	}

	un, ok := nsisMacro(script, "customUnInstall")
	if !ok {
		t.Fatal("customUnInstall macro missing")
	}
	if upd := nsisCode(un[strings.Index(un, "${else}")+1:]); !strings.Contains(upd, "centrateStopGuardian") {
		t.Errorf("customUnInstall on update must use the planned stop:\n%s", upd)
	}
}
