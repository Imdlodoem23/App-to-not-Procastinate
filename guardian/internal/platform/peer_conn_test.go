package platform

import (
	"net"
	"testing"
)

// loopbackConnPair returns both ends of a loopback TCP connection: the
// client's and the one the listener accepted.
func loopbackConnPair(t *testing.T) (client, accepted net.Conn) {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Skipf("no loopback: %v", err)
	}
	defer ln.Close()
	ch := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			close(ch)
			return
		}
		ch <- c
	}()
	client, err = net.Dial("tcp4", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	accepted, ok := <-ch
	if !ok {
		client.Close()
		t.Fatal("accept failed")
	}
	return client, accepted
}
