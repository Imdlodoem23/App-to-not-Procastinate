package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

func TestAppendAssignsEnvelope(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	req := "0123456789abcdef0123456789abcdef"
	in := batchOf(3, "x")
	in[1].Req = &req
	in[2].Seq, in[2].TxEnd, in[2].Mac, in[2].Epoch = 99, true, "forged", "ep_other" // ignored
	out := mustAppend(t, s, in)
	for i, ev := range out {
		if ev.V != 1 || ev.Epoch != s.Epoch() || ev.Seq != int64(i+2) || ev.TxEnd != (i == 2) || !isMAC(ev.Mac) {
			t.Fatalf("event %d: %+v", i, ev)
		}
	}
	if out[0].PrevMac == "" || out[1].PrevMac != out[0].Mac || out[2].PrevMac != out[1].Mac {
		t.Fatal("prevMac chain broken")
	}
	if s.LastSeq() != 4 || s.LastMac() != out[2].Mac {
		t.Fatalf("tip %d %s", s.LastSeq(), s.LastMac())
	}
	*in[1].Req = "ff" // the stored events do not alias the caller's data
	got := allEvents(t, s)
	if len(got) != 4 || *got[2].Req != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("read back %d events, req %v", len(got), got[2].Req)
	}
	for i := range out {
		a, _ := json.Marshal(out[i])
		b, _ := json.Marshal(got[i+1])
		if !bytes.Equal(a, b) {
			t.Fatalf("event %d: appended %s, read %s", i, a, b)
		}
	}
}

