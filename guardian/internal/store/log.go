package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
)

const segExt = ".jsonl"

// segment indexes the committed lines of one segment file: line i has seq first+i and
// starts at offs[i]; size is the end of the last committed line.
type segment struct {
	first int64
	path  string
	size  int64
	offs  []int64
}

func (g *segment) lastSeq() int64 { return g.first + int64(len(g.offs)) - 1 }

func segName(first int64) string { return fmt.Sprintf("%08d%s", first, segExt) }

func parseSegName(name string) (int64, bool) {
	base, ok := strings.CutSuffix(name, segExt)
	if !ok || len(base) < 8 {
		return 0, false
	}
	for _, c := range base {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseInt(base, 10, 64)
	// Only the canonical name counts, so "000000001.jsonl" cannot shadow "00000001.jsonl".
	return n, err == nil && n >= 1 && segName(n) == name
}

type segFile struct {
	first int64
	path  string
}

// listSegments returns the segment files of an epoch directory by first seq.
func (s *Store) listSegments(dir string) ([]segFile, error) {
	entries, err := s.fs.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []segFile
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if first, ok := parseSegName(e.Name()); ok {
			out = append(out, segFile{first: first, path: filepath.Join(dir, e.Name())})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].first < out[j].first })
	return out, nil
}

// scanResult is the verified view of an epoch's log and what must be dropped.
type scanResult struct {
	files []segFile
	segs  []*segment // aligned with files up to where the scan stopped
	// The committed prefix ends in files[commitIdx] at commitOff (commitIdx −1: none).
	commitIdx int
	commitOff int64
	commitSeq int64
	commitMac string
	// firstType and firstData describe seq 1 (to read epoch_started.previousEpoch).
	firstType string
	firstData []byte
	// macs holds the mac of each line whose seq was asked for (committed or not).
	macs map[int64]string
	// corrupt: a complete line failed verification. tooNew: a line with a valid MAC
	// has a newer envelope version. torn: bytes after the last newline of the last
	// segment (reached without a bad line).
	corrupt bool
	tooNew  bool
	torn    int
}

// scanEpoch verifies the log of epoch line by line: MAC, envelope version, epoch, seq
// continuity and the prevMac chain across segments. It stops at the first bad line.
// interest lists seqs whose mac the caller needs (anchor, snapshots).
func (s *Store) scanEpoch(epoch string, interest map[int64]bool) (*scanResult, error) {
	files, err := s.listSegments(s.path(dirEvents, epoch))
	if err != nil {
		return nil, err
	}
	r := &scanResult{files: files, commitIdx: -1, macs: map[int64]string{}}
	expect, prev := int64(1), ""
	for i, sf := range files {
		data, err := readFile(s.fs, sf.path)
		if err != nil {
			return nil, err
		}
		g := &segment{first: sf.first, path: sf.path}
		r.segs = append(r.segs, g)
		off := 0
		for off < len(data) {
			nl := bytes.IndexByte(data[off:], '\n')
			if nl < 0 {
				if i == len(files)-1 {
					r.torn = len(data) - off
				} else {
					r.corrupt = true // only a torn write can leave a line without newline, and only at the end
				}
				break
			}
			line := data[off : off+nl]
			h, err := checkLine(s.key, line, epoch, expect, &prev)
			if err == nil && len(g.offs) == 0 && h.Seq != sf.first {
				err = errSegName
			}
			if err != nil {
				if errors.Is(err, errTooNew) {
					r.tooNew = true
				} else {
					r.corrupt = true
				}
				return r, nil
			}
			if h.Seq == 1 {
				r.firstType = h.Type
				r.firstData = extractData(line)
			}
			if interest[h.Seq] {
				r.macs[h.Seq] = h.Mac
			}
			g.offs = append(g.offs, int64(off))
			off += nl + 1
			g.size = int64(off)
			expect++
			prev = h.Mac
			if h.TxEnd {
				r.commitIdx, r.commitOff, r.commitSeq, r.commitMac = i, int64(off), h.Seq, h.Mac
			}
		}
		if r.corrupt {
			return r, nil
		}
	}
	return r, nil
}

