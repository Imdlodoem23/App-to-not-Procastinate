package store

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Data deletion (§10.11 step 3) spans several steps that a crash, a power cut or a
// failing cleanup can interrupt: NewEpoch switches events/current, deletes the old
// epoch, quarantine/* and backups/state.v*.json; the engine then scrubs the hosts
// backups and the guardian logs and rewrites both state generations (SaveStateAll).
// run/purge-pending makes the whole deletion resumable: NewEpoch writes it durably
// before the switch, and only FinishPurge removes it, once the engine has done its
// part. While it is present, every Open finishes the store's part again and reports
// PurgePending so the engine redoes its own.

// purgeDoc is run/purge-pending.
type purgeDoc struct {
	V  int    `json:"v"`
	At string `json:"at"`
	// Epoch is the data_deleted epoch being started.
	Epoch string `json:"epoch"`
}

// writePurgeMarker records a data deletion about to switch to epoch.
func (s *Store) writePurgeMarker(epoch string) error {
	data, _ := json.Marshal(purgeDoc{V: 1, At: FormatTime(s.o.Now()), Epoch: epoch})
	return writeErr("write "+purgeMarker, writeAtomic(s.fs, s.path(dirRun, purgeMarker), append(data, '\n'), filePerm))
}

// readPurgeMarker reports whether run/purge-pending exists and the epoch it names
// ("" when unreadable: the deletion is then treated as having happened).
func (s *Store) readPurgeMarker() (present bool, epoch string) {
	p := s.path(dirRun, purgeMarker)
	if _, err := s.fs.Lstat(p); notExist(err) {
		return false, ""
	}
	data, err := s.readSmall(p)
	if err != nil {
		return true, ""
	}
	var doc purgeDoc
	if json.Unmarshal(data, &doc) != nil || !isEpochID(doc.Epoch) {
		return true, ""
	}
	return true, doc.Epoch
}

func (s *Store) removePurgeMarker() error {
	if err := s.fs.Remove(s.path(dirRun, purgeMarker)); err != nil && !notExist(err) {
		return err
	}
	return s.fs.SyncDir(s.path(dirRun))
}

// resumePurge runs at Open (in recover, before any snapshot is quarantined) with the
// epoch events/current names ("" when unreadable). A marker naming another readable
// epoch means the crash came before the switch: the deletion never took effect (the
// orphan epoch directory is removed like any other) and the marker goes. Otherwise the
// deletion is pending and quarantine/* and backups/state.v*.json are deleted again;
// recover then deletes, rather than keeps or quarantines, every snapshot that is not
// of the current epoch, so none of the deleted data is ever rotated into
// state.prev.json.
func (s *Store) resumePurge(rep *RecoveryReport, cur string) {
	present, target := s.readPurgeMarker()
	if !present {
		return
	}
	if cur != "" && target != "" && cur != target {
		if err := s.removePurgeMarker(); err != nil {
			s.warn(rep, "remove %s: %v", purgeMarker, err)
		}
		return
	}
	s.purgePending = true
	rep.PurgePending = true
	if errs := s.purgeDeletedData(); len(errs) > 0 {
		s.warn(rep, "resume data deletion: %v", errors.Join(errs...))
	}
}

// PurgePending reports whether a data deletion is not finished (run/purge-pending):
// the engine must scrub the hosts backups and the guardian logs, rewrite both state
// generations with SaveStateAll and then call FinishPurge. RecoveryReport.PurgePending
// says the same at Open.
func (s *Store) PurgePending() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.purgePending
}

// FinishPurge ends a data deletion: it deletes quarantine/* and backups/state.v*.json
// again (a cleanup that failed in NewEpoch is retried) and removes run/purge-pending.
// Call it after the engine's own scrubbing and a successful SaveStateAll in the new
// epoch; before that it fails and keeps the marker. Without a pending deletion it does
// nothing.
func (s *Store) FinishPurge() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.writable(); err != nil {
		return err
	}
	if !s.purgePending {
		return nil
	}
	if !s.purgeStateSaved {
		return fmt.Errorf("store: finish data deletion: state files not rewritten with SaveStateAll")
	}
	if errs := s.purgeDeletedData(); len(errs) > 0 {
		return fmt.Errorf("%w: %w", ErrCleanup, errors.Join(errs...))
	}
	if err := s.removePurgeMarker(); err != nil {
		return writeErr("remove "+purgeMarker, err)
	}
	s.purgePending, s.purgeStateSaved = false, false
	return nil
}

// removeSnapshots deletes state.json and state.prev.json.
func (s *Store) removeSnapshots() []error {
	var errs []error
	for _, f := range []string{stateFile, statePrevFile} {
		if err := s.fs.Remove(s.path(f)); err != nil && !notExist(err) {
			errs = append(errs, err)
		}
	}
	_ = s.fs.SyncDir(s.dir)
	return errs
}