func TestLineFormatAndMAC(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	req := "abc123"
	b := []Event{ev("strike", -15, "{ \"sessionId\" : \"stu_x\", \"note\":\"<&>\u2028\" }")}
	b[0].Req, b[0].XP, b[0].WallOffsetMs = &req, 0, -7200000
	mustAppend(t, s, b)
	data := readFileT(t, e.segments(s)[0])
	lines := bytes.Split(bytes.TrimSuffix(data, []byte("\n")), []byte("\n"))
	line := lines[1]
	var keys []string
	dec := json.NewDecoder(bytes.NewReader(line))
	_, _ = dec.Token()
	for dec.More() {
		k, _ := dec.Token()
		keys = append(keys, k.(string))
		var skip json.RawMessage
		_ = dec.Decode(&skip)
	}
	want := "v,epoch,seq,at,wallOffsetMs,day,type,points,xp,txEnd,req,data,prevMac,mac"
	if strings.Join(keys, ",") != want {
		t.Fatalf("field order %v", keys)
	}
	if !bytes.Contains(line, []byte(`"data":{"sessionId":"stu_x","note":"\u003c\u0026\u003e\u2028"}`)) {
		t.Fatalf("data not compacted/escaped: %s", line)
	}
	// mac = base64url(HMAC-SHA256(key, B)), B = the line without its mac member.
	i := bytes.LastIndex(line, []byte(`,"mac":"`))
	body := append(append([]byte{}, line[:i]...), '}')
	var parsed Event
	if err := json.Unmarshal(line, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Mac != computeMAC(e.key(), body) || len(parsed.Mac) != macLen {
		t.Fatal("mac is not HMAC-SHA256 of the body")
	}
	w, err := parsed.WireJSON()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(w, []byte("mac")) || !bytes.HasPrefix(w, []byte(`{"v":1,"epoch":`)) || !bytes.HasSuffix(w, []byte(`}}`)) {
		t.Fatalf("wire %s", w)
	}
}

func TestAppendValidation(t *testing.T) {
	e := newEnv(t)
	s, _ := e.open()
	if _, err := s.AppendBatch(batchOf(1, "a")); !errors.Is(err, ErrNoEpoch) {
		t.Fatalf("before an epoch: %v", err)
	}
	if _, err := s.NewEpoch(EpochInstall, batchOf(1, "a")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("epoch without epoch_started: %v", err)
	}
	if _, err := s.NewEpoch("bogus", []Event{epochStarted("install", "")}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("bad reason: %v", err)
	}
	if _, err := s.NewEpoch(EpochInstall, []Event{epochStarted("install", "")}); err != nil {
		t.Fatal(err)
	}
	bad := func(mut func(*Event)) Event {
		x := batchOf(1, "v")[0]
		mut(&x)
		return x
	}
	neg := "NOTHEX"
	cases := map[string]Event{
		"type":       bad(func(x *Event) { x.Type = "Attempt" }),
		"at":         bad(func(x *Event) { x.At = "2026-09-28T10:00:00Z" }),
		"at hour 24": bad(func(x *Event) { x.At = "2026-09-28T24:00:00.000Z" }),
		"day":        bad(func(x *Event) { x.Day = "2026-02-30" }),
		"xp":         bad(func(x *Event) { x.XP = -1 }),
		"req":        bad(func(x *Event) { x.Req = &neg }),
		"data array": bad(func(x *Event) { x.Data = json.RawMessage(`[1]`) }),
		"data bad":   bad(func(x *Event) { x.Data = json.RawMessage(`{"a":`) }),
		"data none":  bad(func(x *Event) { x.Data = nil }),
		"epoch":      epochStarted("install", ""),
	}
	for name, x := range cases {
		if _, err := s.AppendBatch([]Event{x}); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	if _, err := s.AppendBatch(nil); !errors.Is(err, ErrInvalid) {
		t.Errorf("empty batch: %v", err)
	}
	max := embedded.API().Limits.MaxBatchEvents
	if _, err := s.AppendBatch(batchOf(max+1, "m")); !errors.Is(err, ErrInvalid) {
		t.Errorf("batch of %d: %v", max+1, err)
	}
	if out := mustAppend(t, s, batchOf(max, "m")); len(out) != max {
		t.Fatalf("batch of %d: %d events", max, len(out))
	}
	if s.LastSeq() != int64(max)+1 {
		t.Fatalf("a rejected batch changed the log: last seq %d", s.LastSeq())
	}
}

func TestReadEventsPages(t *testing.T) {
	e := newEnv(t)
	s := e.started() // seq 1: a batch of 1
	sizes := []int{3, 2, 5, 1, 4}
	for i, n := range sizes {
		mustAppend(t, s, batchOf(n, fmt.Sprint(i)))
	}
	last := s.LastSeq()
	batchEnds := map[int64]bool{1: true}
	seq := int64(1)
	for _, n := range sizes {
		seq += int64(n)
		batchEnds[seq] = true
	}
	for limit := 1; limit <= 17; limit++ {
		var got []Event
		after := int64(0)
		for pages := 0; ; pages++ {
			p, err := s.ReadEvents(s.Epoch(), after, limit)
			if err != nil {
				t.Fatal(err)
			}
			if pages > 20 {
				t.Fatalf("limit %d: no progress", limit)
			}
			if len(p.Events) == 0 {
				if p.HasMore || p.LastSeq != after {
					t.Fatalf("limit %d: empty page %+v", limit, p)
				}
				break
			}
			end := p.Events[len(p.Events)-1]
			if !end.TxEnd || !batchEnds[end.Seq] {
				t.Fatalf("limit %d: page split a batch at seq %d", limit, end.Seq)
			}
			if len(p.Events) > limit {
				// Only a first batch longer than the limit, exactly that batch.
				if !batchEnds[p.Events[0].Seq-1] && p.Events[0].Seq != 1 {
					t.Fatalf("limit %d: oversized page does not start a batch", limit)
				}
				for _, x := range p.Events[:len(p.Events)-1] {
					if x.TxEnd {
						t.Fatalf("limit %d: oversized page holds more than one batch", limit)
					}
				}
			}
			if p.LastSeq != end.Seq || p.HasMore != (end.Seq < last) {
				t.Fatalf("limit %d: page %+v", limit, p)
			}
			got = append(got, p.Events...)
			after = p.LastSeq
		}
		if int64(len(got)) != last {
			t.Fatalf("limit %d: read %d events, want %d", limit, len(got), last)
		}
		for i, x := range got {
			if x.Seq != int64(i+1) {
				t.Fatalf("limit %d: seq %d at %d", limit, x.Seq, i)
			}
		}
	}
	// An unknown or empty epoch resets to the start of the current epoch.
	for _, ep := range []string{"", "ep_AAAAAAAAAAAAAAAAAAAAAA"} {
		p, err := s.ReadEvents(ep, 7, 2)
		if err != nil || !p.Reset || p.Events[0].Seq != 1 || p.Epoch != s.Epoch() {
			t.Fatalf("epoch %q: %+v %v", ep, p, err)
		}
	}
	p, err := s.ReadEvents(s.Epoch(), last, 10)
	if err != nil || p.Reset || len(p.Events) != 0 || p.LastSeq != last || p.HasMore {
		t.Fatalf("at the end: %+v %v", p, err)
	}
	// A cursor past the tail of the current epoch is not a position in this log.
	p, err = s.ReadEvents(s.Epoch(), last+5, 2)
	if err != nil || !p.Reset || len(p.Events) == 0 || p.Events[0].Seq != 1 || !p.HasMore {
		t.Fatalf("after the end: %+v %v", p, err)
	}
	if _, err := s.ReadEvents(s.Epoch(), 0, 0); !errors.Is(err, ErrInvalid) {
		t.Fatalf("limit 0: %v", err)
	}
}

func TestSegmentRoll(t *testing.T) {
	e := newEnv(t)
	e.mod = func(o *Options) { o.segmentBytes = 1500 }
	s := e.started()
	var appended []Event
	for i := range 30 {
		appended = append(appended, mustAppend(t, s, batchOf(1+i%3, fmt.Sprint(i)))...)
	}
	files := e.segments(s)
	if len(files) < 5 {
		t.Fatalf("%d segments, want several", len(files))
	}
	for _, f := range files {
		data := readFileT(t, f)
		if len(data) > 1500 {
			t.Fatalf("%s: %d bytes over the roll size", filepath.Base(f), len(data))
		}
		var first Event
		if err := json.Unmarshal(data[:bytes.IndexByte(data, '\n')], &first); err != nil {
			t.Fatal(err)
		}
		if filepath.Base(f) != segName(first.Seq) {
			t.Fatalf("%s starts with seq %d", filepath.Base(f), first.Seq)
		}
		if !bytes.HasSuffix(data, []byte("\n")) {
			t.Fatalf("%s does not end on a line", filepath.Base(f))
		}
		// Segments end on batch boundaries: the last line has txEnd.
		lines := bytes.Split(bytes.TrimSuffix(data, []byte("\n")), []byte("\n"))
		var lastLine Event
		_ = json.Unmarshal(lines[len(lines)-1], &lastLine)
		if !lastLine.TxEnd {
			t.Fatalf("%s splits a batch", filepath.Base(f))
		}
	}
	got := allEvents(t, s)
	if len(got) != len(appended)+1 {
		t.Fatalf("read %d, want %d", len(got), len(appended)+1)
	}
	for i, x := range appended {
		if got[i+1].Mac != x.Mac {
			t.Fatalf("seq %d differs", x.Seq)
		}
	}
	// The chain spans segments: a clean reopen verifies it end to end.
	s2, rep := e.reopen(s)
	if rep.Repair != nil || rep.TornBytes != 0 || rep.PartialLines != 0 || rep.LastSeq != int64(len(got)) {
		t.Fatalf("reopen: %+v", rep)
	}
	if st := s2.Stats(); st.Segments != len(files) || st.LastSeq != int64(len(got)) {
		t.Fatalf("stats %+v", st)
	}
	mustAppend(t, s2, batchOf(2, "z"))
	if got := allEvents(t, s2); len(got) != len(appended)+3 {
		t.Fatalf("after reopen+append: %d events", len(got))
	}
}

// buildLog writes epoch_started, then batches of 2, 3 and 3 events, and closes.
func buildLog(t *testing.T, e *env) (seg string, data []byte, epoch string) {
	t.Helper()
	s := e.started()
	mustAppend(t, s, batchOf(2, "a"))
	mustAppend(t, s, batchOf(3, "b"))
	mustAppend(t, s, batchOf(3, "c"))
	seg, epoch = e.segments(s)[0], s.Epoch()
	e.closeClean(s)
	return seg, readFileT(t, seg), epoch
}

// A torn write at every byte of the last batch: the final line without newline is
// truncated, complete lines of the batch without its txEnd are quarantined, and the
// log ends on the previous batch. Every line boundary of the batch is included.
//
// The file each cut quarantines is deleted once checked. Left there, a thousand of
// them would slow down every later Open, whose takeover walk inspects and secures
// each entry of the data directory (reading and writing DACLs on Windows): the test
// would be quadratic, and take over ten minutes on Windows.
func TestTornTailAtEveryByte(t *testing.T) {
	e := newEnv(t)
	seg, full, _ := buildLog(t, e)
	offs := lineOffsets(full) // 9 lines: offs[0..9]
	lastBatch := offs[6]      // lines 7-9 are the last batch
	for cut := lastBatch; cut <= len(full); cut++ {
		e.clk.Advance(time.Millisecond) // distinct quarantine names
		writeFileT(t, seg, full[:cut])
		s, rep := e.open()
		complete := 0
		for _, o := range offs[7:] {
			if o <= cut {
				complete++
			}
		}
		wantTorn := cut - offs[6+complete]
		switch {
		case cut == len(full):
			if rep.LastSeq != 9 || rep.TornBytes != 0 || rep.PartialLines != 0 || len(rep.Quarantined) != 0 {
				t.Fatalf("cut %d (complete): %+v", cut, rep)
			}
		default:
			if rep.LastSeq != 6 || rep.Repair != nil || rep.TornBytes != wantTorn || rep.PartialLines != complete {
				t.Fatalf("cut %d: last %d torn %d (want %d) partial %d (want %d) repair %+v",
					cut, rep.LastSeq, rep.TornBytes, wantTorn, rep.PartialLines, complete, rep.Repair)
			}
			if cut > lastBatch {
				if len(rep.Quarantined) != 1 {
					t.Fatalf("cut %d: quarantined %v", cut, rep.Quarantined)
				}
				q := readFileT(t, filepath.Join(e.dir, filepath.FromSlash(rep.Quarantined[0])))
				if !bytes.Equal(q, full[lastBatch:cut]) {
					t.Fatalf("cut %d: quarantined %q", cut, q)
				}
				kind := "torn-"
				if complete > 0 {
					kind = "partial-"
				}
				if !strings.HasPrefix(rep.Quarantined[0], dirQuarantine+"/"+kind) {
					t.Fatalf("cut %d: %s", cut, rep.Quarantined[0])
				}
			}
			if got := readFileT(t, seg); !bytes.Equal(got, full[:lastBatch]) {
				t.Fatalf("cut %d: segment is %d bytes, want %d", cut, len(got), lastBatch)
			}
		}
		if rep.UncleanShutdown {
			t.Fatalf("cut %d: clean shutdown marker ignored", cut)
		}
		// The recovered log accepts appends and verifies again.
		if cut == lastBatch+len(full[lastBatch:])/2 {
			out := mustAppend(t, s, batchOf(1, "r"))
			if out[0].Seq != 7 {
				t.Fatalf("next seq %d", out[0].Seq)
			}
			s2, rep2 := e.reopen(s)
			if rep2.LastSeq != 7 || rep2.TornBytes != 0 || rep2.Repair != nil || len(rep2.Quarantined) != 0 {
				t.Fatalf("after append: %+v", rep2)
			}
			s = s2
		}
		e.closeClean(s)
		for _, q := range rep.Quarantined {
			if err := os.Remove(filepath.Join(e.dir, filepath.FromSlash(q))); err != nil {
				t.Fatalf("cut %d: %v", cut, err)
			}
		}
	}
}

// A complete line that fails verification keeps the valid prefix up to the last
// txEnd before it, quarantines the rest as corrupt and reports the repair.
func TestTamperedLineIsRepaired(t *testing.T) {
	cases := map[string]struct {
		edit     func(lines [][]byte) [][]byte
		fromSeq  int64
		dropped  int64
		unusable bool
	}{
		"edited points in the middle of a batch": {edit: func(l [][]byte) [][]byte {
			l[4] = bytes.Replace(l[4], []byte(`"points":-10`), []byte(`"points":+99`), 1)
			return l
		}, fromSeq: 4, dropped: 6},
		"edited data of a txEnd line": {edit: func(l [][]byte) [][]byte {
			l[5] = bytes.Replace(l[5], []byte("youtube"), []byte("youtubE"), 1)
			return l
		}, fromSeq: 4, dropped: 6},
		"deleted line": {edit: func(l [][]byte) [][]byte {
			return append(l[:3:3], l[4:]...)
		}, fromSeq: 4, dropped: 5},
		"swapped lines": {edit: func(l [][]byte) [][]byte {
			l[6], l[7] = l[7], l[6]
			return l
		}, fromSeq: 7, dropped: 3},
		"forged mac": {edit: func(l [][]byte) [][]byte {
			i := bytes.LastIndex(l[1], []byte(`,"mac":"`)) + len(`,"mac":"`)
			l[1][i] ^= 1
			return l
		}, fromSeq: 2, dropped: 8},
		"signed with another key": {edit: func(l [][]byte) [][]byte {
			body, _, _ := unseal(make([]byte, 32), l[2])
			if body == nil {
				i := bytes.LastIndex(l[2], []byte(`,"mac":"`))
				body = append(append([]byte{}, l[2][:i]...), '}')
			}
			l[2], _ = seal([]byte("0123456789abcdef0123456789abcdef"), body)
			return l
		}, fromSeq: 2, dropped: 8},
		"garbage line": {edit: func(l [][]byte) [][]byte {
			l[8] = []byte("\x00\x00\x00")
			return l
		}, fromSeq: 7, dropped: 3},
		"first line edited": {edit: func(l [][]byte) [][]byte {
			l[0] = bytes.Replace(l[0], []byte("install"), []byte("instal_"), 1)
			return l
		}, unusable: true},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			e := newEnv(t)
			seg, full, epoch := buildLog(t, e)
			lines := bytes.Split(bytes.TrimSuffix(full, []byte("\n")), []byte("\n"))
			edited := bytes.Join(tc.edit(lines), []byte("\n"))
			edited = append(edited, '\n')
			writeFileT(t, seg, edited)
			s, rep := e.open()
			if tc.unusable {
				if rep.NeedEpoch != EpochLogUnreadable || rep.Epoch != "" || rep.Repair != nil {
					t.Fatalf("report %+v", rep)
				}
				if _, err := s.AppendBatch(batchOf(1, "x")); !errors.Is(err, ErrNoEpoch) {
					t.Fatalf("append: %v", err)
				}
				out, err := s.NewEpoch(EpochLogUnreadable, []Event{epochStarted("log_unreadable", epoch)})
				if err != nil || out[0].Seq != 1 {
					t.Fatalf("NewEpoch: %v", err)
				}
				if _, err := os.Stat(filepath.Join(e.dir, dirEvents, epoch)); !os.IsNotExist(err) {
					t.Fatalf("unreadable epoch still in events/: %v", err)
				}
				found := false
				for _, q := range e.quarantine() {
					found = found || strings.HasPrefix(q, "epoch-"+epoch)
				}
				if !found {
					t.Fatalf("unreadable epoch not quarantined: %v", e.quarantine())
				}
				return
			}
			r := rep.Repair
			if r == nil || r.DroppedFromSeq != tc.fromSeq || r.DroppedCount != tc.dropped || rep.LastSeq != tc.fromSeq-1 {
				t.Fatalf("repair %+v, last %d", r, rep.LastSeq)
			}
			if rep.Recovery != RecoveryPartial || rep.NeedEpoch != "" {
				t.Fatalf("report %+v", rep)
			}
			archived := readFileT(t, filepath.Join(e.dir, filepath.FromSlash(r.ArchivedAs)))
			if !strings.HasPrefix(r.ArchivedAs, "quarantine/corrupt-") || !bytes.HasSuffix(edited, archived) ||
				int64(bytes.Count(archived, []byte("\n"))) != tc.dropped {
				t.Fatalf("archive %s: %q", r.ArchivedAs, archived)
			}
			// The engine appends ledger_repaired at the dropped seq.
			out := mustAppend(t, s, []Event{ev("ledger_repaired", 0,
				fmt.Sprintf(`{"droppedFromSeq":%d,"droppedCount":%d,"archivedAs":%q,"balanceCorrection":0}`, r.DroppedFromSeq, r.DroppedCount, r.ArchivedAs))})
			if out[0].Seq != tc.fromSeq {
				t.Fatalf("ledger_repaired seq %d", out[0].Seq)
			}
			_, rep2 := e.reopen(s)
			if rep2.Repair != nil || rep2.LastSeq != tc.fromSeq {
				t.Fatalf("after repair: %+v", rep2)
			}
		})
	}
}

