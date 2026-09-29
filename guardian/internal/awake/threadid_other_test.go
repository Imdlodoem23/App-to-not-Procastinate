//go:build !linux

package awake

import "testing"

func threadID() int { return 0 }

// assertOneThread is checked on Linux only (it needs the thread id).
func assertOneThread(*testing.T, *fakeExecState) {}
