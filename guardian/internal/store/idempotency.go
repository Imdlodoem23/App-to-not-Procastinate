package store

import (
	"crypto/sha256"
	"encoding/hex"
	"slices"
	"sort"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

// IdempotencyRecord is one stored idempotent request (§8.6), persisted in state.json
// with its response so a replay after a restart returns exactly the original body.
// The API layer owns the lookup semantics; the store only persists the records.
type IdempotencyRecord struct {
	// Lookup is the API layer's lookup key, e.g. hex(sha256(scope | key)): the raw
	// Idempotency-Key never needs to be stored.
	Lookup string `json:"lookup"`
	Scope  string `json:"scope"`
	Method string `json:"method"`
	// Path is the concrete path of the original request.
	Path string `json:"path"`
	// RequestHash is hex(sha256(path | body)): a different path or body with the same
	// key is a 409 idempotency_conflict.
	RequestHash string `json:"requestHash"`
	// Req is the fingerprint written into the events of the batch (ReqFingerprint).
	Req    string `json:"req"`
	Status int    `json:"status"`
	// Body is the exact response body (base64 in state.json, so it round-trips byte
	// for byte).
	Body []byte `json:"body"`
	// CreatedAtMs is the trusted time of the original request (Unix ms).
	CreatedAtMs int64 `json:"createdAtMs"`
}

// ReqFingerprint is the envelope req of events caused by an idempotent request:
// hex(sha256(scope | method | concrete path | key))[:32] (§8.6).
func ReqFingerprint(scope, method, path, key string) string {
	sum := sha256.Sum256([]byte(scope + "|" + method + "|" + path + "|" + key))
	return hex.EncodeToString(sum[:])[:32]
}

// PruneIdempotency drops the records older than GUARDIAN_LIMITS.idempotencyTtlMs at
// trusted time nowMs and keeps the newest idempotencyMaxEntries. Records stamped after
// nowMs (trusted time stepped back after a calibration) are kept. The input is not
// modified.
func PruneIdempotency(recs []IdempotencyRecord, nowMs int64) []IdempotencyRecord {
	lim := embedded.API().Limits
	ttl := int64(lim.IdempotencyTTLMs)
	out := make([]IdempotencyRecord, 0, len(recs))
	for _, r := range recs {
		if nowMs-r.CreatedAtMs < ttl {
			out = append(out, r)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAtMs < out[j].CreatedAtMs })
	if n := lim.IdempotencyMaxEntries; len(out) > n {
		out = out[len(out)-n:]
	}
	return cloneRecords(out)
}

func cloneRecords(recs []IdempotencyRecord) []IdempotencyRecord {
	if recs == nil {
		return nil
	}
	out := make([]IdempotencyRecord, len(recs))
	for i, r := range recs {
		r.Body = slices.Clone(r.Body)
		out[i] = r
	}
	return out
}
