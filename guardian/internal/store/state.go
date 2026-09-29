package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// stateDoc is the body of state.json, in this order, followed by the mac member. The
// top-level "enforcement" member is the enforcement core frozen forever at v1
// (§11.5): any guardian version and `has-active` read it.
type stateDoc struct {
	SchemaVersion int                 `json:"schemaVersion"`
	Epoch         string              `json:"epoch"`
	LastEventSeq  int64               `json:"lastEventSeq"`
	LastEventMac  string              `json:"lastEventMac"`
	Enforcement   json.RawMessage     `json:"enforcement"`
	Idempotency   []IdempotencyRecord `json:"idempotency"`
	Engine        json.RawMessage     `json:"engine"`
}

// StateSnapshot is what the engine persists in state.json (§11.3 step 8).
type StateSnapshot struct {
	// LastEventSeq is the last event of the current epoch the snapshot includes
	// (0 ≤ LastEventSeq ≤ LastSeq()); the store records its mac so recovery can check
	// that the snapshot matches the log.
	LastEventSeq int64
	// Enforcement is the v1 enforcement core: {"v":1,"clock":…,"items":[…]}.
	Enforcement any
	// Idempotency are the idempotency records with their stored responses (§8.6).
	Idempotency []IdempotencyRecord
	// Engine is the engine's own state (ledger, entities, versions, hosts hash…).
	Engine any
}

// LoadedState is the snapshot Open recovered.
type LoadedState struct {
	Source        StateSource
	SchemaVersion int
	// Epoch and LastEventSeq say what the snapshot includes. With a readable log the
	// epoch is the current one and every event with seq > LastEventSeq must be
	// replayed (RecoveryReport.ReplayFrom); after log_unreadable it is the lost epoch.
	Epoch        string
	LastEventSeq int64
	Enforcement  json.RawMessage
	Idempotency  []IdempotencyRecord
	Engine       json.RawMessage
}

// LoadState returns the snapshot recovered at Open and decodes its Engine member into
// engine (when not nil). It returns ErrNoState when there is none (rebuild from the
// log) and ErrFrozen in frozen mode (use RecoveryReport.FrozenEnforcement).
func (s *Store) LoadState(engine any) (LoadedState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.closed:
		return LoadedState{}, ErrClosed
	case s.frozen:
		return LoadedState{}, ErrFrozen
	case s.loaded == nil:
		return LoadedState{}, ErrNoState
	}
	ls := *s.loaded
	ls.Idempotency = cloneRecords(ls.Idempotency)
	ls.Enforcement = bytes.Clone(ls.Enforcement)
	ls.Engine = bytes.Clone(ls.Engine)
	if engine != nil && len(ls.Engine) > 0 {
		if err := json.Unmarshal(ls.Engine, engine); err != nil {
			return ls, fmt.Errorf("store: decode state: %w", err)
		}
	}
	return ls, nil
}

// SaveState writes state.json atomically and keeps the previous generation in
// state.prev.json (§11.2 step 3). Errors are *WriteError (nothing changed, or only
// state.prev.json was refreshed).
func (s *Store) SaveState(snap StateSnapshot) error {
	return s.saveState(snap, false)
}

// SaveStateAll writes the snapshot as both generations: data deletion rewrites
// state.prev.json equal to the new post-deletion state (§10.11 step 3).
func (s *Store) SaveStateAll(snap StateSnapshot) error {
	return s.saveState(snap, true)
}

func (s *Store) saveState(snap StateSnapshot, both bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.writable(); err != nil {
		return err
	}
	if s.epoch == "" {
		return ErrNoEpoch
	}
	if snap.LastEventSeq < 0 || snap.LastEventSeq > s.lastSeq {
		return invalid("state lastEventSeq %d is outside 0..%d", snap.LastEventSeq, s.lastSeq)
	}
	mac, err := s.macAt(snap.LastEventSeq)
	if err != nil {
		return err
	}
	enf, err := marshalMember(snap.Enforcement)
	if err != nil {
		return invalid("enforcement: %v", err)
	}
	eng, err := marshalMember(snap.Engine)
	if err != nil {
		return invalid("engine state: %v", err)
	}
	raw, err := s.sealState(stateDoc{
		SchemaVersion: s.o.SchemaVersion,
		Epoch:         s.epoch,
		LastEventSeq:  snap.LastEventSeq,
		LastEventMac:  mac,
		Enforcement:   enf,
		Idempotency:   snap.Idempotency,
		Engine:        eng,
	})
	if err != nil {
		return err
	}
	return s.writeState(raw, both)
}

func marshalMember(v any) (json.RawMessage, error) {
	switch x := v.(type) {
	case nil:
		return json.RawMessage("null"), nil
	case json.RawMessage:
		if !json.Valid(x) {
			return nil, errors.New("invalid JSON")
		}
		return x, nil
	}
	return json.Marshal(v)
}

// sealState encodes a snapshot body and seals it with the ledger key.
func (s *Store) sealState(d stateDoc) ([]byte, error) {
	if d.Idempotency == nil {
		d.Idempotency = []IdempotencyRecord{}
	}
	if d.Enforcement == nil {
		d.Enforcement = json.RawMessage("null")
	}
	if d.Engine == nil {
		d.Engine = json.RawMessage("null")
	}
	body, err := json.Marshal(d)
	if err != nil {
		return nil, invalid("state: %v", err)
	}
	sealed, _ := seal(s.key, body)
	return append(sealed, '\n'), nil
}

