package store

import (
	"bytes"
	"encoding/json"
	"errors"
)

// stateCand is one snapshot file (state.json or state.prev.json) as Open found it.
type stateCand struct {
	file   string
	source StateSource
	raw    []byte
	// bad: present but unreadable, unparseable or failing its MAC (quarantined).
	bad   bool
	macOK bool
	// version is its schemaVersion; tooNew when newer than this build.
	version     int
	tooNew      bool
	enforcement json.RawMessage
	// doc is the snapshot at this build's schema (migrated in memory when older);
	// err is set when it could not be decoded or migrated.
	doc stateDoc
	err error
}

// recover runs §10.12 steps 5-7 for a trusted key: snapshots, log verification and
// repair, migrations and the anchor comparison.
func (s *Store) recover(rep *RecoveryReport) error {
	epoch, err := s.readCurrent()
	switch {
	case err == nil:
	case notExist(err) && rep.Fresh:
		s.needEpoch = EpochInstall
	default:
		s.needEpoch = EpochLogUnreadable
		if !notExist(err) {
			s.warn(rep, "events/current: %v", err)
		}
		epoch = ""
	}
	if epoch != "" {
		if _, err := s.fs.Lstat(s.path(dirEvents, epoch)); err != nil {
			s.needEpoch = EpochLogUnreadable
			epoch = ""
		}
	}

	cands := s.readStateCandidates(rep)

	var sc *scanResult
	if epoch != "" {
		interest := map[int64]bool{}
		if a := rep.Anchor; a != nil && a.Epoch == epoch {
			interest[a.Seq] = true
		}
		for _, c := range cands {
			if c.macOK && c.err == nil && c.doc.Epoch == epoch {
				interest[c.doc.LastEventSeq] = true
			}
		}
		if sc, err = s.scanEpoch(epoch, interest); err != nil {
			return err
		}
		if sc.commitIdx < 0 && !sc.tooNew {
			s.needEpoch = EpochLogUnreadable
		}
	}
	logOK := sc != nil && sc.commitIdx >= 0

	// Pick the snapshot: state.json, else state.prev.json (§10.12 step 5). A newer
	// schema met before a usable snapshot freezes the store.
	var chosen *stateCand
	frozenReason := ""
	var frozenEnf json.RawMessage
	if sc != nil && sc.tooNew {
		frozenReason = "envelope_too_new"
	}
	for _, c := range cands {
		if !c.macOK {
			continue
		}
		if c.tooNew {
			if frozenReason == "" {
				frozenReason = "schema_too_new"
			}
			if frozenEnf == nil {
				frozenEnf = c.enforcement
			}
			break
		}
		if c.err != nil {
			s.warn(rep, "%s: %v", c.file, c.err)
			continue
		}
		if logOK && !stateMatchesLog(c, epoch, sc) {
			rep.StateStale = true
			continue
		}
		chosen = c
		break
	}

	if frozenReason != "" {
		// Frozen (§11.5): modify nothing, serve what verifies, refuse writes.
		s.frozen = true
		s.needEpoch = ""
		rep.FrozenReason = frozenReason
		if frozenEnf == nil && chosen != nil {
			frozenEnf = chosen.enforcement
		}
		rep.FrozenEnforcement = frozenEnf
		if logOK {
			s.adoptLog(epoch, sc)
		}
		s.checkAnchor(rep, sc)
		return nil
	}

	if logOK {
		if sc.hasTail() {
			if err := s.repairTail(epoch, sc, rep); err != nil {
				return err
			}
		}
		s.adoptLog(epoch, sc)
		s.removeOrphanEpochs(rep, epoch)
	}
	for _, c := range cands {
		switch {
		case c.bad:
			if rel, err := s.quarantineMove(s.path(c.file), "state", ".json"); err != nil {
				s.warn(rep, "quarantine %s: %v", c.file, err)
			} else {
				rep.Quarantined = append(rep.Quarantined, rel)
			}
		case c.file == stateFile && c.macOK:
			s.curState = c.raw
		}
	}
	if chosen != nil {
		if err := s.adoptState(rep, chosen, logOK); err != nil {
			return err
		}
	} else {
		rep.State = StateNone
	}
	s.checkAnchor(rep, sc)
	return nil
}

// adoptLog makes the committed prefix of sc the current epoch's index.
func (s *Store) adoptLog(epoch string, sc *scanResult) {
	s.epoch = epoch
	s.segs = sc.committedIndex()
	s.lastSeq, s.lastMac = sc.commitSeq, sc.commitMac
}