// A tampered line in an early segment drops every later segment.
func TestTamperAcrossSegments(t *testing.T) {
	e := newEnv(t)
	e.mod = func(o *Options) { o.segmentBytes = 1200 }
	s := e.started()
	for i := range 12 {
		mustAppend(t, s, batchOf(2, fmt.Sprint(i)))
	}
	files := e.segments(s)
	if len(files) < 3 {
		t.Fatalf("%d segments", len(files))
	}
	e.closeClean(s)
	data := readFileT(t, files[0])
	offs := lineOffsets(data)
	// Edit the last line of the first segment (a txEnd line, seq = number of lines).
	n := len(offs) - 1
	line := data[offs[n-1]:offs[n]]
	edited := bytes.Replace(line, []byte("svc:"), []byte("svX:"), 1)
	writeFileT(t, files[0], append(append([]byte{}, data[:offs[n-1]]...), edited...))
	s2, rep := e.open()
	if rep.Repair == nil || rep.LastSeq != int64(n-2) || rep.Repair.DroppedFromSeq != int64(n-1) {
		t.Fatalf("report %+v repair %+v (n=%d)", rep, rep.Repair, n)
	}
	if left := e.segments(s2); len(left) != 1 {
		t.Fatalf("segments left: %v", left)
	}
	total := 1 + 12*2
	if rep.Repair.DroppedCount != int64(total-(n-2)) {
		t.Fatalf("dropped %d, want %d", rep.Repair.DroppedCount, total-(n-2))
	}
}

