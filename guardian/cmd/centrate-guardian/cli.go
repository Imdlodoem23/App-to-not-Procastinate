package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"runtime"

	"github.com/imdlodoem23/centrate/guardian/internal/logx"
	"github.com/imdlodoem23/centrate/guardian/internal/svc"
)

// Exit codes.
const (
	exitOK     = 0
	exitError  = 1
	exitUsage  = 2
	exitActive = 10 // has-active: at least one block is active
)

const keepDataFlag = "--keep-data"

const usageText = `Uso: centrate-guardian <orden>

Órdenes:
  run                        Ejecuta el guardián (lo usa el gestor de servicios).
  install                    Instala o actualiza el servicio y lo (re)arranca.
  uninstall [--keep-data]    Para y quita el servicio, limpia el archivo hosts
                             y borra los datos (salvo con --keep-data).
  start | stop | restart     Arranca, para o reinicia el servicio.
  status                     Muestra en JSON si está instalado y en marcha.
  has-active                 Sale con código 10 si hay algún bloqueo activo.
  cleanup-hosts              Quita la sección de Céntrate del archivo hosts.
  version                    Muestra la versión en JSON.

install, uninstall, start, stop, restart y cleanup-hosts necesitan permisos
de administrador.
`

const msgNeedsAdmin = "Esta orden necesita permisos de administrador. Ejecútala con sudo (macOS y Linux) o desde una consola de administrador (Windows)."

// serviceManager is the part of *svc.Manager the CLI uses (faked in tests).
type serviceManager interface {
	Install() error
	Uninstall() error
	Start() error
	Stop() error
	Restart() error
	Status() (svc.Status, error)
	Run() error
}

// app holds every side effect of the CLI so tests can replace them.
type app struct {
	stdout, stderr io.Writer
	version        string

	interactive  func() bool
	elevated     func() bool
	newManager   func(svc.Options) (serviceManager, error)
	newRunner    func(*slog.Logger) svc.Runner
	openLogger   func(console io.Writer) (*slog.Logger, func(), error)
	prepareDirs  func() error
	cleanupHosts func() error
	hasActive    func() (bool, error)
	removeData   func() error
	dataDir      func() string
}

type command struct {
	needsAdmin bool
	takesArgs  bool
	run        func(a *app, args []string) int
}

var commands = map[string]command{
	"run":           {run: (*app).cmdRun},
	"install":       {needsAdmin: true, run: (*app).cmdInstall},
	"uninstall":     {needsAdmin: true, takesArgs: true, run: (*app).cmdUninstall},
	"start":         {needsAdmin: true, run: (*app).cmdStart},
	"stop":          {needsAdmin: true, run: (*app).cmdStop},
	"restart":       {needsAdmin: true, run: (*app).cmdRestart},
	"status":        {run: (*app).cmdStatus},
	"has-active":    {run: (*app).cmdHasActive},
	"cleanup-hosts": {needsAdmin: true, run: (*app).cmdCleanupHosts},
	"version":       {run: (*app).cmdVersion},
}

// run dispatches args (without the program name) and returns the exit code.
func (a *app) run(args []string) int {
	if len(args) == 0 {
		if !a.interactive() {
			// Started by the service manager without arguments.
			return a.cmdRun(nil)
		}
		a.usage()
		return exitUsage
	}
	name, rest := args[0], args[1:]
	switch name {
	case "help", "-h", "--help":
		a.usage()
		return exitOK
	}
	cmd, ok := commands[name]
	if !ok {
		a.say("Orden desconocida: %q.", name)
		a.usage()
		return exitUsage
	}
	if !cmd.takesArgs && len(rest) > 0 {
		a.say("La orden %s no admite argumentos.", name)
		return exitUsage
	}
	if cmd.needsAdmin && !a.elevated() {
		a.say(msgNeedsAdmin)
		return exitError
	}
	return cmd.run(a, rest)
}

func (a *app) usage() {
	_, _ = io.WriteString(a.stderr, usageText)
}

// say prints a human message (Spanish) on stderr.
func (a *app) say(format string, args ...any) {
	_, _ = fmt.Fprintf(a.stderr, format+"\n", args...)
}

// emit prints machine output as one JSON line on stdout.
func (a *app) emit(v any) {
	_ = json.NewEncoder(a.stdout).Encode(v)
}

func (a *app) manager() (serviceManager, bool) {
	m, err := a.newManager(svc.Options{})
	if err != nil {
		a.say("No se pudo preparar el servicio: %v", err)
		return nil, false
	}
	return m, true
}

