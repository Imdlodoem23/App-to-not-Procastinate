//go:build linux

package platform

import (
	"context"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
)

// procRoot is where lookupPeer reads the process table (tests use a fake).
var procRoot = "/proc"

func lookupPeer(ctx context.Context, client, server netip.AddrPort) (int, string, bool) {
	return procPeer(ctx, procRoot, client, server)
}

// procPeer implements the Linux lookup on a /proc tree at root.
func procPeer(ctx context.Context, root string, client, server netip.AddrPort) (int, string, bool) {
	var inode uint64
	found := false
	for _, table := range []string{"tcp", "tcp6"} {
		data, err := os.ReadFile(filepath.Join(root, "net", table))
		if err != nil {
			continue
		}
		if inode, found = parseProcNetTCP(data, client, server); found {
			break
		}
	}
	if !found {
		return 0, "", false
	}
	pid, ok := procSocketOwner(ctx, root, inode)
	if !ok {
		return 0, "", false
	}
	exe, err := os.Readlink(filepath.Join(root, strconv.Itoa(pid), "exe"))
	if err != nil || !filepath.IsAbs(exe) {
		return 0, "", false
	}
	return pid, exe, true
}

// procSocketOwner returns a process holding the socket inode: the first
// /proc/<pid>/fd/<n> link to it. Processes whose fd directory cannot be read
// (another user's, without root) are skipped.
func procSocketOwner(ctx context.Context, root string, inode uint64) (int, bool) {
	want := socketLink(inode)
	ents, err := os.ReadDir(root)
	if err != nil {
		return 0, false
	}
	for _, e := range ents {
		if ctx.Err() != nil {
			return 0, false
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 {
			continue
		}
		fdDir := filepath.Join(root, e.Name(), "fd")
		fds, err := os.ReadDir(fdDir)
		if err != nil {
			continue
		}
		for _, fd := range fds {
			if link, err := os.Readlink(filepath.Join(fdDir, fd.Name())); err == nil && link == want {
				return pid, true
			}
		}
	}
	return 0, false
}
