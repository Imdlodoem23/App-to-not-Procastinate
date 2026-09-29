//go:build windows

package awake

import "golang.org/x/sys/windows"

// Mechanism names the OS mechanism for logs and diagnostics.
const Mechanism = "SetThreadExecutionState"

// NewLazySystemDLL only loads from System32.
var procSetThreadExecutionState = windows.NewLazySystemDLL("kernel32.dll").NewProc("SetThreadExecutionState")

// New returns the Windows inhibitor: SetThreadExecutionState from one goroutine locked to
// its OS thread (no cgo). It works from a LocalSystem service (powercfg /requests lists
// it under SYSTEM) and never keeps the display on. onChange is called (from another
// goroutine) whenever Status changes.
func New(onChange func(), opts ...Option) Inhibitor {
	o := newOptions(opts)
	if err := procSetThreadExecutionState.Find(); err != nil {
		o.log.Info("keep-awake: SetThreadExecutionState unavailable; unsupported on this machine")
		return Unsupported()
	}
	set := func(flags uint32) uint32 {
		r, _, _ := procSetThreadExecutionState.Call(uintptr(flags))
		return uint32(r)
	}
	return newThreadState(set, realClock{}, o, onChange)
}
