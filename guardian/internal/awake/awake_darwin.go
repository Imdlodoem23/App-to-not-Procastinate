//go:build darwin

package awake

import "os"

// Mechanism names the OS mechanism for logs and diagnostics.
const Mechanism = "caffeinate"

// New returns the macOS inhibitor: a supervised `caffeinate -i -w <guardian pid>` child
// (the guardian is built with CGO_ENABLED=0, so no IOPMAssertion), or Unsupported when
// /usr/bin/caffeinate is missing. onChange is called (from another goroutine) whenever
// Status changes.
func New(onChange func(), opts ...Option) Inhibitor {
	o := newOptions(opts)
	if _, ok := findExecutable([]string{caffeinatePath}); !ok {
		o.log.Info("keep-awake: caffeinate not found; unsupported on this machine")
		return Unsupported()
	}
	argv := caffeinateArgv(os.Getpid())
	return newSupervisor(Mechanism, func() (process, error) { return startProcess(argv) }, realClock{}, o, onChange)
}
