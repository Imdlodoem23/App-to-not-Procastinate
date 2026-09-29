package store

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

// EnvelopeVersion is the envelope version the guardian writes (EventEnvelopeBase.v).
// Lines with a higher v and a valid MAC put the store in frozen mode.
const EnvelopeVersion = 1

// TimeLayout is the wire format of every timestamp: UTC with exactly millisecond
// precision, e.g. 2026-09-27T16:42:00.000Z (§4).
const TimeLayout = "2006-01-02T15:04:05.000Z"

// FormatTime formats t (trusted time for events) as a wire timestamp, truncated to the
// millisecond.
func FormatTime(t time.Time) string {
	return t.UTC().Truncate(time.Millisecond).Format(TimeLayout)
}

// ParseTime parses a wire timestamp strictly (exactly the TimeLayout form).
func ParseTime(s string) (time.Time, error) {
	t, err := time.Parse(TimeLayout, s)
	if err != nil || t.Format(TimeLayout) != s {
		return time.Time{}, invalid("timestamp %q is not YYYY-MM-DDTHH:MM:SS.sssZ", s)
	}
	return t, nil
}

func validDay(s string) bool {
	t, err := time.Parse(time.DateOnly, s)
	return err == nil && t.Format(time.DateOnly) == s
}

// Event is one line of the event log: EventEnvelopeBase plus type and data (domain.ts),
// and the HMAC chain fields that the API never serves (use WireJSON).
//
// For AppendBatch and NewEpoch the caller fills At (trusted time, see FormatTime),
// WallOffsetMs, Day, Type, Points, XP, Req and Data; the store sets V, Epoch, Seq,
// TxEnd, PrevMac and Mac and ignores what the caller put there.
type Event struct {
	V     int    `json:"v"`
	Epoch string `json:"epoch"`
	Seq   int64  `json:"seq"`
	// At is trusted time (never display time), YYYY-MM-DDTHH:MM:SS.sssZ.
	At string `json:"at"`
	// WallOffsetMs is W at emission: display time is value + WallOffsetMs.
	WallOffsetMs int64 `json:"wallOffsetMs"`
	// Day is the local day (YYYY-MM-DD) at emission.
	Day  string `json:"day"`
	Type string `json:"type"`
	// Points and XP are the recorded deltas (XP ≥ 0). For epoch_started Points is the
	// carried balance.
	Points int64 `json:"points"`
	XP     int64 `json:"xp"`
	// TxEnd is true on the last event of its batch.
	TxEnd bool `json:"txEnd"`
	// Req is the idempotency fingerprint of the request that caused the event
	// (ReqFingerprint), or nil.
	Req *string `json:"req"`
	// Data is the JSON object of the event type (EventDataMap in domain.ts).
	Data json.RawMessage `json:"data"`
	// PrevMac and Mac form the HMAC chain (§11.4).
	PrevMac string `json:"prevMac"`
	Mac     string `json:"mac"`
}

// wireEvent is an Event as /v1/events serves it: without prevMac and mac.
type wireEvent struct {
	V            int             `json:"v"`
	Epoch        string          `json:"epoch"`
	Seq          int64           `json:"seq"`
	At           string          `json:"at"`
	WallOffsetMs int64           `json:"wallOffsetMs"`
	Day          string          `json:"day"`
	Type         string          `json:"type"`
	Points       int64           `json:"points"`
	XP           int64           `json:"xp"`
	TxEnd        bool            `json:"txEnd"`
	Req          *string         `json:"req"`
	Data         json.RawMessage `json:"data"`
}

// WireJSON encodes the event as /v1/events serves it (§8.8): the envelope, type and
// data in disk order, without prevMac and mac.
func (e Event) WireJSON() ([]byte, error) {
	data := e.Data
	if len(data) == 0 {
		data = json.RawMessage("null")
	}
	return json.Marshal(wireEvent{
		V: e.V, Epoch: e.Epoch, Seq: e.Seq, At: e.At, WallOffsetMs: e.WallOffsetMs, Day: e.Day,
		Type: e.Type, Points: e.Points, XP: e.XP, TxEnd: e.TxEnd, Req: e.Req, Data: data,
	})
}

