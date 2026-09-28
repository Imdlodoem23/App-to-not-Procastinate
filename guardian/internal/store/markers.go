package store

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// consumeCleanShutdown reports whether run/clean-shutdown existed and removes it, so a
// crash during this run is seen as unclean at the next start (§10.12 step 3).
func (s *Store) consumeCleanShutdown() (bool, error) {
	p := s.path(dirRun, cleanMarker)
	if _, err := s.fs.Lstat(p); notExist(err) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	if err := s.fs.Remove(p); err != nil && !notExist(err) {
		return true, fmt.Errorf("store: consume clean-shutdown marker: %w", err)
	}
	_ = s.fs.SyncDir(s.path(dirRun)) // best effort: a marker back after a power loss only hides one crash
	return true, nil
}

type markerDoc struct {
	V      int    `json:"v"`
	At     string `json:"at"`
	Reason string `json:"reason,omitempty"`
}

// MarkCleanShutdown writes run/clean-shutdown. Call it last on a clean stop, after the
// final SaveState; allowed in frozen mode.
func (s *Store) MarkCleanShutdown() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}
	data, _ := json.Marshal(markerDoc{V: 1, At: FormatTime(s.o.Now())})
	return writeErr("write "+cleanMarker, writeAtomic(s.fs, s.path(dirRun, cleanMarker), append(data, '\n'), filePerm))
}

// PlannedStop is the run/planned-stop marker Open consumed (§10.12 step 9).
type PlannedStop struct {
	// Present: a marker existed (it was removed). Valid: root/SYSTEM-owned and written
	// within PlannedStopTTL of now; otherwise Problem says why not.
	Present bool
	Valid   bool
	Reason  string
	At      time.Time
	Problem string
}

var plannedReasonRE = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)

// maxMarkerBytes bounds what Open reads from a marker.
const maxMarkerBytes = 4096

// WritePlannedStop writes dataDir/run/planned-stop (§10.12 step 9) for the installer,
// the updaters and the CLI: a stop within PlannedStopTTL after it is not penalized. It
// takes no lock, so it works while the service runs. reason is a short
// [a-z][a-z0-9_]* word such as "update", "install" or "shutdown". The file must be
// written by root/SYSTEM to be honoured.
func WritePlannedStop(dataDir, reason string) error {
	return writePlannedStop(OSFS(), filepath.Join(dataDir, dirRun), reason, time.Now())
}

// MarkPlannedStop writes the planned-stop marker from the running guardian (the stop
// handler of an OS shutdown, §13).
func (s *Store) MarkPlannedStop(reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}
	return writePlannedStop(s.fs, s.path(dirRun), reason, s.o.Now())
}

func writePlannedStop(fsys FS, runDir, reason string, now time.Time) error {
	if !plannedReasonRE.MatchString(reason) {
		return invalid("planned-stop reason %q", reason)
	}
	data, _ := json.Marshal(markerDoc{V: 1, At: FormatTime(now), Reason: reason})
	return writeErr("write "+plannedMarker, writeAtomic(fsys, filepath.Join(runDir, plannedMarker), append(data, '\n'), secretPerm))
}

// consumePlannedStop reads and removes run/planned-stop. An empty marker (an installer
// may just create the file) is dated by its modification time.
func (s *Store) consumePlannedStop() PlannedStop {
	p := s.path(dirRun, plannedMarker)
	fi, err := s.fs.Lstat(p)
	if notExist(err) {
		return PlannedStop{}
	}
	ps := PlannedStop{Present: true}
	defer func() {
		if s.fs.Remove(p) == nil {
			_ = s.fs.SyncDir(s.path(dirRun))
		}
	}()
	if err != nil {
		ps.Problem = err.Error()
		return ps
	}
	if !fi.Mode().IsRegular() {
		ps.Problem = "not a regular file"
		return ps
	}
	if err := s.o.trustOwner(p); err != nil {
		ps.Problem = err.Error()
		return ps
	}
	data, err := s.readSmall(p)
	if err != nil {
		ps.Problem = err.Error()
		return ps
	}
	ps.At = fi.ModTime()
	if content := bytes.TrimSpace(data); len(content) > 0 {
		var doc markerDoc
		if err := json.Unmarshal(content, &doc); err != nil {
			ps.Problem = "unreadable marker"
			return ps
		}
		t, err := ParseTime(doc.At)
		if err != nil {
			ps.Problem = "unreadable marker time"
			return ps
		}
		ps.At = t
		if plannedReasonRE.MatchString(doc.Reason) {
			ps.Reason = doc.Reason
		}
	}
	if age := s.o.Now().Sub(ps.At); age > PlannedStopTTL || age < -PlannedStopTTL {
		ps.Problem = fmt.Sprintf("expired (written %s ago)", age.Round(time.Second))
		return ps
	}
	ps.Valid = true
	return ps
}

func (s *Store) readSmall(path string) ([]byte, error) {
	f, err := s.fs.OpenFile(path, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, maxMarkerBytes))
}

// startsDoc is run/starts.json: the recent unclean starts.
type startsDoc struct {
	V       int          `json:"v"`
	Unclean []startEntry `json:"unclean"`
}

type startEntry struct {
	At     string `json:"at"`
	BootID string `json:"bootId"`
	BootMs int64  `json:"bootMs"`
}

// maxStartEntries bounds run/starts.json.
const maxStartEntries = 16

// recordUncleanStart appends this unclean start to run/starts.json and returns how many
// unclean starts (this one included) fall within SafeModeWindow. Within one boot the
// boot clock measures the window (a wall-clock change cannot fake or hide a crash
// loop); across boots the wall clock does.
func (s *Store) recordUncleanStart() (int, error) {
	p := s.path(dirRun, startsFile)
	var doc startsDoc
	if data, err := s.readSmallAll(p); err == nil {
		_ = json.Unmarshal(data, &doc)
	}
	now := s.o.Now()
	bootID, err := s.o.BootID()
	if err != nil {
		bootID = ""
	}
	cur := startEntry{At: FormatTime(now), BootID: bootID, BootMs: s.o.BootTime().Milliseconds()}
	within := func(e startEntry) bool {
		if cur.BootID != "" && e.BootID == cur.BootID {
			d := time.Duration(cur.BootMs-e.BootMs) * time.Millisecond
			return d >= 0 && d <= SafeModeWindow
		}
		t, err := ParseTime(e.At)
		if err != nil {
			return false
		}
		d := now.Sub(t)
		return d >= 0 && d <= SafeModeWindow
	}
	kept := []startEntry{}
	for _, e := range doc.Unclean {
		if within(e) {
			kept = append(kept, e)
		}
	}
	kept = append(kept, cur)
	if len(kept) > maxStartEntries {
		kept = kept[len(kept)-maxStartEntries:]
	}
	data, _ := json.Marshal(startsDoc{V: 1, Unclean: kept})
	return len(kept), writeErr("write "+startsFile, writeAtomic(s.fs, p, append(data, '\n'), filePerm))
}

func (s *Store) readSmallAll(path string) ([]byte, error) {
	f, err := s.fs.OpenFile(path, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, 64*maxMarkerBytes))
}
