//go:build !windows && !darwin

package procwatch

// identify does nothing: Linux executables carry no identity that survives a
// rename (docs/ARCHITECTURE.md §16.3).
func identify([]Process) {}
