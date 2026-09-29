package store

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// Anchor is the rollback anchor (§11.4): the log position and ledger summary last
// committed, kept outside the data directory so that restoring an old copy of the
// directory, or truncating the log after a penalty, is detected.
type Anchor struct {
	Epoch string `json:"epoch"`
	Seq   int64  `json:"seq"`
	// Mac is the mac of the event at Seq.
	Mac        string           `json:"mac"`
	Balance    int64            `json:"balance"`
	XP         int64            `json:"xp"`
	Escalation AnchorEscalation `json:"escalation"`
	Streak     int64            `json:"streak"`
	BestStreak int64            `json:"bestStreak"`
	// LastClosedDay and VoidedDay are local days (YYYY-MM-DD) or nil.
	LastClosedDay *string `json:"lastClosedDay"`
	VoidedDay     *string `json:"voidedDay"`
	// At is the trusted time of the update (YYYY-MM-DDTHH:MM:SS.sssZ).
	At string `json:"at"`
}

// AnchorEscalation is the attempt escalation (EscalationState in domain.ts).
type AnchorEscalation struct {
	LastCountedAt *string `json:"lastCountedAt"`
	Index         int64   `json:"index"`
}

func (a *Anchor) valid() bool {
	return isEpochID(a.Epoch) && a.Seq >= 1 && isMAC(a.Mac)
}

// AnchorCheck is how the anchor compares with the recovered log.
type AnchorCheck string

const (
	// AnchorAbsent: no anchor stored.
	AnchorAbsent AnchorCheck = "absent"
	// AnchorConsistent: same epoch, at or before the last seq, same mac there.
	AnchorConsistent AnchorCheck = "consistent"
	// AnchorRollback: the log is behind the anchor, differs at its seq, or is another
	// epoch: tamper_detected{ledger_rollback} with min(0, anchor.balance − balance).
	AnchorRollback AnchorCheck = "rollback"
	// AnchorPreviousEpoch: the anchor names the epoch the current one replaced (a stop
	// between NewEpoch and PutAnchor); move it with PutAnchor.
	AnchorPreviousEpoch AnchorCheck = "previous_epoch"
	// AnchorUnverified: no readable log to compare with (NeedEpoch) or the anchor
	// could not be read (AnchorError).
	AnchorUnverified AnchorCheck = "unverified"
	// AnchorInvalid: the stored anchor is malformed.
	AnchorInvalid AnchorCheck = "invalid"
)

// AnchorStore keeps the rollback anchor somewhere the data directory's owner cannot
// restore together with it.
type AnchorStore interface {
	// Load returns the stored anchor; ok is false when none is stored.
	Load() (a Anchor, ok bool, err error)
	// Save stores a durably before returning.
	Save(a Anchor) error
	// Remove deletes the anchor (uninstall). A missing anchor is not an error.
	Remove() error
}

// Anchor returns the stored rollback anchor.
func (s *Store) Anchor() (Anchor, bool, error) {
	return s.anchor.Load()
}

// PutAnchor stores the rollback anchor synchronously (§11.3 steps 6 and 8). With Epoch,
// Seq and Mac all empty they are filled with the current log position (the engine
// applies each batch right after appending it, so its ledger matches the tip);
// otherwise they must name a committed event of the current epoch.
func (s *Store) PutAnchor(a Anchor) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.writable(); err != nil {
		return err
	}
	if s.epoch == "" || s.lastSeq == 0 {
		return ErrNoEpoch
	}
	if a.Epoch == "" && a.Seq == 0 && a.Mac == "" {
		a.Epoch, a.Seq, a.Mac = s.epoch, s.lastSeq, s.lastMac
	} else {
		if a.Epoch != s.epoch || a.Seq < 1 || a.Seq > s.lastSeq {
			return invalid("anchor %s/%d is not a committed event of %s", a.Epoch, a.Seq, s.epoch)
		}
		mac, err := s.macAt(a.Seq)
		if err != nil {
			return err
		}
		if mac != a.Mac {
			return invalid("anchor mac does not match seq %d", a.Seq)
		}
	}
	if _, err := ParseTime(a.At); err != nil {
		return err
	}
	if err := s.anchor.Save(a); err != nil {
		return writeErr("anchor", err)
	}
	return nil
}

// RemoveAnchor removes the OS rollback anchor (DefaultAnchor), for uninstall.
func RemoveAnchor() error { return DefaultAnchor().Remove() }

// DefaultAnchor is the OS anchor (OSAnchor), except when CENTRATE_DATA_DIR redirects
// the data directory (tests and development, see platform): then a JSON file next to
// that directory, "<dataDir>.anchor.json", so a development guardian never needs the
// system locations.
func DefaultAnchor() AnchorStore {
	if v := strings.TrimSpace(os.Getenv(platform.EnvDataDir)); v != "" && filepath.IsAbs(v) {
		if d := platform.DataDir(); d == filepath.Clean(v) {
			return &FileAnchor{Path: d + ".anchor.json"}
		}
	}
	return OSAnchor()
}

