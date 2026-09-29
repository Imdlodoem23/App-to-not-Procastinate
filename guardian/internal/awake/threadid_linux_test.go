//go:build linux

package awake

import (
	"syscall"
	"testing"
)

func threadID() int { return syscall.Gettid() }

// Every execution-state call comes from the same OS thread (the state is per thread).
func assertOneThread(t *testing.T, f *fakeExecState) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, id := range f.tids {
		if id != f.tids[0] {
			t.Fatalf("calls from threads %v", f.tids)
		}
	}
}
