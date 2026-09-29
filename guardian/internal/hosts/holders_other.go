//go:build !windows

package hosts

// osLockHolders finds nothing: outside Windows an open file never keeps
// another process from replacing or rewriting it.
func osLockHolders(string) ([]LockHolder, error) { return nil, nil }
