//go:build !linux && !darwin && !windows

package awake

// Mechanism names the OS mechanism for logs and diagnostics.
const Mechanism = "none"

// New returns Unsupported: this OS has no keep-awake mechanism.
func New(onChange func(), opts ...Option) Inhibitor {
	_ = onChange
	_ = newOptions(opts)
	return Unsupported()
}
