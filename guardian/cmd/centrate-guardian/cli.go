package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"runtime"
	"strings"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
	"github.com/imdlodoem23/centrate/guardian/internal/logx"
	"github.com/imdlodoem23/centrate/guardian/internal/svc"
)

// Exit codes.
const (
	exitOK           = 0
	exitError        = 1
	exitUsage        = 2
	exitNotInstalled = 3  // start, restart: the service is not installed
	exitActive       = 10 // has-active: a normal or strict block is active
	exitActiveStrong = 11 // has-active: a hardcore, exam or punishment block is active
)

const (
	keepDataFlag = "--keep-data"
	appPathFlag  = "--app-path"
)

// problemAPIUnavailable is reported by status when the service runs but its API
// does not answer (the port is taken, §10.12 step 12).
const problemAPIUnavailable = "api_unavailable"

const usageText = `Uso: centrate-guardian <orden>

Órdenes:
  run                        Ejecuta el guardián (lo usa el gestor de servicios).
  install [--app-path RUTA]  Instala o actualiza el servicio y lo (re)arranca.
                             RUTA es el ejecutable de la app; sin ella se usa
                             la app que acompaña al guardián.
  prepare-update             Para el servicio antes de sustituir sus archivos
                             (solo instaladores y actualizaciones).
  uninstall [--keep-data]    Para y quita el servicio, limpia el archivo hosts
                             y borra los datos (salvo con --keep-data).
  start | stop | restart     Arranca, para o reinicia el servicio.
  status                     Muestra en JSON si está instalado y en marcha.
  has-active                 Sale con código 10 si hay un bloqueo Normal o
                             Estricto activo, 11 si es Hardcore, Examen o castigo.
  cleanup-hosts              Quita la sección de Céntrate del archivo hosts.
  version                    Muestra la versión en JSON.

install, prepare-update, uninstall, start, stop, restart y cleanup-hosts
necesitan permisos de administrador.

Códigos de salida: 0 bien; 1 error; 2 uso incorrecto; 3 el servicio no está
instalado (start y restart; stop y prepare-update salen con 0 porque ya está
parado); 10 hay un bloqueo activo y 11 hay un bloqueo Hardcore, Examen o
castigo activo (has-active).
`

const msgNeedsAdmin = "Esta orden necesita permisos de administrador. Ejecútala con sudo (macOS y Linux) o desde una consola de administrador (Windows)."

// serviceManager is the part of *svc.Manager the CLI uses (faked in tests).
type serviceManager interface {
	Install() error
	Uninstall() error
	Start() error
	Stop() error
	StopPlanned(reason string) error
	Restart() error
	Status() (svc.Status, error)
	Run() error
}

// app holds every side effect of the CLI so tests can replace them.
type app struct {
	stdout, stderr io.Writer
	version        string

	interactive   func() bool
	elevated      func() bool
	useSystemPATH func()
	newManager    func(svc.Options) (serviceManager, error)
	newRunner     func(*slog.Logger) svc.Runner
	openLogger    func(console io.Writer) (*slog.Logger, func(), error)
	prepareDirs   func() error
	cleanupHosts  func() error
	hasActive     func() (engine.ActiveLevel, error)
	removeData    func() error
	removeExtras  func() error // the anchor and the Nuclear LaunchAgent
	dataDir       func() string
	writeConfig   func(appPath string) error
	bundledApp    func() (string, error) // the app shipped with this binary (install without --app-path)
	plannedStop   func() error           // the planned-stop marker of a restart by install
	probeAPI      func() bool
}

type command struct {
	needsAdmin bool
	takesArgs  bool
	run        func(a *app, args []string) int
}