// Crash or failure at every step of AppendBatch, including torn writes of every
// length: the log holds the whole batch or none of it, and a plain failure leaves
// the store usable.
func TestAppendCrashAtEveryStep(t *testing.T) {
	probe := newEnv(t)
	ps := probe.started()
	mustAppend(t, ps, batchOf(2, "a"))
	_, buf, err := encodeBatch(probe.key(), batchOf(3, "b"), ps.Epoch(), 3, ps.LastMac())
	if err != nil {
		t.Fatal(err)
	}
	for _, roll := range []bool{false, true} {
		for _, crash := range []bool{true, false} {
			for _, partial := range []int{0, 1, len(buf) / 2, len(buf) - 1, len(buf)} {
				for k := 1; ; k++ {
					e := newEnv(t)
					if roll {
						e.mod = func(o *Options) { o.segmentBytes = 400 }
					}
					ffs := newFaultFS()
					e.fs = ffs
					s := e.started()
					mustAppend(t, s, batchOf(2, "a"))
					ffs.arm(k, crash, partial, nil)
					_, err := s.AppendBatch(batchOf(3, "b"))
					if !ffs.didFail() {
						if err != nil {
							t.Fatal(err)
						}
						break
					}
					// A failure after the batch is durable (closing the previous
					// segment's handle) does not undo it; any earlier one does.
					committed := err == nil
					if committed && s.LastSeq() != 6 || !committed && s.LastSeq() != 3 {
						t.Fatalf("roll=%v crash=%v partial=%d k=%d: err %v, tip %d", roll, crash, partial, k, err, s.LastSeq())
					}
					wantLast := int64(6)
					if !crash && !committed {
						// The store undid the write and keeps working.
						ffs.disarm()
						out := mustAppend(t, s, batchOf(1, "c"))
						if out[0].Seq != 4 {
							t.Fatalf("roll=%v partial=%d k=%d: next seq %d", roll, partial, k, out[0].Seq)
						}
						wantLast = 4
					}
					_ = s.Close()
					ffs.disarm()
					e.fs = nil
					s2, rep := e.open()
					got := allEvents(t, s2)
					switch {
					case !crash && (rep.LastSeq != wantLast || rep.TornBytes != 0 || rep.PartialLines != 0):
						t.Fatalf("roll=%v partial=%d k=%d: after an undone failure %+v", roll, partial, k, rep)
					case crash && rep.LastSeq != 3 && rep.LastSeq != 6:
						t.Fatalf("roll=%v partial=%d k=%d: last seq %d (partial batch applied)", roll, partial, k, rep.LastSeq)
					case rep.Repair != nil:
						t.Fatalf("roll=%v partial=%d k=%d: a crash reported as tampering", roll, partial, k)
					}
					for i, x := range got {
						if x.Seq != int64(i+1) {
							t.Fatalf("seq gap at %d", i)
						}
					}
					e.closeClean(s2)
				}
			}
		}
	}
}

