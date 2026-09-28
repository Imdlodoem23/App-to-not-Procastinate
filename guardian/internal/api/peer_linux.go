//go:build linux

package api

import (
	"context"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"

	"github.com/imdlodoem23/centrate/guardian/internal/procwatch"
)

// OSPeerResolver returns the Linux resolver: /proc/net/tcp{,6} gives the socket inode
// of the client end, the /proc/<pid>/fd links give its process, and procwatch.List
// describes it (name, /proc/<pid>/exe path, system account or not).
func OSPeerResolver() PeerResolver {
	return linuxPeers{root: "/proc", list: procwatch.List}
}

type linuxPeers struct {
	root string
	list func() ([]procwatch.Process, error)
}

func (p linuxPeers) Resolve(ctx context.Context, client, server netip.AddrPort) (PeerInfo, error) {
	var inode uint64
	found := false
	for _, table := range []string{"tcp", "tcp6"} {
		data, err := os.ReadFile(filepath.Join(p.root, "net", table))
		if err != nil {
			continue
		}
		if inode, found = parseProcNetTCP(data, client, server); found {
			break
		}
	}
	if !found {
		return PeerInfo{}, errPeerNotFound
	}
	pid, err := p.findPID(ctx, inode)
	if err != nil {
		return PeerInfo{}, err
	}
	procs, err := p.list()
	if err != nil {
		return PeerInfo{}, err
	}
	for _, pr := range procs {
		if pr.PID == pid {
			return PeerInfo{PID: pid, Name: pr.Name, Path: pr.Path, Interactive: !pr.System, Console: !pr.System}, nil
		}
	}
	return PeerInfo{}, errPeerNotFound
}

// findPID returns the process holding the socket inode.
func (p linuxPeers) findPID(ctx context.Context, inode uint64) (int, error) {
	want := socketInodeLink(inode)
	ents, err := os.ReadDir(p.root)
	if err != nil {
		return 0, err
	}
	for _, e := range ents {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 {
			continue
		}
		fdDir := filepath.Join(p.root, e.Name(), "fd")
		fds, err := os.ReadDir(fdDir)
		if err != nil {
			continue
		}
		for _, fd := range fds {
			if link, err := os.Readlink(filepath.Join(fdDir, fd.Name())); err == nil && link == want {
				return pid, nil
			}
		}
	}
	return 0, errPeerNotFound
}