var (
	// typeRE is the wire pattern of an event type (EVENT_TYPE_RE in guardian-api.ts).
	typeRE = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
	// reqRE is the wire pattern of req (the envelope schema in guardian-api.ts).
	reqRE = regexp.MustCompile(`^[0-9a-f]{1,128}$`)
)

// normalizeDraft validates the caller's part of an event and returns it with Data
// compacted and HTML-escaped exactly as it is written to disk.
func normalizeDraft(e Event) (Event, error) {
	if !typeRE.MatchString(e.Type) {
		return e, invalid("event type %q", e.Type)
	}
	if _, err := ParseTime(e.At); err != nil {
		return e, err
	}
	if !validDay(e.Day) {
		return e, invalid("%s: day %q is not YYYY-MM-DD", e.Type, e.Day)
	}
	if e.XP < 0 {
		return e, invalid("%s: xp %d is negative", e.Type, e.XP)
	}
	if e.Req != nil {
		if !reqRE.MatchString(*e.Req) {
			return e, invalid("%s: req %q is not lowercase hex", e.Type, *e.Req)
		}
		r := *e.Req
		e.Req = &r
	}
	d := bytes.TrimSpace(e.Data)
	if len(d) == 0 || d[0] != '{' || !json.Valid(d) {
		return e, invalid("%s: data is not a JSON object", e.Type)
	}
	var compact, escaped bytes.Buffer
	if err := json.Compact(&compact, d); err != nil {
		return e, invalid("%s: data: %v", e.Type, err)
	}
	json.HTMLEscape(&escaped, compact.Bytes())
	e.Data = escaped.Bytes()
	return e, nil
}

// appendBody appends B, the line without its mac member, in the fixed disk order.
func appendBody(dst []byte, e *Event) []byte {
	dst = append(dst, `{"v":`...)
	dst = strconv.AppendInt(dst, int64(e.V), 10)
	dst = append(dst, `,"epoch":`...)
	dst = appendJSONString(dst, e.Epoch)
	dst = append(dst, `,"seq":`...)
	dst = strconv.AppendInt(dst, e.Seq, 10)
	dst = append(dst, `,"at":`...)
	dst = appendJSONString(dst, e.At)
	dst = append(dst, `,"wallOffsetMs":`...)
	dst = strconv.AppendInt(dst, e.WallOffsetMs, 10)
	dst = append(dst, `,"day":`...)
	dst = appendJSONString(dst, e.Day)
	dst = append(dst, `,"type":`...)
	dst = appendJSONString(dst, e.Type)
	dst = append(dst, `,"points":`...)
	dst = strconv.AppendInt(dst, e.Points, 10)
	dst = append(dst, `,"xp":`...)
	dst = strconv.AppendInt(dst, e.XP, 10)
	dst = append(dst, `,"txEnd":`...)
	dst = strconv.AppendBool(dst, e.TxEnd)
	dst = append(dst, `,"req":`...)
	if e.Req == nil {
		dst = append(dst, "null"...)
	} else {
		dst = appendJSONString(dst, *e.Req)
	}
	dst = append(dst, `,"data":`...)
	dst = append(dst, e.Data...)
	dst = append(dst, `,"prevMac":`...)
	dst = appendJSONString(dst, e.PrevMac)
	return append(dst, '}')
}

func appendJSONString(dst []byte, s string) []byte {
	b, _ := json.Marshal(s) // a string always encodes
	return append(dst, b...)
}

// macLen is the length of an unpadded base64url HMAC-SHA256.
const macLen = 43

var macMember = []byte(`,"mac":"`)

var (
	errNotSealed = errors.New("no trailing mac member")
	errBadMAC    = errors.New("MAC mismatch")
)

