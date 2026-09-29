//go:build !windows && !darwin && !linux

package hosts

import "context"

// flushDNS does nothing on systems without a known DNS cache command.
func flushDNS(context.Context, runFunc) error { return nil }
