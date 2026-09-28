package store

import (
	"crypto/rand"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// epochIDRE is an epoch id: "ep_" and 16-40 [0-9A-Za-z] (isIdOf in domain.ts).
var epochIDRE = regexp.MustCompile(`^ep_[0-9A-Za-z]{16,40}$`)

func isEpochID(s string) bool { return epochIDRE.MatchString(s) }

// newEpochID returns "ep_" and 26 random base32 characters.
func newEpochID() string { return "ep_" + rand.Text() }

var errBadCurrent = errors.New("events/current does not hold an epoch id")

// readCurrent returns the epoch named by events/current.
func (s *Store) readCurrent() (string, error) {
	raw, err := readFile(s.fs, s.path(dirEvents, currentFile))
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(string(raw))
	if !isEpochID(id) {
		return "", errBadCurrent
	}
	return id, nil
}

// NewEpoch starts a new epoch (§10.11, §10.12): batch[0] must be epoch_started (its
// data built by the engine: reason, previousEpoch, carryOverBalance, escalation, kept)
// and may be followed by more events of the same batch. The segment 00000001.jsonl of
// a fresh epoch directory is written and fsynced first, then events/current switches
// to it atomically; a crash in between leaves the previous epoch current.
//
// Afterwards every other epoch directory is disposed of: with data_deleted it is
// deleted together with quarantine/* and backups/state.v*.json (§10.11 step 3);
// otherwise it is moved to quarantine/. The previous state.json stays until the next
// SaveState (use SaveStateAll after a data deletion), and the anchor must be moved to
// the new epoch with PutAnchor. A returned error wrapping ErrCleanup means the epoch
// was started (the events are valid) but some cleanup failed.
func (s *Store) NewEpoch(reason EpochReason, batch []Event) ([]Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.writable(); err != nil {
		return nil, err
	}
	if !reason.valid() {
		return nil, invalid("epoch reason %q", reason)
	}
	if len(batch) == 0 || batch[0].Type != "epoch_started" {
		return nil, invalid("a new epoch starts with epoch_started")
	}
	for _, e := range batch[1:] {
		if e.Type == "epoch_started" {
			return nil, invalid("epoch_started must be the first event only")
		}
	}
	id := newEpochID()
	out, buf, err := encodeBatch(s.key, batch, id, 0, "")
	if err != nil {
		return nil, err
	}
	dir := s.path(dirEvents, id)
	if _, err := s.o.ensureDir(dir, false); err != nil {
		return nil, writeErr("create epoch", err)
	}
	if err := s.fs.SyncDir(s.path(dirEvents)); err != nil {
		_ = s.fs.RemoveAll(dir)
		return nil, writeErr("create epoch", err)
	}
	_ = s.closeAppend()
	g, err := s.writeNewSegment(id, 1, buf)
	if err != nil {
		_ = s.fs.RemoveAll(dir)
		return nil, err
	}
	if err := writeAtomic(s.fs, s.path(dirEvents, currentFile), []byte(id+"\n"), filePerm); err != nil {
		// The rename may have happened before a failing directory fsync.
		if cur, rerr := s.readCurrent(); rerr != nil || cur != id {
			_ = s.closeAppend()
			_ = s.fs.RemoveAll(dir)
			return nil, writeErr("switch epoch", err)
		}
	}
	s.epoch = id
	s.segs = []*segment{g}
	s.lastSeq, s.lastMac = out[len(out)-1].Seq, out[len(out)-1].Mac
	s.needEpoch = ""

	var errs []error
	errs = append(errs, s.disposeEpochs(id, reason)...)
	if reason == EpochDataDeleted {
		errs = append(errs, s.purgeDeletedData()...)
	}
	if len(errs) > 0 {
		return out, fmt.Errorf("%w: %w", ErrCleanup, errors.Join(errs...))
	}
	return out, nil
}

// disposeEpochs deletes (data_deleted, or orphans when reason is "") or quarantines
// every epoch directory but keep.
func (s *Store) disposeEpochs(keep string, reason EpochReason) []error {
	entries, err := s.fs.ReadDir(s.path(dirEvents))
	if err != nil {
		return []error{err}
	}
	var errs []error
	for _, e := range entries {
		name := e.Name()
		if !e.IsDir() || name == keep || !isEpochID(name) {
			continue
		}
		p := s.path(dirEvents, name)
		if reason == "" || reason == EpochDataDeleted {
			if err := s.fs.RemoveAll(p); err != nil {
				errs = append(errs, err)
			}
			continue
		}
		if _, err := s.quarantineMove(p, "epoch-"+name, ""); err != nil {
			errs = append(errs, err)
		}
	}
	_ = s.fs.SyncDir(s.path(dirEvents))
	return errs
}

// removeOrphanEpochs deletes epoch directories left by a crash around NewEpoch.
func (s *Store) removeOrphanEpochs(rep *RecoveryReport, keep string) {
	for _, err := range s.disposeEpochs(keep, "") {
		s.warn(rep, "remove old epoch: %v", err)
	}
}

// purgeDeletedData removes what data deletion deletes besides the old epoch (§10.11
// step 3): quarantine/* (torn tails, partial batches and corrupt copies hold reasons,
// tasks and domains) and backups/state.v*.json. Guardian logs and the hosts backups
// belong to their own packages.
func (s *Store) purgeDeletedData() []error {
	var errs []error
	if entries, err := s.fs.ReadDir(s.path(dirQuarantine)); err == nil {
		for _, e := range entries {
			if err := s.fs.RemoveAll(s.path(dirQuarantine, e.Name())); err != nil {
				errs = append(errs, err)
			}
		}
		_ = s.fs.SyncDir(s.path(dirQuarantine))
	} else if !notExist(err) {
		errs = append(errs, err)
	}
	if entries, err := s.fs.ReadDir(s.path(dirBackups)); err == nil {
		for _, e := range entries {
			if stateBackupRE.MatchString(e.Name()) {
				if err := s.fs.Remove(s.path(dirBackups, e.Name())); err != nil && !notExist(err) {
					errs = append(errs, err)
				}
			}
		}
		_ = s.fs.SyncDir(s.path(dirBackups))
	} else if !notExist(err) {
		errs = append(errs, err)
	}
	return errs
}