func computeMAC(key, body []byte) string {
	m := hmac.New(sha256.New, key)
	m.Write(body)
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// seal returns body (a non-empty JSON object) with its mac appended as the last member.
func seal(key, body []byte) (sealed []byte, mac string) {
	mac = computeMAC(key, body)
	out := make([]byte, 0, len(body)+len(macMember)+macLen+2)
	out = append(out, body[:len(body)-1]...)
	out = append(out, macMember...)
	out = append(out, mac...)
	return append(out, `"}`...), mac
}

// unseal checks the trailing mac member of sealed against the body before it and
// returns that body (a copy, with the closing brace restored) and the mac.
func unseal(key, sealed []byte) (body []byte, mac string, err error) {
	n := len(sealed)
	head := n - 2 - macLen - len(macMember)
	if head < 1 || sealed[n-1] != '}' || sealed[n-2] != '"' ||
		!bytes.Equal(sealed[head:head+len(macMember)], macMember) {
		return nil, "", errNotSealed
	}
	m := sealed[n-2-macLen : n-2]
	if !isBase64URL(m) {
		return nil, "", errNotSealed
	}
	body = make([]byte, head+1)
	copy(body, sealed[:head])
	body[head] = '}'
	if !hmac.Equal([]byte(computeMAC(key, body)), m) {
		return nil, "", errBadMAC
	}
	return body, string(m), nil
}

func isBase64URL(b []byte) bool {
	for _, c := range b {
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_':
		default:
			return false
		}
	}
	return true
}

func isMAC(s string) bool { return len(s) == macLen && isBase64URL([]byte(s)) }

// maxBatchEvents is the largest batch (GUARDIAN_LIMITS.maxBatchEvents).
func maxBatchEvents() int { return embedded.API().Limits.MaxBatchEvents }

// encodeBatch validates batch and encodes it as the lines that follow (lastSeq,
// lastMac) in epoch. It returns the stored events and the bytes to append.
func encodeBatch(key []byte, batch []Event, epoch string, lastSeq int64, lastMac string) ([]Event, []byte, error) {
	if len(batch) == 0 {
		return nil, nil, invalid("empty batch")
	}
	if max := maxBatchEvents(); len(batch) > max {
		return nil, nil, invalid("batch of %d events (at most %d)", len(batch), max)
	}
	out := make([]Event, len(batch))
	var buf []byte
	prev := lastMac
	for i, draft := range batch {
		e, err := normalizeDraft(draft)
		if err != nil {
			return nil, nil, err
		}
		e.V = EnvelopeVersion
		e.Epoch = epoch
		e.Seq = lastSeq + 1 + int64(i)
		e.TxEnd = i == len(batch)-1
		e.PrevMac = prev
		line, mac := seal(key, appendBody(nil, &e))
		e.Mac = mac
		buf = append(buf, line...)
		buf = append(buf, '\n')
		out[i] = e
		prev = mac
	}
	return out, buf, nil
}

// Line verification errors (scan and read).
var (
	errTooNew     = errors.New("envelope version newer than this guardian")
	errMalformed  = errors.New("malformed envelope")
	errWrongEpoch = errors.New("epoch mismatch")
	errWrongSeq   = errors.New("seq gap or reorder")
	errChain      = errors.New("prevMac does not match the previous line")
	errSegName    = errors.New("segment name does not match its first seq")
)

// lineHead is the part of a line the startup scan checks.
type lineHead struct {
	V       *int   `json:"v"`
	Epoch   string `json:"epoch"`
	Seq     int64  `json:"seq"`
	Type    string `json:"type"`
	TxEnd   bool   `json:"txEnd"`
	PrevMac string `json:"prevMac"`
	Mac     string `json:"mac"`
}

// checkLine verifies one complete line (without its newline): MAC, envelope version,
// epoch, seq and, when prev is not nil, the chain.
func checkLine(key, line []byte, epoch string, seq int64, prev *string) (lineHead, error) {
	_, mac, err := unseal(key, line)
	if err != nil {
		return lineHead{}, err
	}
	var h lineHead
	if err := json.Unmarshal(line, &h); err != nil || h.V == nil || h.Mac != mac {
		return lineHead{}, errMalformed
	}
	switch {
	case *h.V > EnvelopeVersion:
		return h, errTooNew
	case *h.V != EnvelopeVersion:
		return h, errMalformed
	case h.Epoch != epoch:
		return h, errWrongEpoch
	case h.Seq != seq:
		return h, errWrongSeq
	case prev != nil && h.PrevMac != *prev:
		return h, errChain
	}
	return h, nil
}

// decodeLine verifies a line read back from a committed segment and decodes it.
func decodeLine(key, line []byte, epoch string, seq int64) (Event, error) {
	if _, err := checkLine(key, line, epoch, seq, nil); err != nil {
		return Event{}, err
	}
	var e Event
	if err := json.Unmarshal(line, &e); err != nil {
		return Event{}, errMalformed
	}
	return e, nil
}