func (a *app) cmdRun([]string) int {
	var console io.Writer
	if a.interactive() {
		console = a.stderr
	}
	logger, closeLog, err := a.openLogger(console)
	if err != nil {
		a.say("Aviso: no se pudo abrir el registro; se escribe solo en la consola: %v", err)
		logger, closeLog = logx.NewConsole(a.stderr), func() {}
	}
	defer closeLog()
	logger.Info("guardian starting", "version", a.version, "os", runtime.GOOS, "arch", runtime.GOARCH)
	m, err := a.newManager(svc.Options{Logger: logger, Runner: a.newRunner(logger)})
	if err != nil {
		logger.Error("service setup failed", "err", err)
		return exitError
	}
	if err := m.Run(); err != nil {
		logger.Error("service run failed", "err", err)
		return exitError
	}
	logger.Info("guardian exited")
	return exitOK
}

func (a *app) cmdInstall([]string) int {
	if err := a.prepareDirs(); err != nil {
		a.say("No se pudo preparar la carpeta de datos: %v", err)
		return exitError
	}
	m, ok := a.manager()
	if !ok {
		return exitError
	}
	if err := m.Install(); err != nil {
		a.say("No se pudo instalar el guardián: %v", err)
		return exitError
	}
	a.say("Guardián instalado y en marcha.")
	return exitOK
}

func (a *app) cmdUninstall(args []string) int {
	keepData := false
	for _, arg := range args {
		if arg != keepDataFlag {
			a.say("Opción desconocida para uninstall: %q. La única opción es %s.", arg, keepDataFlag)
			return exitUsage
		}
		keepData = true
	}
	m, ok := a.manager()
	if !ok {
		return exitError
	}
	code := exitOK
	// Stop and remove the service first: a running guardian would put the
	// hosts lines back.
	if err := m.Uninstall(); err != nil {
		a.say("No se pudo quitar el servicio: %v", err)
		code = exitError
	}
	if err := a.cleanupHosts(); err != nil {
		a.say("No se pudo limpiar el archivo hosts: %v", err)
		code = exitError
	}
	switch {
	case keepData:
		a.say("Datos conservados en %s.", a.dataDir())
	case code != exitOK:
		// The data folder holds the hosts backup and the service may still be
		// running: keep it so running uninstall again can finish the job.
		a.say("Se conservan los datos en %s. Vuelve a ejecutar «centrate-guardian uninstall» cuando se resuelva el error.", a.dataDir())
	default:
		if err := a.removeData(); err != nil {
			a.say("No se pudieron borrar los datos: %v", err)
			code = exitError
		}
	}
	if code == exitOK {
		a.say("Guardián desinstalado. El sistema queda limpio.")
	}
	return code
}

func (a *app) control(op func(serviceManager) error, done string) int {
	m, ok := a.manager()
	if !ok {
		return exitError
	}
	if err := op(m); err != nil {
		if errors.Is(err, svc.ErrNotInstalled) {
			a.say("El guardián no está instalado.")
		} else {
			a.say("Error: %v", err)
		}
		return exitError
	}
	a.say(done)
	return exitOK
}

func (a *app) cmdStart([]string) int {
	return a.control(serviceManager.Start, "Guardián en marcha.")
}

func (a *app) cmdStop([]string) int {
	return a.control(serviceManager.Stop, "Guardián detenido.")
}

func (a *app) cmdRestart([]string) int {
	return a.control(serviceManager.Restart, "Guardián reiniciado.")
}

type statusOutput struct {
	Installed bool   `json:"installed"`
	Running   bool   `json:"running"`
	Version   string `json:"version"`
}

func (a *app) cmdStatus([]string) int {
	m, ok := a.manager()
	if !ok {
		return exitError
	}
	st, err := m.Status()
	if err != nil {
		a.say("No se pudo consultar el servicio: %v", err)
		return exitError
	}
	a.emit(statusOutput{Installed: st.Installed, Running: st.Running, Version: a.version})
	return exitOK
}

func (a *app) cmdHasActive([]string) int {
	active, err := a.hasActive()
	if err != nil {
		a.say("No se pudo saber si hay bloqueos activos: %v", err)
		return exitError
	}
	a.emit(struct {
		Active bool `json:"active"`
	}{active})
	if active {
		return exitActive
	}
	return exitOK
}

func (a *app) cmdCleanupHosts([]string) int {
	if err := a.cleanupHosts(); err != nil {
		a.say("No se pudo limpiar el archivo hosts: %v", err)
		return exitError
	}
	a.say("Sección de Céntrate quitada del archivo hosts.")
	return exitOK
}

func (a *app) cmdVersion([]string) int {
	a.emit(struct {
		Version string `json:"version"`
	}{a.version})
	return exitOK
}
