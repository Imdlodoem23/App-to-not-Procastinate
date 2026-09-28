package api

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

func TestHealthAndClientFile(t *testing.T) {
	env := newTestEnv(t)
	r := env.do("GET", "/v1/health", nil)
	expect(t, r, http.StatusOK, "")
	var h engine.HealthResponse
	r.decode(t, &h)
	if !h.OK || h.APIVersion != embedded.API().APIVersion {
		t.Fatalf("health = %+v", h)
	}
	if got := r.header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := r.header.Get(headerAPIVersion); got != "1" {
		t.Fatalf("%s = %q", headerAPIVersion, got)
	}

	f := env.clientFile()
	if f.V != 1 || f.Port != env.port || f.GuardianVersion != "0.1.0-test" || f.PID != os.Getpid() {
		t.Fatalf("client.json = %+v", f)
	}
	if !strings.HasPrefix(f.Token, appTokenPrefix) || len(f.Token) != len(appTokenPrefix)+43 {
		t.Fatalf("token shape %q", f.Token[:4])
	}
	if f.IssuedAt != "2026-09-28T10:00:00.000Z" {
		t.Fatalf("issuedAt = %q", f.IssuedAt)
	}
	// The app token works; the client.json is plain ordinary guardian data (0644).
	expect(t, env.do("GET", "/v1/points", nil, env.app()), http.StatusOK, "")
	fi, err := os.Stat(filepath.Join(env.dir, ClientFileName))
	if err != nil {
		t.Fatal(err)
	}
	if runtimeIsUnix() && fi.Mode().Perm() != 0o644 {
		t.Fatalf("client.json mode %v", fi.Mode().Perm())
	}
}

func TestTokenRotatesOnEveryStart(t *testing.T) {
	env := newTestEnv(t)
	old := env.token
	if err := env.srv.Stop(); err != nil {
		t.Fatal(err)
	}
	cfg := env.cfg
	srv, err := New(Options{
		Engine: env.eng, DataDir: env.dir, Config: &cfg, Peers: env.peer,
		Listen: func(ctx context.Context, _ string) (net.Listener, error) {
			var lc net.ListenConfig
			return lc.Listen(ctx, "tcp4", "127.0.0.1:0")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = srv.Stop() }()
	<-srv.Bound()
	env.base = "http://" + srv.Addr().String()
	fresh := env.clientFile().Token
	if fresh == old {
		t.Fatal("the token did not rotate")
	}
	expect(t, env.do("GET", "/v1/points", nil, withToken(old)), http.StatusUnauthorized, codeUnauthorized)
	expect(t, env.do("GET", "/v1/points", nil, withToken(fresh)), http.StatusOK, "")
}

func TestBindRetriesAndWritesClientFileOnlyAfterBind(t *testing.T) {
	env := newTestEnv(t)
	_ = env.srv.Stop()
	dir := filepath.Join(t.TempDir(), "centrate")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	var attempts atomic.Int32
	release := make(chan struct{})
	cfg := env.cfg
	srv, err := New(Options{
		Engine: env.eng, DataDir: dir, Config: &cfg, Peers: env.peer,
		Listen: func(ctx context.Context, _ string) (net.Listener, error) {
			attempts.Add(1)
			select {
			case <-release:
				var lc net.ListenConfig
				return lc.Listen(ctx, "tcp4", "127.0.0.1:0")
			default:
				return nil, errors.New("address already in use")
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.Start(context.Background()); err != nil {
		t.Fatalf("Start must not fail while the port is taken: %v", err)
	}
	defer func() { _ = srv.Stop() }()
	if _, err := os.Stat(filepath.Join(dir, ClientFileName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("client.json written before the bind: %v", err)
	}
	close(release)
	select {
	case <-srv.Bound():
	case <-time.After(10 * time.Second):
		t.Fatal("never bound")
	}
	if attempts.Load() < 2 {
		t.Fatalf("attempts = %d", attempts.Load())
	}
	if _, err := os.Stat(filepath.Join(dir, ClientFileName)); err != nil {
		t.Fatalf("client.json after the bind: %v", err)
	}
}

func TestStopEndsLongPollsQuickly(t *testing.T) {
	env := newTestEnv(t)
	done := make(chan response, 1)
	path := env.eventsPoll(25000)
	go func() { done <- env.do("GET", path, nil, env.app()) }()
	waitFor(t, "the long poll", func() bool { return env.srv.polls.inFlight(authApp) == 1 })
	start := time.Now()
	if err := env.srv.Stop(); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > stopGrace+time.Second {
		t.Fatalf("Stop took %v", d)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the long poll did not end")
	}
}

func TestLoadConfig(t *testing.T) {
	dir := t.TempDir()
	cfg, err := LoadConfig(dir)
	if err != nil || cfg.Port != embedded.API().DefaultPort || cfg.AppPath != "" {
		t.Fatalf("missing file: %+v %v", cfg, err)
	}
	write := func(v any) {
		raw, _ := json.Marshal(v)
		if err := os.WriteFile(filepath.Join(dir, ConfigFileName), raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	abs := filepath.Join(dir, "app", "centrate")
	write(map[string]any{
		"schemaVersion": 1, "port": 47601, "appPath": abs, "logLevel": "debug",
		"extraExtensionIds": []string{"abcdefghijklmnopabcdefghijklmnop"}, "future": true,
	})
	cfg, err = LoadConfig(dir)
	if err != nil || cfg.Port != 47601 || cfg.AppPath != abs || len(cfg.ExtraExtensionIDs) != 1 || cfg.LogLevel != "debug" {
		t.Fatalf("valid file: %+v %v", cfg, err)
	}
	write(map[string]any{"port": 70000, "appPath": "relative/app", "extraExtensionIds": []string{"not-an-id"}})
	cfg, err = LoadConfig(dir)
	if err == nil || cfg.Port != embedded.API().DefaultPort || cfg.AppPath != "" || len(cfg.ExtraExtensionIDs) != 0 {
		t.Fatalf("invalid values: %+v %v", cfg, err)
	}
	if err := os.WriteFile(filepath.Join(dir, ConfigFileName), []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	if cfg, err = LoadConfig(dir); err == nil || cfg.Port != embedded.API().DefaultPort {
		t.Fatalf("broken file: %+v %v", cfg, err)
	}
}

func TestLimitListenerCapsConnections(t *testing.T) {
	var lc net.ListenConfig
	inner, err := lc.Listen(context.Background(), "tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	l := newLimitListener(inner, 1)
	defer func() { _ = l.Close() }()
	accepted := make(chan net.Conn, 2)
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				close(accepted)
				return
			}
			accepted <- c
		}
	}()
	var d net.Dialer
	c1, err := d.Dial("tcp4", inner.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c1.Close() }()
	first := <-accepted
	c2, err := d.Dial("tcp4", inner.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c2.Close() }()
	select {
	case <-accepted:
		t.Fatal("a second connection was accepted while the first is open")
	case <-time.After(100 * time.Millisecond):
	}
	_ = first.Close()
	select {
	case c := <-accepted:
		_ = c.Close()
	case <-time.After(5 * time.Second):
		t.Fatal("the second connection was never accepted")
	}
}