// ErrAnchorFormat means the stored anchor could not be decoded.
var ErrAnchorFormat = errors.New("store: unreadable rollback anchor")

// FileAnchor keeps the anchor in a file written with writeAtomic (mode 0600): JSON
// (Linux, development) or a property list with one string key "Anchor" holding the
// JSON (macOS).
type FileAnchor struct {
	Path string
	// Plist selects the property-list format.
	Plist bool
	// CreateDir creates the parent directory (0755) when missing. Leave it false for
	// system directories that must never be re-owned, such as /Library/Preferences.
	CreateDir bool
}

// Load reads the anchor file.
func (f *FileAnchor) Load() (Anchor, bool, error) {
	fh, err := platform.OpenRegularFile(f.Path, os.O_RDONLY, 0)
	if notExist(err) {
		return Anchor{}, false, nil
	}
	if err != nil {
		return Anchor{}, false, err
	}
	data, err := io.ReadAll(io.LimitReader(fh, 64<<10))
	_ = fh.Close()
	if err != nil {
		return Anchor{}, false, err
	}
	if f.Plist {
		if data, err = plistString(data, "Anchor"); err != nil {
			return Anchor{}, false, err
		}
	}
	var a Anchor
	if err := json.Unmarshal(data, &a); err != nil {
		return Anchor{}, false, fmt.Errorf("%w: %v", ErrAnchorFormat, err)
	}
	return a, true, nil
}

// Save writes the anchor file atomically.
func (f *FileAnchor) Save(a Anchor) error {
	data, err := json.Marshal(a)
	if err != nil {
		return err
	}
	if f.Plist {
		data = plistWithString("Anchor", string(data))
	} else {
		data = append(data, '\n')
	}
	if f.CreateDir {
		if err := os.MkdirAll(filepath.Dir(f.Path), 0o755); err != nil {
			return err
		}
	}
	return writeAtomic(OSFS(), f.Path, data, secretPerm)
}

// Remove deletes the anchor file.
func (f *FileAnchor) Remove() error {
	if err := os.Remove(f.Path); err != nil && !notExist(err) {
		return err
	}
	return nil
}

const plistHeader = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
`

func plistWithString(key, value string) []byte {
	var b bytes.Buffer
	b.WriteString(plistHeader)
	b.WriteString("\t<key>")
	_ = xml.EscapeText(&b, []byte(key))
	b.WriteString("</key>\n\t<string>")
	_ = xml.EscapeText(&b, []byte(value))
	b.WriteString("</string>\n</dict>\n</plist>\n")
	return b.Bytes()
}

// plistString returns the string value of key in the top-level dict of an XML plist.
func plistString(data []byte, key string) ([]byte, error) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	dec.Strict = true
	var (
		depth   int
		lastKey string
		inKey   bool
		inValue bool
		text    bytes.Buffer
	)
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrAnchorFormat, err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			depth++
			text.Reset()
			inKey = depth == 3 && t.Name.Local == "key"
			inValue = depth == 3 && t.Name.Local == "string" && lastKey == key
		case xml.CharData:
			if inKey || inValue {
				text.Write(t)
			}
		case xml.EndElement:
			depth--
			switch {
			case inKey:
				lastKey = text.String()
				inKey = false
			case inValue:
				return bytes.Clone(text.Bytes()), nil
			}
		}
	}
	return nil, fmt.Errorf("%w: no %q string", ErrAnchorFormat, key)
}

// MemAnchor is an in-memory AnchorStore for tests (also of other packages). Set
// LoadErr or SaveErr to inject failures.
type MemAnchor struct {
	mu      sync.Mutex
	a       *Anchor
	LoadErr error
	SaveErr error
	saves   int
}

// NewMemAnchor returns an empty MemAnchor.
func NewMemAnchor() *MemAnchor { return &MemAnchor{} }

// Load returns the stored anchor.
func (m *MemAnchor) Load() (Anchor, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.LoadErr != nil {
		return Anchor{}, false, m.LoadErr
	}
	if m.a == nil {
		return Anchor{}, false, nil
	}
	return cloneAnchor(*m.a), true, nil
}

// Save stores a.
func (m *MemAnchor) Save(a Anchor) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.SaveErr != nil {
		return m.SaveErr
	}
	c := cloneAnchor(a)
	m.a = &c
	m.saves++
	return nil
}

// Remove forgets the anchor.
func (m *MemAnchor) Remove() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.a = nil
	return nil
}

// Set replaces the stored anchor (nil removes it), bypassing SaveErr.
func (m *MemAnchor) Set(a *Anchor) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if a == nil {
		m.a = nil
		return
	}
	c := cloneAnchor(*a)
	m.a = &c
}

// Saves counts the successful Save calls.
func (m *MemAnchor) Saves() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.saves
}

func cloneAnchor(a Anchor) Anchor {
	cp := func(p *string) *string {
		if p == nil {
			return nil
		}
		v := *p
		return &v
	}
	a.LastClosedDay = cp(a.LastClosedDay)
	a.VoidedDay = cp(a.VoidedDay)
	a.Escalation.LastCountedAt = cp(a.Escalation.LastCountedAt)
	return a
}
