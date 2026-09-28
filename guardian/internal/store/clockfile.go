package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
)

type clockDoc struct {
	V     int             `json:"v"`
	Clock json.RawMessage `json:"clock"`
}

// SaveClock writes run/clock.json (the Detector snapshot, §11.1), sealed with the ledger
// key: editing the saved trusted time to end blocks early is detected. Allowed in
// frozen mode, where the guardian still keeps time.
func (s *Store) SaveClock(snapshot any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}
	c, err := json.Marshal(snapshot)
	if err != nil {
		return invalid("clock snapshot: %v", err)
	}
	body, err := json.Marshal(clockDoc{V: 1, Clock: c})
	if err != nil {
		return invalid("clock snapshot: %v", err)
	}
	sealed, _ := seal(s.key, body)
	return writeErr("write "+clockFile, writeAtomic(s.fs, s.path(dirRun, clockFile), append(sealed, '\n'), filePerm))
}

// LoadClock decodes run/clock.json into into. It returns false when the file does not
// exist and an ErrTampered error when its MAC fails (after a key replacement too): the
// engine then falls back to the clock of the enforcement core or starts fresh.
func (s *Store) LoadClock(into any) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false, ErrClosed
	}
	raw, err := readFile(s.fs, s.path(dirRun, clockFile))
	if notExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	body, _, err := unseal(s.key, bytes.TrimSuffix(raw, []byte{'\n'}))
	if err != nil {
		if errors.Is(err, errBadMAC) {
			return false, fmt.Errorf("%w: %s", ErrTampered, clockFile)
		}
		return false, fmt.Errorf("store: %s: %v", clockFile, err)
	}
	var doc clockDoc
	if err := json.Unmarshal(body, &doc); err != nil || doc.V != 1 {
		return false, fmt.Errorf("store: %s: unsupported content", clockFile)
	}
	if err := json.Unmarshal(doc.Clock, into); err != nil {
		return false, fmt.Errorf("store: %s: %w", clockFile, err)
	}
	return true, nil
}
