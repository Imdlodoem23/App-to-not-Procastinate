package engine

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"sync"
	"time"
)

// Critical startup evidence (§10.12 steps 4–9). What the ladder learns about the
// previous run lives in files the next save rewrites: run/clock.json measures the stop,
// the rollback anchor remembers a higher balance, the store's repair report exists only
// at this start. The events that record it (the restore clock jump, ledger_repaired,
// tamper_detected{state_mac, ledger_rollback, service_stopped,
// hosts_changed_while_stopped}) are therefore decided before anything is committed and
// written together as the first batch of the run. Until that batch is in the log:
//
//   - every other commit first retries it and fails when it fails (nothing is appended
//     ahead of it);
//   - run/clock.json, state.json and the rollback anchor are not written, so a crash or
//     a restart finds the same evidence again and prices it again;
//   - an idle turn retries it every criticalRetryEvery.

// criticalRetryEvery paces the retries of a turn that commits nothing else.
const criticalRetryEvery = 5 * time.Second

// criticalEv adds one piece of evidence to the batch that carries it (built at each
// attempt, so amounts derived from the balance use the balance of that moment).
type criticalEv struct {
	what string
	add  func(b *batch)
}

// addCritical queues evidence for the critical batch.
func (e *Engine) addCritical(what string, add func(b *batch)) {
	e.critical = append(e.critical, criticalEv{what: what, add: add})
}

// criticalHeld reports whether snapshots and the anchor must wait for the critical
// batch.
func (e *Engine) criticalHeld() bool { return len(e.critical) > 0 && !e.flushingCritical }

// flushCritical commits the queued evidence as one batch. On success the anchor moves
// to the new position (the corrections are logged) and state.json is due.
func (e *Engine) flushCritical() error {
	if len(e.critical) == 0 || e.flushingCritical {
		return nil
	}
	b := e.newBatch()
	for _, c := range e.critical {
		c.add(b)
	}
	e.flushingCritical = true
	err := e.commit(b)
	e.flushingCritical = false
	if err != nil {
		e.criticalRetryAt = e.bootNow + criticalRetryEvery
		for _, c := range e.critical {
			e.log.Warn("startup evidence not committed; retrying", "what", c.what)
		}
		return err
	}
	e.critical = nil
	e.putAnchor()
	e.markDirty(true)
	return nil
}

// retryCritical retries the critical batch from a turn, paced.
func (e *Engine) retryCritical() {
	if len(e.critical) == 0 || e.bootNow < e.criticalRetryAt || e.isFrozen() {
		return
	}
	_ = e.flushCritical()
}

// rebatch rebuilds a batch on the current ledger after the critical batch was committed
// ahead of it: the recorded point deltas of its events are derived again from their data.
func (e *Engine) rebatch(b *batch) *batch {
	nb := &batch{at: b.at, day: b.day, wallMs: b.wallMs, req: b.req, ledger: e.state.Ledger.Clone(), anchorNow: b.anchorNow}
	for _, ev := range b.events {
		nb.add(ev.Type, json.RawMessage(ev.Data))
	}
	return nb
}

// binaryID identifies the running guardian build (Options.BinaryID).
func (e *Engine) binaryID() string { return e.o.BinaryID }

var (
	exeHashOnce sync.Once
	exeHash     string
)

// defaultBinaryID is the version and the SHA-256 of the running executable (computed
// once per process); the version alone when the executable cannot be read.
func defaultBinaryID(version string) string {
	exeHashOnce.Do(func() {
		p, err := os.Executable()
		if err != nil {
			return
		}
		f, err := os.Open(p)
		if err != nil {
			return
		}
		defer func() { _ = f.Close() }()
		h := sha256.New()
		if _, err := io.Copy(h, f); err != nil {
			return
		}
		exeHash = hex.EncodeToString(h.Sum(nil))
	})
	if exeHash == "" {
		return version
	}
	return version + "+" + exeHash
}
