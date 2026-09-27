package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/svc"
)

// fakeManager records every call in order into a shared log.
type fakeManager struct {
	calls  *[]string
	errs   map[string]error
	status svc.Status
}

func (f *fakeManager) call(name string) error {
	*f.calls = append(*f.calls, name)
	return f.errs[name]
}

func (f *fakeManager) Install() error   { return f.call("install") }
func (f *fakeManager) Uninstall() error { return f.call("uninstall") }
func (f *fakeManager) Start() error     { return f.call("start") }
func (f *fakeManager) Stop() error      { return f.call("stop") }
func (f *fakeManager) Restart() error   { return f.call("restart") }
func (f *fakeManager) Run() error       { return f.call("run") }
func (f *fakeManager) Status() (svc.Status, error) {
	return f.status, f.call("status")
}

type env struct {
	interactive bool
	elevated    bool
	errs        map[string]error // keyed by call name
	status      svc.Status
	active      bool
}

func newTestApp(e env) (*app, *[]string, *bytes.Buffer, *bytes.Buffer) {
	var calls []string
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	record := func(name string) error {
		calls = append(calls, name)
		return e.errs[name]
	}
	a := &app{
		stdout:        stdout,
		stderr:        stderr,
		version:       "1.2.3",
		interactive:   func() bool { return e.interactive },
		elevated:      func() bool { return e.elevated },
		useSystemPATH: func() {},
		newManager: func(o svc.Options) (serviceManager, error) {
			if err := record("newManager"); err != nil {
				return nil, err
			}
			if o.Runner != nil {
				calls = append(calls, "withRunner")
			}
			return &fakeManager{calls: &calls, errs: e.errs, status: e.status}, nil
		},
		newRunner: func(*slog.Logger) svc.Runner { return svc.NewHeartbeatRunner(nil, 0) },
		openLogger: func(io.Writer) (*slog.Logger, func(), error) {
			if err := record("openLogger"); err != nil {
				return nil, nil, err
			}
			return slog.New(slog.DiscardHandler), func() { calls = append(calls, "closeLogger") }, nil
		},
		prepareDirs:  func() error { return record("prepareDirs") },
		cleanupHosts: func() error { return record("cleanupHosts") },
		hasActive: func() (bool, error) {
			return e.active, record("hasActive")
		},
		removeData: func() error { return record("removeData") },
		dataDir:    func() string { return "/data" },
	}
	return a, &calls, stdout, stderr
}

var boom = errors.New("boom")

