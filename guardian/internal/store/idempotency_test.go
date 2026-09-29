package store

import (
	"crypto/sha256"
	"encoding/hex"
	"reflect"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

func TestReqFingerprint(t *testing.T) {
	sum := sha256.Sum256([]byte("app|POST|/v1/blocks|k-1"))
	want := hex.EncodeToString(sum[:])[:32]
	if got := ReqFingerprint("app", "POST", "/v1/blocks", "k-1"); got != want || !reqRE.MatchString(got) {
		t.Fatalf("%s, want %s", got, want)
	}
}

// Idempotency records, stored responses included, survive a restart byte for byte
// (§8.6: a replay after a restart returns exactly the original body).
func TestIdempotencyRecordsPersist(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	out := mustAppend(t, s, batchOf(1, "a"))
	body := []byte("{\"balanceAfter\": -150,\n  \"note\":\"<b>&amp; \xc3\xa9 \\u00e9\"}")
	recs := []IdempotencyRecord{
		{Lookup: "l1", Scope: "app", Method: "POST", Path: "/v1/rewards/redeem", RequestHash: "h1",
			Req: ReqFingerprint("app", "POST", "/v1/rewards/redeem", "k1"), Status: 200, Body: body, CreatedAtMs: 1_000},
		{Lookup: "l2", Scope: "ext:ext_abc", Method: "POST", Path: "/v1/blocks/blk_1/extend", RequestHash: "h2",
			Req: "00ff", Status: 409, Body: []byte(`{"error":{"code":"x"}}`), CreatedAtMs: 2_000},
	}
	if err := s.SaveState(StateSnapshot{LastEventSeq: out[0].Seq, Idempotency: recs, Engine: map[string]int{"n": 1}}); err != nil {
		t.Fatal(err)
	}
	recs[0].Body[0] = 'X' // the store does not keep the caller's buffers
	recs[0].Body[0] = '{'
	s, rep := e.reopen(s)
	if rep.State != StateCurrent {
		t.Fatalf("report %+v", rep)
	}
	ls, err := s.LoadState(nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ls.Idempotency, recs) {
		t.Fatalf("records\n%+v\nwant\n%+v", ls.Idempotency, recs)
	}
	if string(ls.Idempotency[0].Body) != string(body) {
		t.Fatalf("body %q", ls.Idempotency[0].Body)
	}
	ls.Idempotency[0].Body[0] = 'Z'
	again, _ := s.LoadState(nil)
	if again.Idempotency[0].Body[0] != '{' {
		t.Fatal("LoadState returns shared buffers")
	}
	// Data deletion clears them: the engine saves an empty list as both generations.
	if _, err := s.NewEpoch(EpochDataDeleted, []Event{epochStarted("data_deleted", s.Epoch())}); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveStateAll(StateSnapshot{LastEventSeq: 1}); err != nil {
		t.Fatal(err)
	}
	s, _ = e.reopen(s)
	if ls, err := s.LoadState(nil); err != nil || len(ls.Idempotency) != 0 {
		t.Fatalf("after deletion %+v %v", ls.Idempotency, err)
	}
}

func TestPruneIdempotency(t *testing.T) {
	lim := embedded.API().Limits
	ttl := int64(lim.IdempotencyTTLMs)
	now := int64(10_000_000)
	var recs []IdempotencyRecord
	for i := range lim.IdempotencyMaxEntries + 10 {
		recs = append(recs, IdempotencyRecord{Lookup: string(rune('a' + i%26)), CreatedAtMs: now - int64(i)})
	}
	recs = append(recs,
		IdempotencyRecord{Lookup: "expired", CreatedAtMs: now - ttl},
		IdempotencyRecord{Lookup: "future", CreatedAtMs: now + 5_000}, // trusted time stepped back
	)
	out := PruneIdempotency(recs, now)
	if len(out) != lim.IdempotencyMaxEntries {
		t.Fatalf("%d records, want %d", len(out), lim.IdempotencyMaxEntries)
	}
	if out[len(out)-1].Lookup != "future" {
		t.Fatal("newest record dropped")
	}
	for i, r := range out {
		if r.Lookup == "expired" {
			t.Fatal("expired record kept")
		}
		if i > 0 && r.CreatedAtMs < out[i-1].CreatedAtMs {
			t.Fatal("not ordered")
		}
	}
	if len(recs) != lim.IdempotencyMaxEntries+12 {
		t.Fatal("input modified")
	}
}
