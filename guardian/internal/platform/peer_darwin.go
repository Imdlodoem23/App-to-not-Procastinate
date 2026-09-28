//go:build darwin

package platform

import (
	"context"
	"net/netip"
	"os/exec"

	"golang.org/x/sys/unix"
)

// runLsof runs lsofPath with lsofArgs and an empty environment (tests fake
// it). Nothing from the request is ever on the command line (§9.7).
var runLsof = func(ctx context.Context) ([]byte, error) {
	cmd := exec.CommandContext(ctx, lsofPath, lsofArgs...)
	cmd.Env = []string{}
	return cmd.Output()
}

// procArgs reads kern.procargs2 of pid (tests fake it).
var procArgs = func(pid int) ([]byte, error) { return unix.SysctlRaw("kern.procargs2", pid) }

func lookupPeer(ctx context.Context, client, server netip.AddrPort) (int, string, bool) {
	if !server.Addr().Is4() {
		return 0, "", false // lsofArgs select 127.0.0.1, where the guardian listens
	}
	out, err := runLsof(ctx)
	if len(out) == 0 && err != nil {
		return 0, "", false
	}
	pid, ok := parseLsof(out, client, server)
	if !ok {
		return 0, "", false
	}
	b, err := procArgs(pid)
	if err != nil {
		return 0, "", false
	}
	exe := execPathFromProcargs2(b)
	if exe == "" {
		return 0, "", false
	}
	return pid, exe, true
}
