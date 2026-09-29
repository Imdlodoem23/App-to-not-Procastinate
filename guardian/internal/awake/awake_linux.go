//go:build linux

package awake

// Mechanism names the OS mechanism for logs and diagnostics.
const Mechanism = "systemd-inhibit"

// New returns the Linux inhibitor: a supervised systemd-inhibit child (logind), or
// Unsupported when systemd-inhibit or sleep is not installed at a fixed path. onChange
// is called (from another goroutine, never blocking the caller) whenever Status changes.
func New(onChange func(), opts ...Option) Inhibitor {
	o := newOptions(opts)
	inhibit, ok1 := findExecutable(systemdInhibitCandidates)
	sleep, ok2 := findExecutable(sleepCandidates)
	if !ok1 || !ok2 {
		o.log.Info("keep-awake: systemd-inhibit or sleep not found at a fixed path; unsupported on this machine",
			"systemdInhibit", ok1, "sleep", ok2)
		return Unsupported()
	}
	argv := systemdInhibitArgv(inhibit, sleep)
	return newSupervisor(Mechanism, func() (process, error) { return startProcess(argv) }, realClock{}, o, onChange)
}