func TestAppendDiskFullChangesNothing(t *testing.T) {
	e := newEnv(t)
	ffs := newFaultFS()
	e.fs = ffs
	s := e.started()
	// Each error this OS reports for a full disk (diskFullErrors).
	for _, full := range diskFullErrors {
		ffs.arm(1, false, 40, full)
		_, err := s.AppendBatch(batchOf(2, "a"))
		if ReadOnlyReason(err) != ReasonDiskFull {
			t.Fatalf("%v:err %v, reason %q", full, err, ReadOnlyReason(err))
		}
		var we *WriteError
		if !errors.As(err, &we) || !errors.Is(err, full) {
			t.Fatalf("%v:not a WriteError: %v", full, err)
		}
		if fi, _ := os.Stat(e.segments(s)[0]); fi.Size() != s.Stats().LogBytes {
			t.Fatalf("%v:segment %d bytes, index %d", full, fi.Size(), s.Stats().LogBytes)
		}
	}
	ffs.arm(1, false, 40, errors.New("device error"))
	if _, err := s.AppendBatch(batchOf(2, "a")); ReadOnlyReason(err) != ReasonIOError {
		t.Fatalf("err %v, reason %q", err, ReadOnlyReason(err))
	}
	if ReadOnlyReason(errors.New("x")) != "" || ReadOnlyReason(ErrInvalid) != "" || ReadOnlyReason(ErrBroken) != ReasonIOError {
		t.Fatal("ReadOnlyReason mapping")
	}
	mustAppend(t, s, batchOf(1, "b"))
	// A failed undo marks the store broken until it is reopened.
	ffs.arm(1, true, 10, nil)
	if _, err := s.AppendBatch(batchOf(1, "c")); err == nil {
		t.Fatal("no error")
	}
	ffs.disarm()
	if _, err := s.AppendBatch(batchOf(1, "d")); !errors.Is(err, ErrBroken) {
		t.Fatalf("broken store accepted a write: %v", err)
	}
	_ = s.Close()
	_, rep := e.open()
	if rep.LastSeq != 2 || rep.TornBytes != 10 {
		t.Fatalf("reopen %+v", rep)
	}
}