var commands = map[string]command{
	"run":            {run: (*app).cmdRun},
	"install":        {needsAdmin: true, takesArgs: true, run: (*app).cmdInstall},
	"prepare-update": {needsAdmin: true, run: (*app).cmdPrepareUpdate},
	"uninstall":      {needsAdmin: true, takesArgs: true, run: (*app).cmdUninstall},
	"start":          {needsAdmin: true, run: (*app).cmdStart},
	"stop":           {needsAdmin: true, run: (*app).cmdStop},
	"restart":        {needsAdmin: true, run: (*app).cmdRestart},
	"status":         {run: (*app).cmdStatus},
	"has-active":     {run: (*app).cmdHasActive},
	"cleanup-hosts":  {needsAdmin: true, run: (*app).cmdCleanupHosts},
	"version":        {run: (*app).cmdVersion},
}

// run dispatches args (without the program name) and returns the exit code.
func (a *app) run(args []string) int {
	if a.elevated() {
		// Every binary an elevated command runs by name (kardianos runs
		// systemctl and launchctl that way) must come from system folders,
		// whatever PATH the caller passed down (sudo -E, pkexec helpers).
		a.useSystemPATH()
	}
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
	return a.managerWith(svc.Options{})
}

func (a *app) managerWith(o svc.Options) (serviceManager, bool) {
	m, err := a.newManager(o)
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

// parseInstallArgs reads install's only option, --app-path <ruta> (or
// --app-path=<ruta>): the desktop app's executable, written by installers to
// config.json (§10.5). It returns the resolved path, or "" when absent.
func (a *app) parseInstallArgs(args []string) (string, bool) {
	appPath := ""
	for i := 0; i < len(args); i++ {
		arg := args[i]
		var val string
		switch {
		case arg == appPathFlag && i+1 < len(args):
			i++
			val = args[i]
		case strings.HasPrefix(arg, appPathFlag+"="):
			val = strings.TrimPrefix(arg, appPathFlag+"=")
		default:
			a.say("Opción desconocida para install: %q. La única opción es %s <ruta>.", arg, appPathFlag)
			return "", false
		}
		if appPath != "" {
			a.say("La opción %s solo puede aparecer una vez.", appPathFlag)
			return "", false
		}
		p, err := validAppPath(val)
		if err != nil {
			a.say("Ruta de la app no válida: %v.", err)
			return "", false
		}
		appPath = p
	}
	return appPath, true
}

func (a *app) cmdInstall(args []string) int {
	appPath, ok := a.parseInstallArgs(args)
	if !ok {
		return exitUsage
	}
	if appPath == "" {
		// Installers run the guardian shipped inside the app, so the app's executable
		// is at a fixed place next to it (§10.5, §17 item 5): without appPath the
		// Nuclear supervisor cannot relaunch the app and refuses its heartbeats.
		p, err := a.bundledApp()
		if err != nil {
			a.say("Aviso: no se encontró la app de Céntrate junto al guardián (%v); se conserva la ruta de la app ya configurada.", err)
		} else {
			appPath = p
		}
	}
	if err := a.prepareDirs(); err != nil {
		a.say("No se pudo preparar la carpeta de datos: %v", err)
		return exitError
	}
	if err := a.writeConfig(appPath); err != nil {
		a.say("No se pudo escribir la configuración del guardián: %v", err)
		return exitError
	}
	m, ok := a.manager()
	if !ok {
		return exitError
	}
	// Installing restarts a running guardian: that stop is planned and must not
	// be priced as a stop during a block (§10.12 step 9). A guardian that is not
	// running was stopped earlier: by prepare-update, which wrote the marker
	// itself, or by someone else, and then that gap stays unexplained.
	if st, err := m.Status(); err == nil && st.Running {
		if err := a.plannedStop(); err != nil {
			a.say("Aviso: no se pudo marcar la parada como prevista: %v", err)
		}
	}
	if err := m.Install(); err != nil {
		a.say("No se pudo instalar el guardián: %v", err)
		a.hint(err)
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
		} else if err := a.removeExtras(); err != nil {
			a.say("No se pudieron borrar los restos del guardián: %v", err)
			code = exitError
		}
	}
	if code == exitOK {
		a.say("Guardián desinstalado. El sistema queda limpio.")
	}
	return code
}