func TestDispatch(t *testing.T) {
	admin := env{elevated: true, interactive: true}
	tests := []struct {
		name      string
		args      []string
		env       env
		wantCode  int
		wantCalls []string
		stdout    string // exact JSON line, when set
		stderr    string // substring, when set
	}{
		{name: "no args interactive shows usage", args: nil, env: env{interactive: true}, wantCode: exitUsage, stderr: "Uso: centrate-guardian"},
		{name: "no args from service manager runs", args: nil, env: env{}, wantCode: exitOK,
			wantCalls: []string{"openLogger", "newManager", "withRunner", "run", "closeLogger"}},
		{name: "help", args: []string{"help"}, env: env{interactive: true}, wantCode: exitOK, stderr: "Órdenes:"},
		{name: "--help", args: []string{"--help"}, wantCode: exitOK, stderr: "Órdenes:"},
		{name: "unknown command", args: []string{"frobnicate"}, wantCode: exitUsage, stderr: "Orden desconocida"},
		{name: "run", args: []string{"run"}, wantCode: exitOK,
			wantCalls: []string{"openLogger", "newManager", "withRunner", "run", "closeLogger"}},
		{name: "run without log file falls back to console", args: []string{"run"}, env: env{errs: map[string]error{"openLogger": boom}}, wantCode: exitOK,
			wantCalls: []string{"openLogger", "newManager", "withRunner", "run"}, stderr: "no se pudo abrir el registro"},
		{name: "run failure", args: []string{"run"}, env: env{errs: map[string]error{"run": boom}}, wantCode: exitError,
			wantCalls: []string{"openLogger", "newManager", "withRunner", "run", "closeLogger"}},
		{name: "run rejects args", args: []string{"run", "x"}, wantCode: exitUsage},
		{name: "install needs admin", args: []string{"install"}, env: env{}, wantCode: exitError, stderr: "administrador"},
		{name: "install", args: []string{"install"}, env: admin, wantCode: exitOK,
			wantCalls: []string{"prepareDirs", "newManager", "install"}, stderr: "instalado y en marcha"},
		{name: "install fails", args: []string{"install"}, env: env{elevated: true, errs: map[string]error{"install": boom}}, wantCode: exitError,
			wantCalls: []string{"prepareDirs", "newManager", "install"}, stderr: "No se pudo instalar"},
		{name: "install data dir fails", args: []string{"install"}, env: env{elevated: true, errs: map[string]error{"prepareDirs": boom}}, wantCode: exitError,
			wantCalls: []string{"prepareDirs"}},
		{name: "install manager fails", args: []string{"install"}, env: env{elevated: true, errs: map[string]error{"newManager": boom}}, wantCode: exitError,
			wantCalls: []string{"prepareDirs", "newManager"}},
		{name: "install rejects args", args: []string{"install", "--force"}, env: admin, wantCode: exitUsage},
		{name: "uninstall", args: []string{"uninstall"}, env: admin, wantCode: exitOK,
			wantCalls: []string{"newManager", "uninstall", "cleanupHosts", "removeData"}, stderr: "queda limpio"},
		{name: "uninstall keep data", args: []string{"uninstall", "--keep-data"}, env: admin, wantCode: exitOK,
			wantCalls: []string{"newManager", "uninstall", "cleanupHosts"}, stderr: "Datos conservados"},
		{name: "uninstall bad flag", args: []string{"uninstall", "--purge"}, env: admin, wantCode: exitUsage},
		{name: "uninstall needs admin", args: []string{"uninstall"}, env: env{}, wantCode: exitError},
		{name: "uninstall keeps data when hosts cleanup fails", args: []string{"uninstall"}, env: env{elevated: true, errs: map[string]error{"cleanupHosts": boom}}, wantCode: exitError,
			wantCalls: []string{"newManager", "uninstall", "cleanupHosts"}, stderr: "Vuelve a ejecutar"},
		{name: "uninstall still cleans hosts after service error", args: []string{"uninstall"}, env: env{elevated: true, errs: map[string]error{"uninstall": boom}}, wantCode: exitError,
			wantCalls: []string{"newManager", "uninstall", "cleanupHosts"}, stderr: "No se pudo quitar el servicio"},
		{name: "uninstall data removal fails", args: []string{"uninstall"}, env: env{elevated: true, errs: map[string]error{"removeData": boom}}, wantCode: exitError,
			wantCalls: []string{"newManager", "uninstall", "cleanupHosts", "removeData"}},
		{name: "start", args: []string{"start"}, env: admin, wantCode: exitOK, wantCalls: []string{"newManager", "start"}},
		{name: "install marked for deletion explains what to do", args: []string{"install"},
			env: env{elevated: true, errs: map[string]error{"install": fmt.Errorf("svc: install: %w", svc.ErrMarkedForDeletion)}}, wantCode: exitError,
			wantCalls: []string{"prepareDirs", "newManager", "install"}, stderr: "«Servicios»"},
		{name: "install from an unprotected folder explains what to do", args: []string{"install"},
			env: env{elevated: true, errs: map[string]error{"install": svc.ErrUntrustedExecutable}}, wantCode: exitError,
			wantCalls: []string{"prepareDirs", "newManager", "install"}, stderr: "otros usuarios pueden modificar"},
		{name: "start not installed", args: []string{"start"}, env: env{elevated: true, errs: map[string]error{"start": svc.ErrNotInstalled}}, wantCode: exitNotInstalled,
			wantCalls: []string{"newManager", "start"}, stderr: "no está instalado"},
		{name: "start disabled in login items", args: []string{"start"}, env: env{elevated: true, errs: map[string]error{"start": svc.ErrDisabledByUser}}, wantCode: exitError,
			wantCalls: []string{"newManager", "start"}, stderr: "Ítems de inicio"},
		{name: "stop not installed is already stopped", args: []string{"stop"}, env: env{elevated: true, errs: map[string]error{"stop": svc.ErrNotInstalled}}, wantCode: exitOK,
			wantCalls: []string{"newManager", "stop"}, stderr: "nada que parar"},
		{name: "restart not installed", args: []string{"restart"}, env: env{elevated: true, errs: map[string]error{"restart": svc.ErrNotInstalled}}, wantCode: exitNotInstalled,
			wantCalls: []string{"newManager", "restart"}, stderr: "no está instalado"},
		{name: "restart error", args: []string{"restart"}, env: env{elevated: true, errs: map[string]error{"restart": boom}}, wantCode: exitError,
			wantCalls: []string{"newManager", "restart"}, stderr: "boom"},
		{name: "start needs admin", args: []string{"start"}, env: env{}, wantCode: exitError},
		{name: "stop", args: []string{"stop"}, env: admin, wantCode: exitOK, wantCalls: []string{"newManager", "stop"}},
		{name: "stop error", args: []string{"stop"}, env: env{elevated: true, errs: map[string]error{"stop": boom}}, wantCode: exitError,
			wantCalls: []string{"newManager", "stop"}, stderr: "boom"},
		{name: "restart", args: []string{"restart"}, env: admin, wantCode: exitOK, wantCalls: []string{"newManager", "restart"}},
		{name: "status without admin", args: []string{"status"}, env: env{status: svc.Status{Installed: true, Running: true}}, wantCode: exitOK,
			wantCalls: []string{"newManager", "status"}, stdout: `{"installed":true,"running":true,"version":"1.2.3"}`},
		{name: "status not installed", args: []string{"status"}, wantCode: exitOK,
			wantCalls: []string{"newManager", "status"}, stdout: `{"installed":false,"running":false,"version":"1.2.3"}`},
		{name: "status error", args: []string{"status"}, env: env{errs: map[string]error{"status": boom}}, wantCode: exitError,
			wantCalls: []string{"newManager", "status"}},
		{name: "has-active true", args: []string{"has-active"}, env: env{active: true}, wantCode: exitActive,
			wantCalls: []string{"hasActive"}, stdout: `{"active":true}`},
		{name: "has-active false", args: []string{"has-active"}, wantCode: exitOK,
			wantCalls: []string{"hasActive"}, stdout: `{"active":false}`},
		{name: "has-active error", args: []string{"has-active"}, env: env{errs: map[string]error{"hasActive": boom}}, wantCode: exitError,
			wantCalls: []string{"hasActive"}},
		{name: "cleanup-hosts", args: []string{"cleanup-hosts"}, env: admin, wantCode: exitOK, wantCalls: []string{"cleanupHosts"}},
		{name: "cleanup-hosts error", args: []string{"cleanup-hosts"}, env: env{elevated: true, errs: map[string]error{"cleanupHosts": boom}}, wantCode: exitError,
			wantCalls: []string{"cleanupHosts"}},
		{name: "cleanup-hosts needs admin", args: []string{"cleanup-hosts"}, wantCode: exitError},
		{name: "version", args: []string{"version"}, wantCode: exitOK, stdout: `{"version":"1.2.3"}`},
		{name: "version rejects args", args: []string{"version", "--short"}, wantCode: exitUsage},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a, calls, stdout, stderr := newTestApp(tc.env)
			if code := a.run(tc.args); code != tc.wantCode {
				t.Fatalf("exit code = %d, want %d (stderr %q)", code, tc.wantCode, stderr)
			}
			if !reflect.DeepEqual(*calls, tc.wantCalls) && !(len(*calls) == 0 && len(tc.wantCalls) == 0) {
				t.Fatalf("calls = %v, want %v", *calls, tc.wantCalls)
			}
			if tc.stdout != "" && strings.TrimSpace(stdout.String()) != tc.stdout {
				t.Fatalf("stdout = %q, want %q", stdout.String(), tc.stdout)
			}
			if tc.stdout == "" && stdout.Len() != 0 {
				t.Fatalf("unexpected stdout %q", stdout.String())
			}
			if tc.stderr != "" && !strings.Contains(stderr.String(), tc.stderr) {
				t.Fatalf("stderr = %q, want it to contain %q", stderr.String(), tc.stderr)
			}
		})
	}
}