func TestConcurrentReadsAndAppends(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	var wg sync.WaitGroup
	stop := make(chan struct{})
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				p, err := s.ReadEvents(s.Epoch(), 0, 50)
				if err != nil {
					t.Error(err)
					return
				}
				for i, x := range p.Events {
					if x.Seq != int64(i+1) {
						t.Errorf("seq %d at %d", x.Seq, i)
						return
					}
				}
				_ = s.Stats()
			}
		}()
	}
	for i := range 100 {
		mustAppend(t, s, batchOf(1+i%3, fmt.Sprint(i)))
	}
	close(stop)
	wg.Wait()
}

func TestReadDetectsLiveTampering(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	mustAppend(t, s, batchOf(2, "a"))
	seg := e.segments(s)[0]
	data := readFileT(t, seg)
	writeFileT(t, seg, bytes.Replace(data, []byte("svc:youtube"), []byte("svc:yOutube"), 1))
	if _, err := s.ReadEvents(s.Epoch(), 0, 10); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("err %v", err)
	}
}

func TestSegmentNames(t *testing.T) {
	for name, want := range map[string]int64{
		"00000001.jsonl": 1, "12345678.jsonl": 12345678, "123456789.jsonl": 123456789,
		"000000001.jsonl": 0, "0000001.jsonl": 0, "00000000.jsonl": 0, "0000000a.jsonl": 0, "00000001.json": 0,
	} {
		got, ok := parseSegName(name)
		if want == 0 && ok || want != 0 && (!ok || got != want) {
			t.Errorf("%s: %d %v", name, got, ok)
		}
	}
}