// extractData returns the data member of a verified line.
func extractData(line []byte) []byte {
	var v struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(line, &v); err != nil {
		return nil
	}
	return v.Data
}

// committedIndex returns the non-empty segments of the committed prefix.
func (r *scanResult) committedIndex() []*segment {
	var out []*segment
	for i := 0; i <= r.commitIdx && i < len(r.segs); i++ {
		g := r.segs[i]
		if i == r.commitIdx {
			n := sort.Search(len(g.offs), func(k int) bool { return g.offs[k] >= r.commitOff })
			g.offs = slices.Clip(g.offs[:n])
			g.size = r.commitOff
		}
		if len(g.offs) > 0 {
			out = append(out, g)
		}
	}
	return out
}

// macAt returns the mac of a committed seq the scan was asked about.
func (r *scanResult) macAt(seq int64) (string, bool) {
	if seq < 1 || seq > r.commitSeq {
		return "", false
	}
	m, ok := r.macs[seq]
	return m, ok
}

// hasTail reports whether anything follows the committed prefix.
func (r *scanResult) hasTail() bool {
	if len(r.files) > r.commitIdx+1 {
		return true
	}
	if r.commitIdx < 0 {
		return false
	}
	g := r.segs[r.commitIdx]
	return r.torn > 0 || r.corrupt || g.size > r.commitOff
}

// repairTail moves everything after the committed prefix to quarantine/ and removes it
// from the log (§10.12 step 6, §11.3, §11.4): a torn final line, a trailing batch
// without txEnd, or everything from a corrupt complete line on.
func (s *Store) repairTail(epoch string, r *scanResult, rep *RecoveryReport) error {
	var dropped []byte
	var truncate *segFile
	if r.commitIdx >= 0 {
		f := r.files[r.commitIdx]
		data, err := readFile(s.fs, f.path)
		if err != nil {
			return err
		}
		if int64(len(data)) > r.commitOff {
			dropped = append(dropped, data[r.commitOff:]...)
			truncate = &f
		}
	}
	later := r.files[r.commitIdx+1:]
	for _, f := range later {
		data, err := readFile(s.fs, f.path)
		if err != nil {
			return err
		}
		dropped = append(dropped, data...)
	}
	if len(dropped) > 0 {
		complete := bytes.Count(dropped, []byte{'\n'})
		kind := "torn"
		switch {
		case r.corrupt:
			kind = "corrupt"
		case complete > 0:
			kind = "partial"
		}
		abs, rel := s.quarantineName(kind, segExt)
		if err := writeAtomic(s.fs, abs, dropped, filePerm); err != nil {
			return writeErr("quarantine", err)
		}
		rep.Quarantined = append(rep.Quarantined, rel)
		if r.corrupt {
			lines := int64(0)
			for _, l := range bytes.Split(dropped, []byte{'\n'}) {
				if len(bytes.TrimSpace(l)) > 0 {
					lines++
				}
			}
			rep.Repair = &LogRepair{DroppedFromSeq: r.commitSeq + 1, DroppedCount: lines, ArchivedAs: rel}
		} else {
			rep.PartialLines = complete
			rep.TornBytes = len(dropped) - (bytes.LastIndexByte(dropped, '\n') + 1)
		}
	}
	if truncate != nil {
		f, err := s.fs.OpenFile(truncate.path, os.O_WRONLY, 0)
		if err != nil {
			return writeErr("truncate", err)
		}
		err = f.Truncate(r.commitOff)
		if err == nil {
			err = f.Sync()
		}
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return writeErr("truncate", err)
		}
	}
	for _, f := range later {
		if err := s.fs.Remove(f.path); err != nil && !notExist(err) {
			return writeErr("remove segment", err)
		}
	}
	if len(later) > 0 {
		if err := s.fs.SyncDir(s.path(dirEvents, epoch)); err != nil {
			return writeErr("sync", err)
		}
	}
	return nil
}