// control runs a start, stop, restart or prepare-update on a manager built with
// o. notInstalled is the exit code when the service is not installed.
func (a *app) control(o svc.Options, op func(serviceManager) error, done string, notInstalled int) int {
	m, ok := a.managerWith(o)
	if !ok {
		return exitError
	}
	if err := op(m); err != nil {
		if errors.Is(err, svc.ErrNotInstalled) {
			if notInstalled == exitOK {
				a.say("El guardián no está instalado: no hay nada que parar.")
			} else {
				a.say("El guardián no está instalado.")
			}
			return notInstalled
		}
		a.say("Error: %v", err)
		a.hint(err)
		return exitError
	}
	a.say(done)
	return exitOK
}

func (a *app) cmdStart([]string) int {
	return a.control(svc.Options{}, serviceManager.Start, "Guardián en marcha.", exitNotInstalled)
}

// cmdStop succeeds when the service is not installed: the goal (nothing
// running) is already met. A plain stop writes no planned-stop marker, so a
// stop during a block is priced at the next start (§10.12 step 9).
func (a *app) cmdStop([]string) int {
	return a.control(svc.Options{}, serviceManager.Stop, "Guardián detenido.", exitOK)
}

func (a *app) cmdRestart([]string) int {
	return a.control(svc.Options{}, serviceManager.Restart, "Guardián reiniciado.", exitNotInstalled)
}

// cmdPrepareUpdate is the stop of an installer or updater about to replace the
// guardian's files (NSIS before the files are extracted, the .deb prerm on
// upgrade): the planned-stop marker first, so the next start does not price the
// stop as one during a block (§10.12 step 9, §13), then a stop that waits for
// the process to exit (svc.Manager.StopPlanned). A marker that cannot be
// written never blocks the update; svc logs why on stderr, which installers
// keep in their log. Like stop, it succeeds when the service is not installed.
func (a *app) cmdPrepareUpdate([]string) int {
	stop := func(m serviceManager) error { return m.StopPlanned(svc.PlannedStopUpdate) }
	return a.control(svc.Options{Logger: logx.NewConsole(a.stderr)}, stop, "Guardián detenido para actualizarlo.", exitOK)
}

// hint explains, in Spanish, the errors the user can do something about.
func (a *app) hint(err error) {
	switch {
	case errors.Is(err, svc.ErrMarkedForDeletion):
		a.say("Windows todavía está quitando el servicio anterior. Cierra la ventana «Servicios» (y el Visor de eventos, si está abierto) o reinicia el ordenador, y vuelve a intentarlo.")
	case errors.Is(err, svc.ErrDisabledByUser):
		a.say("macOS tiene desactivado el guardián. Actívalo en Ajustes del Sistema › General › Ítems de inicio y vuelve a intentarlo.")
	case errors.Is(err, svc.ErrUntrustedExecutable):
		a.say("El guardián está en una carpeta que otros usuarios pueden modificar y no se puede instalar como servicio desde ahí. Usa el instalador de Céntrate.")
	}
}

type statusOutput struct {
	Installed bool     `json:"installed"`
	Running   bool     `json:"running"`
	Version   string   `json:"version"`
	Problems  []string `json:"problems"`
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
	out := statusOutput{Installed: st.Installed, Running: st.Running, Version: a.version, Problems: []string{}}
	if st.Running && !a.probeAPI() {
		out.Problems = append(out.Problems, problemAPIUnavailable)
	}
	a.emit(out)
	return exitOK
}

// cmdHasActive reads the enforcement core of state.json (it works with the
// service stopped, §13) and exits 0, 10 (normal or strict) or 11 (hardcore,
// exam or punishment).
func (a *app) cmdHasActive([]string) int {
	level, err := a.hasActive()
	if err != nil {
		a.say("No se pudo saber si hay bloqueos activos: %v", err)
		return exitError
	}
	a.emit(struct {
		Active bool `json:"active"`
	}{level != engine.ActiveNone})
	switch level {
	case engine.ActiveNone:
		return exitOK
	case engine.ActiveStrong:
		return exitActiveStrong
	default:
		return exitActive
	}
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
