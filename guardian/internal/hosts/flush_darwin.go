package hosts

import (
	"context"
	"errors"
)

var darwinFlushCommands = [][]string{
	{"/usr/bin/dscacheutil", "-flushcache"},
	{"/usr/bin/killall", "-HUP", "mDNSResponder"},
}

// flushDNS runs both commands even if the first fails.
func flushDNS(ctx context.Context, run runFunc) error {
	var errs []error
	for _, c := range darwinFlushCommands {
		if out, err := run(ctx, c[0], c[1:]...); err != nil {
			errs = append(errs, cmdError(c[0], c[1:], out, err))
		}
	}
	return errors.Join(errs...)
}