// AppendBatch commits one atomic batch (§11.3 step 3): it assigns epoch, seq, prevMac,
// mac and txEnd (on the last event only), writes every line with one write on the
// O_APPEND handle of the current segment (rolling to a new segment named by the first
// seq when the current one would exceed 8 MiB) and fsyncs. It returns the stored
// events. On failure it returns a *WriteError (see ReadOnlyReason) and nothing was
// applied. epoch_started is refused: epochs start with NewEpoch.
func (s *Store) AppendBatch(batch []Event) ([]Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.writable(); err != nil {
		return nil, err
	}
	if s.needEpoch != "" || s.epoch == "" {
		return nil, ErrNoEpoch
	}
	for _, e := range batch {
		if e.Type == "epoch_started" {
			return nil, invalid("epoch_started is written by NewEpoch")
		}
	}
	out, buf, err := encodeBatch(s.key, batch, s.epoch, s.lastSeq, s.lastMac)
	if err != nil {
		return nil, err
	}
	g := s.segs[len(s.segs)-1]
	if g.size > 0 && g.size+int64(len(buf)) > s.o.segmentBytes {
		ng, err := s.writeNewSegment(s.epoch, out[0].Seq, buf)
		if err != nil {
			return nil, err
		}
		s.segs = append(s.segs, ng)
	} else {
		if err := s.appendTo(g, buf); err != nil {
			return nil, err
		}
	}
	s.lastSeq, s.lastMac = out[len(out)-1].Seq, out[len(out)-1].Mac
	return out, nil
}

// appendTo writes buf at the end of g with one write and fsyncs; on failure it
// truncates g back to its committed size (or marks the store broken).
func (s *Store) appendTo(g *segment, buf []byte) error {
	if s.appendF == nil || s.appendSeg != g {
		_ = s.closeAppend()
		f, err := s.fs.OpenFile(g.path, os.O_WRONLY|os.O_APPEND, 0)
		if err != nil {
			return writeErr("open segment", err)
		}
		s.appendF, s.appendSeg = f, g
	}
	n, err := s.appendF.Write(buf)
	if err == nil && n != len(buf) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = s.appendF.Sync()
	}
	if err != nil {
		s.undoAppend(g)
		return writeErr("append", err)
	}
	indexLines(g, buf)
	return nil
}

// undoAppend truncates g back to its committed size after a failed append.
func (s *Store) undoAppend(g *segment) {
	_ = s.closeAppend()
	f, err := s.fs.OpenFile(g.path, os.O_WRONLY, 0)
	if err == nil {
		err = f.Truncate(g.size)
		if err == nil {
			err = f.Sync()
		}
		if cerr := f.Close(); err == nil {
			err = cerr
		}
	}
	if err != nil {
		s.broken = fmt.Errorf("%w: %v", ErrBroken, err)
	}
}

// writeNewSegment creates the segment of epoch starting at first with buf as its
// content, fsyncs it and its directory entry, and keeps it as the append handle.
func (s *Store) writeNewSegment(epoch string, first int64, buf []byte) (*segment, error) {
	dir := s.path(dirEvents, epoch)
	path := filepath.Join(dir, segName(first))
	f, err := s.fs.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|os.O_APPEND, filePerm)
	if err != nil {
		return nil, writeErr("create segment", err)
	}
	n, err := f.Write(buf)
	if err == nil && n != len(buf) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = f.Sync()
	}
	if err == nil {
		err = s.fs.SyncDir(dir)
	}
	if err != nil {
		_ = f.Close()
		if rerr := s.fs.Remove(path); rerr != nil && !notExist(rerr) {
			s.broken = fmt.Errorf("%w: %v", ErrBroken, rerr)
		}
		return nil, writeErr("append", err)
	}
	_ = s.closeAppend()
	g := &segment{first: first, path: path}
	indexLines(g, buf)
	s.appendF, s.appendSeg = f, g
	return g, nil
}

// indexLines records the lines of buf, just appended at the end of g.
func indexLines(g *segment, buf []byte) {
	off := 0
	for off < len(buf) {
		g.offs = append(g.offs, g.size+int64(off))
		off += bytes.IndexByte(buf[off:], '\n') + 1
	}
	g.size += int64(len(buf))
}

// segFor returns the segment holding seq (1 ≤ seq ≤ lastSeq).
func (s *Store) segFor(seq int64) *segment {
	i := sort.Search(len(s.segs), func(i int) bool { return s.segs[i].first > seq }) - 1
	if i < 0 {
		return nil
	}
	g := s.segs[i]
	if seq > g.lastSeq() {
		return nil
	}
	return g
}

