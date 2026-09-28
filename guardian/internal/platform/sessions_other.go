//go:build !windows && !linux && !darwin

package platform

func osSessions() ([]LogonSession, error) { return nil, nil }
