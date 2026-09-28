//go:build !windows

package engine

import "os"

// renameNoFlush is the store's POSIX rename: rename(2) replaces newpath atomically. The
// store follows it with a directory fsync, which testFS leaves out.
func renameNoFlush(oldpath, newpath string) error { return os.Rename(oldpath, newpath) }
