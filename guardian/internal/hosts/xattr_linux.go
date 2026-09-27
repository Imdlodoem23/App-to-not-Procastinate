package hosts

import "golang.org/x/sys/unix"

const maxXattrSize = 64 << 10

// copiedXattrs are the extended attributes the replacement file inherits. The
// list is deliberately short: the SELinux label (/etc/hosts is net_conf_t on
// Fedora and RHEL; a new file in /etc would get etc_t), the Smack label and
// the POSIX ACL. Integrity attributes such as security.ima and security.evm
// must never be copied: they describe the old content, and a stale signature
// can make the kernel refuse to open the new file.
var copiedXattrs = []string{
	"security.selinux",
	"security.SMACK64",
	"system.posix_acl_access",
}

func readXattrs(path string) []xattr {
	var out []xattr
	for _, name := range copiedXattrs {
		n, err := unix.Getxattr(path, name, nil) // size query
		if err != nil || n <= 0 || n > maxXattrSize {
			continue
		}
		buf := make([]byte, n)
		if n, err = unix.Getxattr(path, name, buf); err == nil {
			out = append(out, xattr{name: name, value: buf[:n]})
		}
	}
	return out
}

func writeXattrs(path string, attrs []xattr) {
	for _, a := range attrs {
		_ = unix.Setxattr(path, a.name, a.value, 0)
	}
}
