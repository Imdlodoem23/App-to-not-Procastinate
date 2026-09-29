//go:build darwin

package platform

import (
	"context"
	"encoding/binary"
	"errors"
	"net/netip"
	"testing"
)

func TestLookupPeerDarwinWithFakes(t *testing.T) {
	prevLsof, prevArgs := runLsof, procArgs
	t.Cleanup(func() { runLsof, procArgs = prevLsof, prevArgs })
	runLsof = func(context.Context) ([]byte, error) {
		// lsof exits 1 when some selection had no match; the output counts.
		return []byte("p321\nf9\nn127.0.0.1:52345->127.0.0.1:47600\n"), errors.New("exit status 1")
	}
	exe := "/Applications/Firefox.app/Contents/MacOS/firefox"
	procArgs = func(pid int) ([]byte, error) {
		if pid != 321 {
			t.Errorf("procargs of %d", pid)
		}
		return append(append(binary.NativeEndian.AppendUint32(nil, 1), exe...), 0), nil
	}
	pid, img, ok := LoopbackPeer(context.Background(), peerClient, peerServer)
	if !ok || pid != 321 || img != exe {
		t.Fatalf("LoopbackPeer = %d, %q, %v", pid, img, ok)
	}
	if _, _, ok := LoopbackPeer(context.Background(), netip.MustParseAddrPort("[::1]:52345"), netip.MustParseAddrPort("[::1]:47600")); ok {
		t.Fatal("only 127.0.0.1 is selected by the fixed lsof arguments")
	}
	procArgs = func(int) ([]byte, error) {
		return append(binary.NativeEndian.AppendUint32(nil, 1), "relative\x00"...), nil
	}
	if _, _, ok := LoopbackPeer(context.Background(), peerClient, peerServer); ok {
		t.Fatal("a relative exec path must fail")
	}
	runLsof = func(context.Context) ([]byte, error) { return nil, errors.New("not found") }
	if _, _, ok := LoopbackPeer(context.Background(), peerClient, peerServer); ok {
		t.Fatal("lsof failing must fail")
	}
}
