//go:build !linux && !darwin && !windows

package nuclear

import "context"

// AppRunning implements engine.NuclearRelauncher (unsupported here).
func (r *Relauncher) AppRunning() (bool, error) { return false, ErrUnsupported }

// Relaunch implements engine.NuclearRelauncher (unsupported here).
func (r *Relauncher) Relaunch(context.Context) error { return ErrUnsupported }
