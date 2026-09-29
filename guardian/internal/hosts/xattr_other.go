//go:build unix && !linux

package hosts

// Outside Linux, mode and owner are all that is carried over: macOS keeps
// /etc/hosts without extended ACLs or labels that a new file would lack.

func readXattrs(string) []xattr { return nil }

func writeXattrs(string, []xattr) {}