// A restored older data folder keeps the epoch and reuses seqs: a client whose cursor
// is past the restored tail must be told to reset, or it would skip the reused seqs
// (and whatever the guardian logs next) until the log passed its old cursor.
func TestReadEventsResetsCursorPastRestoredTail(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	mustAppend(t, s, batchOf(3, "a"))
	e.closeClean(s)
	saved := filepath.Join(t.TempDir(), "saved")
	if err := os.CopyFS(saved, os.DirFS(e.dir)); err != nil {
		t.Fatal(err)
	}

	s, _ = e.open()
	mustAppend(t, s, batchOf(5, "b"))
	epoch, cursor := s.Epoch(), s.LastSeq()
	if cursor != 9 {
		t.Fatalf("last seq %d", cursor)
	}
	e.closeClean(s)

	if err := os.RemoveAll(e.dir); err != nil {
		t.Fatal(err)
	}
	if err := os.CopyFS(e.dir, os.DirFS(saved)); err != nil {
		t.Fatal(err)
	}
	s, rep := e.open()
	if s.Epoch() != epoch || rep.LastSeq != 4 {
		t.Fatalf("restored: epoch %s last %d", s.Epoch(), rep.LastSeq)
	}
	mustAppend(t, s, batchOf(1, "c")) // seq 5 reused with other content

	p, err := s.ReadEvents(epoch, cursor, 100)
	if err != nil || !p.Reset || p.Epoch != epoch || len(p.Events) != 5 || p.Events[0].Seq != 1 ||
		p.LastSeq != 5 || p.HasMore {
		t.Fatalf("stale cursor: %+v %v", p, err)
	}
}
