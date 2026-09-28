package api

import (
	"bytes"
	"context"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

func TestIdempotentReplay(t *testing.T) {
	env := newTestEnv(t)
	key := withHeader("Idempotency-Key", "0b5c7c7e-3a51-4c49-9f3e-2f1c1f7d9a10")
	first := env.do("POST", "/v1/blocks", blockBody(30), env.app(), key)
	expect(t, first, http.StatusCreated, "")
	if first.header.Get(headerReplayed) != "" {
		t.Fatal("the first answer is not a replay")
	}
	again := env.do("POST", "/v1/blocks", blockBody(30), env.app(), key)
	expect(t, again, http.StatusCreated, "")
	if again.header.Get(headerReplayed) != "true" || !bytes.Equal(again.body, first.body) {
		t.Fatalf("replay: %s %q\nfirst %s", again.header.Get(headerReplayed), again.body, first.body)
	}
	// Only one block exists.
	r := env.do("GET", "/v1/blocks", nil, env.app())
	var list engine.ListBlocksResponse
	r.decode(t, &list)
	if len(list.Blocks) != 1 {
		t.Fatalf("%d blocks after a replay", len(list.Blocks))
	}
	// Same key, another body or another path: 409 idempotency_conflict.
	expect(t, env.do("POST", "/v1/blocks", blockBody(31), env.app(), key), http.StatusConflict, "idempotency_conflict")
	id := list.Blocks[0].ID
	expect(t, env.do("POST", "/v1/blocks/"+id+"/extend", map[string]any{"addMinutes": 5}, env.app(), key),
		http.StatusConflict, "idempotency_conflict")
	// Without a key a repeated request is a new intention.
	env.createBlock(30)
	env.createBlock(30)
	r = env.do("GET", "/v1/blocks", nil, env.app())
	r.decode(t, &list)
	if len(list.Blocks) != 3 {
		t.Fatalf("%d blocks, want 3", len(list.Blocks))
	}

	// Extend replays per concrete path: a key reused on another block is a conflict,
	// never block A's answer.
	k2 := withHeader("Idempotency-Key", "ext-1")
	a := env.do("POST", "/v1/blocks/"+list.Blocks[0].ID+"/extend", map[string]any{"addMinutes": 5}, env.app(), k2)
	expect(t, a, http.StatusOK, "")
	b := env.do("POST", "/v1/blocks/"+list.Blocks[1].ID+"/extend", map[string]any{"addMinutes": 5}, env.app(), k2)
	expect(t, b, http.StatusConflict, "idempotency_conflict")
	a2 := env.do("POST", "/v1/blocks/"+list.Blocks[0].ID+"/extend", map[string]any{"addMinutes": 5}, env.app(), k2)
	if a2.status != http.StatusOK || !bytes.Equal(a2.body, a.body) || a2.header.Get(headerReplayed) != "true" {
		t.Fatalf("extend replay: %d %s", a2.status, a2.body)
	}
}

func TestIdempotencyKeyValidation(t *testing.T) {
	env := newTestEnv(t)
	for _, k := range []string{strings.Repeat("a", 129), "has space", "ümlaut", "a/b"} {
		r := env.do("POST", "/v1/blocks", blockBody(30), env.app(), withHeader("Idempotency-Key", k))
		expect(t, r, http.StatusUnprocessableEntity, codeValidationFailed)
		if r.errDetails()["path"] != headerIdemKey {
			t.Fatalf("details = %v", r.errDetails())
		}
	}
	r := env.do("POST", "/v1/blocks", blockBody(30), env.app(), func(r *http.Request) {
		r.Header.Add("Idempotency-Key", "a")
		r.Header.Add("Idempotency-Key", "b")
	})
	expect(t, r, http.StatusUnprocessableEntity, codeValidationFailed)
	expect(t, env.do("POST", "/v1/blocks", blockBody(30), env.app(), withHeader("Idempotency-Key", strings.Repeat("a", 128))),
		http.StatusCreated, "")
	// Routes that are not idempotent ignore the header.
	expect(t, env.do("POST", "/v1/pairing/code", map[string]any{}, env.app(), withHeader("Idempotency-Key", "bad key!")),
		http.StatusCreated, "")
}

// TestIdempotentReplayAfterRestart: the records are persisted with state.json, so a
// replay after a restart returns exactly the original body (§8.6).
func TestIdempotentReplayAfterRestart(t *testing.T) {
	env := newTestEnv(t)
	key := withHeader("Idempotency-Key", "restart-1")
	first := env.do("POST", "/v1/blocks", blockBody(45), env.app(), key)
	expect(t, first, http.StatusCreated, "")

	if err := env.srv.Stop(); err != nil {
		t.Fatal(err)
	}
	if err := env.eng.Stop(); err != nil {
		t.Fatal(err)
	}
	env.clk.ServiceRestart(0)
	env.eng = env.openEngine(slog.New(slog.NewTextHandler(env.logs, nil)))
	cfg := env.cfg
	srv, err := New(Options{
		Engine: env.eng, DataDir: env.dir, Config: &cfg, Peers: env.peer, Now: env.now.Now,
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
	t.Cleanup(func() { _ = srv.Stop() })
	<-srv.Bound()
	env.srv, env.base = srv, "http://"+srv.Addr().String()
	env.token = env.clientFile().Token

	again := env.do("POST", "/v1/blocks", blockBody(45), env.app(), key)
	if again.status != http.StatusCreated || again.header.Get(headerReplayed) != "true" || !bytes.Equal(again.body, first.body) {
		t.Fatalf("replay after restart: %d %s\nfirst %s", again.status, again.body, first.body)
	}
}
