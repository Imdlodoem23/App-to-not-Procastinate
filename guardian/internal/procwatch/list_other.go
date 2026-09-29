//go:build !linux && !darwin && !windows

package procwatch

import (
	"errors"
	"time"
)

// List is not implemented on this OS.
func List() ([]Process, error) { return nil, errors.ErrUnsupported }

func osKillPlan(time.Duration) killPlan {
	return killPlan{
		goos: "unsupported",
		open: func(int) (procTarget, error) { return nil, errors.ErrUnsupported },
	}
}