// readLines reads and verifies up to max committed events from seq on, within one
// segment.
func (s *Store) readLines(seq int64, max int) ([]Event, error) {
	g := s.segFor(seq)
	if g == nil {
		return nil, fmt.Errorf("%w: seq %d is not in the log", ErrCorrupt, seq)
	}
	i := int(seq - g.first)
	j := min(i+max, len(g.offs))
	start, end := g.offs[i], g.size
	if j < len(g.offs) {
		end = g.offs[j]
	}
	f, err := s.fs.OpenFile(g.path, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	buf := make([]byte, end-start)
	_, err = f.ReadAt(buf, start)
	_ = f.Close()
	if err != nil {
		return nil, fmt.Errorf("store: read %s: %w", filepath.Base(g.path), err)
	}
	out := make([]Event, 0, j-i)
	for k := range j - i {
		nl := bytes.IndexByte(buf, '\n')
		if nl < 0 {
			return nil, fmt.Errorf("%w: seq %d: truncated", ErrCorrupt, seq+int64(k))
		}
		e, err := decodeLine(s.key, buf[:nl], s.epoch, seq+int64(k))
		if err != nil {
			return nil, fmt.Errorf("%w: seq %d: %v", ErrCorrupt, seq+int64(k), err)
		}
		out = append(out, e)
		buf = buf[nl+1:]
	}
	return out, nil
}

// macAt returns the mac of committed seq (0 → "").
func (s *Store) macAt(seq int64) (string, error) {
	switch {
	case seq == 0:
		return "", nil
	case seq == s.lastSeq:
		return s.lastMac, nil
	case seq < 0 || seq > s.lastSeq:
		return "", invalid("seq %d is outside 0..%d", seq, s.lastSeq)
	}
	ev, err := s.readLines(seq, 1)
	if err != nil {
		return "", err
	}
	return ev[0].Mac, nil
}

// Page is one page of /v1/events (EventsResponse without the wire encoding).
type Page struct {
	// Epoch is the current epoch; Reset is true when the requested one differed (the
	// page then starts at the beginning of the current epoch).
	Epoch string
	Reset bool
	// Events are ordered by seq and never split a batch.
	Events []Event
	// LastSeq is the seq of the last returned event, or the effective after.
	LastSeq int64
	// HasMore: an event with seq > LastSeq exists.
	HasMore bool
}

// ReadEvents returns the committed events of the current epoch with seq > after (§8.8
// GET /v1/events): at most limit events ending on a txEnd line, unless the first batch
// alone is longer (then exactly that batch). An epoch other than the current one
// ("" included) resets the cursor to the start of the current epoch. Lines are
// verified again as they are read (ErrCorrupt).
func (s *Store) ReadEvents(epoch string, after int64, limit int) (Page, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Page{}, ErrClosed
	}
	if s.epoch == "" {
		return Page{}, ErrNoEpoch
	}
	if limit < 1 {
		return Page{}, invalid("limit %d", limit)
	}
	p := Page{Epoch: s.epoch}
	if epoch != s.epoch {
		p.Reset, after = true, 0
	}
	after = max(after, 0)
	p.LastSeq = after
	var batch []Event
	for seq := after + 1; seq <= s.lastSeq; {
		want := max(limit+maxBatchEvents()-len(p.Events)-len(batch), 1)
		lines, err := s.readLines(seq, want)
		if err != nil {
			return Page{}, err
		}
		for _, e := range lines {
			batch = append(batch, e)
			if !e.TxEnd {
				continue
			}
			if len(p.Events) > 0 && len(p.Events)+len(batch) > limit {
				goto done
			}
			p.Events = append(p.Events, batch...)
			batch = nil
			if len(p.Events) >= limit {
				goto done
			}
		}
		seq += int64(len(lines))
	}
done:
	if n := len(p.Events); n > 0 {
		p.LastSeq = p.Events[n-1].Seq
	}
	p.HasMore = p.LastSeq < s.lastSeq
	return p, nil
}
