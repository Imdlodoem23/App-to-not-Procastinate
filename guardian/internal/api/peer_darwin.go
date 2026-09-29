//go:build darwin

package api

import (
	"context"
	"errors"
	"net/netip"
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/unix"

	"github.com/imdlodoem23/centrate/guardian/internal/procwatch"
)

// lsofPath is the absolute path of lsof (§9.7: absolute path, constant argv).
const lsofPath = "/usr/sbin/lsof"

// OSPeerResolver returns the macOS resolver: lsof (constant arguments, lsofArgs)
// gives the PID of the client end, procwatch.List describes the process (exec path
// from kern.procargs2, system account or not) and the owner of /dev/console is the
// console user.
func OSPeerResolver() PeerResolver { return darwinPeers{} }

type darwinPeers struct{}

func (darwinPeers) Resolve(ctx context.Context, client, server netip.AddrPort) (PeerInfo, error) {
	cmd := exec.CommandContext(ctx, lsofPath, lsofArgs...)
	cmd.Env = []string{}
	out, err := cmd.Output()
	if len(out) == 0 && err != nil {
		return PeerInfo{}, err
	}
	pid, ok := parseLsofPeer(out, client, server)
	if !ok {
		return PeerInfo{}, errPeerNotFound
	}
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return PeerInfo{}, err
	}
	procs, err := procwatch.List()
	if err != nil {
		return PeerInfo{}, err
	}
	for _, pr := range procs {
		if pr.PID != pid {
			continue
		}
		consoleUID, cerr := consoleOwner()
		return PeerInfo{
			PID: pid, Name: pr.Name, Path: pr.Path, Interactive: !pr.System,
			Console: !pr.System && cerr == nil && kp.Eproc.Ucred.Uid == consoleUID,
		}, nil
	}
	return PeerInfo{}, errPeerNotFound
}

// consoleOwner is the uid owning /dev/console (the logged-in console user).
func consoleOwner() (uint32, error) {
	fi, err := os.Stat("/dev/console")
	if err != nil {
		return 0, err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, errors.New("api: /dev/console has no owner")
	}
	return st.Uid, nil
}