func TestMachineOutputIsValidJSON(t *testing.T) {
	for _, args := range [][]string{{"status"}, {"version"}, {"has-active"}} {
		a, _, stdout, _ := newTestApp(env{})
		a.run(args)
		var v map[string]any
		if err := json.Unmarshal(stdout.Bytes(), &v); err != nil {
			t.Fatalf("%v: %v (%q)", args, err, stdout.String())
		}
	}
}

func TestUninstallTwiceIsSafe(t *testing.T) {
	a, calls, _, _ := newTestApp(env{elevated: true})
	if code := a.run([]string{"uninstall"}); code != exitOK {
		t.Fatalf("first uninstall = %d", code)
	}
	if code := a.run([]string{"uninstall"}); code != exitOK {
		t.Fatalf("second uninstall = %d", code)
	}
	if n := len(*calls); n != 8 {
		t.Fatalf("calls = %v", *calls)
	}
}

func TestEveryCommandIsDocumented(t *testing.T) {
	for name := range commands {
		if !strings.Contains(usageText, name) {
			t.Errorf("usage text does not mention %q", name)
		}
	}
}

func TestElevatedCommandsUseSystemPATH(t *testing.T) {
	for _, tc := range []struct {
		args     []string
		elevated bool
		want     int
	}{
		{[]string{"install"}, true, 1},
		{[]string{"status"}, true, 1},
		{nil, true, 1}, // started by the service manager
		{[]string{"status"}, false, 0},
		{[]string{"install"}, false, 0},
	} {
		a, _, _, _ := newTestApp(env{elevated: tc.elevated})
		n := 0
		a.useSystemPATH = func() { n++ }
		a.run(tc.args)
		if n != tc.want {
			t.Errorf("%v elevated=%v: useSystemPATH called %d times, want %d", tc.args, tc.elevated, n, tc.want)
		}
	}
}

func TestUsageDocumentsExitCodes(t *testing.T) {
	for _, want := range []string{"0 bien", "1 error", "2 uso", "3 el servicio no está", "10 hay un"} {
		if !strings.Contains(usageText, want) {
			t.Errorf("usage text lacks %q", want)
		}
	}
}

func TestDefaultAppIsComplete(t *testing.T) {
	a := defaultApp()
	v := reflect.ValueOf(a).Elem()
	for i := range v.NumField() {
		if f := v.Field(i); f.Kind() == reflect.Func && f.IsNil() {
			t.Errorf("defaultApp leaves %s nil", v.Type().Field(i).Name)
		}
	}
}