// writeState writes state.prev.json (the previous state.json, or raw itself when both)
// and then state.json. The previous generation is copied from memory rather than
// hard-linked: a link count of 2 would make the §11.1 takeover delete both files after
// a crash between the renames.
func (s *Store) writeState(raw []byte, both bool) error {
	prev := s.curState
	if both {
		prev = raw
	}
	if prev != nil {
		if err := writeAtomic(s.fs, s.path(statePrevFile), prev, statePerm); err != nil {
			return writeErr("write "+statePrevFile, err)
		}
	}
	if err := writeAtomic(s.fs, s.path(stateFile), raw, statePerm); err != nil {
		return writeErr("write "+stateFile, err)
	}
	s.curState = raw
	if both && s.purgePending {
		s.purgeStateSaved = true
	}
	return nil
}

// decodeState decodes a verified snapshot body of schema version (≤ this build's),
// migrating it in memory first when older.
func (s *Store) decodeState(body []byte, version int) (stateDoc, error) {
	if version < s.o.SchemaVersion {
		m, err := decodeMap(body)
		if err != nil {
			return stateDoc{}, err
		}
		if m, err = ApplyMigrations(m, version, s.o.SchemaVersion, s.o.Migrations); err != nil {
			return stateDoc{}, err
		}
		if body, err = json.Marshal(m); err != nil {
			return stateDoc{}, fmt.Errorf("store: encode migrated state: %w", err)
		}
	}
	var d stateDoc
	if err := json.Unmarshal(body, &d); err != nil {
		return stateDoc{}, fmt.Errorf("store: decode state: %w", err)
	}
	switch {
	case d.SchemaVersion != s.o.SchemaVersion:
		return stateDoc{}, fmt.Errorf("store: state has schema %d after migration, want %d", d.SchemaVersion, s.o.SchemaVersion)
	case d.LastEventSeq < 0:
		return stateDoc{}, fmt.Errorf("store: state lastEventSeq %d", d.LastEventSeq)
	case d.Epoch != "" && !isEpochID(d.Epoch):
		return stateDoc{}, fmt.Errorf("store: state epoch %q", d.Epoch)
	}
	return d, nil
}

// decodeMap decodes a JSON object keeping numbers as json.Number (no float rounding).
func decodeMap(body []byte) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil || m == nil {
		return nil, fmt.Errorf("store: state is not a JSON object: %v", err)
	}
	return m, nil
}

// Migration upgrades a decoded state.json body (every member but mac, numbers as
// json.Number) from schema version N to N+1 (migrate_N_to_N+1, §11.5). It must be
// pure: no I/O, no clock, the same output for the same input (golden-file tests). It
// may modify and return its argument. ApplyMigrations sets schemaVersion afterwards.
type Migration func(doc map[string]any) (map[string]any, error)

// ApplyMigrations runs migs[from], migs[from+1] … migs[to−1] over doc.
func ApplyMigrations(doc map[string]any, from, to int, migs map[int]Migration) (map[string]any, error) {
	for v := from; v < to; v++ {
		m := migs[v]
		if m == nil {
			return nil, fmt.Errorf("store: no migration from schema %d to %d", v, v+1)
		}
		out, err := m(doc)
		if err != nil {
			return nil, fmt.Errorf("store: migrate schema %d to %d: %w", v, v+1, err)
		}
		if out == nil {
			return nil, fmt.Errorf("store: migrate schema %d to %d returned nothing", v, v+1)
		}
		out["schemaVersion"] = json.Number(strconv.Itoa(v + 1))
		doc = out
	}
	return doc, nil
}

var stateBackupRE = regexp.MustCompile(`^state\.v([0-9]+)\.json$`)

// backupState copies a snapshot about to be migrated to backups/state.v<N>.json and
// keeps the newest KeepStateBackups of them.
func (s *Store) backupState(version int, raw []byte) error {
	path := s.path(dirBackups, fmt.Sprintf("state.v%d.json", version))
	if err := writeAtomic(s.fs, path, raw, statePerm); err != nil {
		return writeErr("backup state", err)
	}
	entries, err := s.fs.ReadDir(s.path(dirBackups))
	if err != nil {
		return nil
	}
	type backup struct {
		v    int
		name string
	}
	var all []backup
	for _, e := range entries {
		if m := stateBackupRE.FindStringSubmatch(e.Name()); m != nil && !e.IsDir() {
			if v, err := strconv.Atoi(m[1]); err == nil {
				all = append(all, backup{v, e.Name()})
			}
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].v > all[j].v })
	for i := KeepStateBackups; i < len(all); i++ {
		_ = s.fs.Remove(s.path(dirBackups, all[i].name))
	}
	return nil
}

// ReadEnforcement returns the "enforcement" member (the v1 enforcement core) of
// dataDir/state.json, or of state.prev.json when state.json is missing or unreadable.
// It takes no lock and checks no MAC (it needs no secret), so `has-active` can use it
// while the service runs or is stopped; the core's layout never changes (§11.5).
func ReadEnforcement(dataDir string) (json.RawMessage, error) {
	var firstErr error
	for _, name := range []string{stateFile, statePrevFile} {
		raw, err := readEnforcement(filepath.Join(dataDir, name))
		if err == nil {
			return raw, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return nil, firstErr
}

func readEnforcement(path string) (json.RawMessage, error) {
	f, err := platform.OpenRegularFile(path, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var head struct {
		Enforcement json.RawMessage `json:"enforcement"`
	}
	if err := json.NewDecoder(f).Decode(&head); err != nil {
		return nil, fmt.Errorf("store: %s: %w", filepath.Base(path), err)
	}
	if len(head.Enforcement) == 0 {
		return nil, fmt.Errorf("store: %s has no enforcement core", filepath.Base(path))
	}
	return head.Enforcement, nil
}