// stateMatchesLog reports whether a snapshot describes a prefix of the verified log:
// same epoch, not ahead of it, and the same mac at its lastEventSeq.
func stateMatchesLog(c *stateCand, epoch string, sc *scanResult) bool {
	d := c.doc
	if d.Epoch != epoch || d.LastEventSeq > sc.commitSeq {
		return false
	}
	if d.LastEventSeq == 0 {
		return d.LastEventMac == ""
	}
	mac, ok := sc.macAt(d.LastEventSeq)
	return ok && mac == d.LastEventMac
}

// readStateCandidates reads state.json and state.prev.json, checks their MAC and
// version and decodes them (migrating in memory when older).
func (s *Store) readStateCandidates(rep *RecoveryReport) []*stateCand {
	var out []*stateCand
	for _, f := range []struct {
		file string
		src  StateSource
	}{{stateFile, StateCurrent}, {statePrevFile, StatePrevious}} {
		raw, err := readFile(s.fs, s.path(f.file))
		if notExist(err) {
			continue
		}
		c := &stateCand{file: f.file, source: f.src, raw: raw}
		out = append(out, c)
		if err != nil {
			c.bad = true
			rep.StateCorrupt = true
			s.warn(rep, "%s: %v", f.file, err)
			continue
		}
		body, _, err := unseal(s.key, bytes.TrimSuffix(raw, []byte{'\n'}))
		if err != nil {
			c.bad = true
			if errors.Is(err, errBadMAC) {
				rep.StateMACInvalid = true
			} else {
				rep.StateCorrupt = true
			}
			continue
		}
		var head struct {
			SchemaVersion *int            `json:"schemaVersion"`
			Enforcement   json.RawMessage `json:"enforcement"`
		}
		if err := json.Unmarshal(body, &head); err != nil || head.SchemaVersion == nil || *head.SchemaVersion < 1 {
			c.bad = true
			rep.StateCorrupt = true
			continue
		}
		c.macOK = true
		c.version = *head.SchemaVersion
		c.enforcement = head.Enforcement
		if c.version > s.o.SchemaVersion {
			c.tooNew = true
			continue
		}
		c.doc, c.err = s.decodeState(body, c.version)
	}
	return out
}

// adoptState makes c the recovered snapshot, writing it back migrated when it was
// older (after a backup of the original, §11.5).
func (s *Store) adoptState(rep *RecoveryReport, c *stateCand, logOK bool) error {
	if c.version < s.o.SchemaVersion {
		if err := s.backupState(c.version, c.raw); err != nil {
			return err
		}
		raw, err := s.sealState(c.doc)
		if err != nil {
			return err
		}
		if err := s.writeState(raw, false); err != nil {
			return err
		}
		rep.StateMigratedFrom = c.version
	}
	d := c.doc
	s.loaded = &LoadedState{
		Source:        c.source,
		SchemaVersion: s.o.SchemaVersion,
		Epoch:         d.Epoch,
		LastEventSeq:  d.LastEventSeq,
		Enforcement:   d.Enforcement,
		Idempotency:   d.Idempotency,
		Engine:        d.Engine,
	}
	rep.State = c.source
	rep.StateSchemaVersion = c.version
	if logOK {
		rep.ReplayFrom = d.LastEventSeq
	}
	return nil
}

// checkAnchor compares the anchor with the recovered log (§10.12 step 7).
func (s *Store) checkAnchor(rep *RecoveryReport, sc *scanResult) {
	a := rep.Anchor
	switch {
	case rep.AnchorError != "":
		rep.AnchorCheck = AnchorUnverified
		return
	case a == nil:
		rep.AnchorCheck = AnchorAbsent
		return
	case !a.valid():
		rep.AnchorCheck = AnchorInvalid
		return
	case s.epoch == "" || sc == nil:
		rep.AnchorCheck = AnchorUnverified
		return
	}
	if a.Epoch == s.epoch {
		mac, ok := sc.macAt(a.Seq)
		if a.Seq > s.lastSeq || !ok || mac != a.Mac {
			rep.AnchorCheck = AnchorRollback
		} else {
			rep.AnchorCheck = AnchorConsistent
		}
		return
	}
	if prev := sc.previousEpoch(); prev != "" && prev == a.Epoch {
		rep.AnchorCheck = AnchorPreviousEpoch
		return
	}
	rep.AnchorCheck = AnchorRollback
}

// previousEpoch is epoch_started.data.previousEpoch of the scanned epoch, or "".
func (r *scanResult) previousEpoch() string {
	if r.firstType != "epoch_started" || r.commitSeq < 1 {
		return ""
	}
	var d struct {
		PreviousEpoch *string `json:"previousEpoch"`
	}
	if json.Unmarshal(r.firstData, &d) != nil || d.PreviousEpoch == nil {
		return ""
	}
	return *d.PreviousEpoch
}
