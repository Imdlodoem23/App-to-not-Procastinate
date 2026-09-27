package hosts

import (
	"bytes"
	"errors"
	"runtime"
	"slices"
	"unicode/utf8"
)

const (
	// StartMarker opens the Céntrate section.
	StartMarker = "# >>> CENTRATE START"
	// EndMarker closes the Céntrate section.
	EndMarker = "# <<< CENTRATE END"
	// Header is the comment written right after StartMarker.
	Header = "# Managed by Céntrate. Do not edit: changes are restored."
	// headerASCII replaces Header in files that are not valid UTF-8 (a legacy
	// code page), so the section never mixes encodings with the user's lines.
	headerASCII = "# Managed by Centrate. Do not edit: changes are restored."

	// IPv4Sink and IPv6Sink are the unroutable addresses blocked domains map to.
	IPv4Sink = "0.0.0.0"
	IPv6Sink = "::"
)

var (
	// ErrCorrupt is returned when the hosts file contains NUL bytes, which a
	// text hosts file never does: typically the remains of an interrupted
	// write. The file is not modified; see Manager.Damaged and
	// Manager.RestoreFromBackup.
	ErrCorrupt = errors.New("hosts: file contains NUL bytes (corrupt)")
	// ErrUnsupportedEncoding is returned for UTF-16 or UTF-32 hosts files
	// (detected by their byte order mark). They are left untouched.
	ErrUnsupportedEncoding = errors.New("hosts: UTF-16/UTF-32 hosts files are not supported")
)

var (
	utf8BOM    = []byte{0xEF, 0xBB, 0xBF}
	utf16LEBOM = []byte{0xFF, 0xFE}
	utf16BEBOM = []byte{0xFE, 0xFF}
	crlf       = []byte("\r\n")
	lf         = []byte("\n")
)

// defaultEOL is used when the file has no line break to copy from.
func defaultEOL() []byte {
	if runtime.GOOS == "windows" {
		return crlf
	}
	return lf
}

// line is one line of the file: its bytes without the terminator, and the
// terminator itself ("\r\n", "\n", or nil for a last line without one).
type line struct {
	text []byte
	eol  []byte
}

// document is a parsed hosts file. Lines outside the Céntrate section are
// kept as byte slices and written back verbatim.
type document struct {
	bom      bool   // the file starts with a UTF-8 BOM
	lines    []line // content after the BOM
	eol      []byte // dominant line terminator, used for the lines we write
	trailing bool   // the file ends with a line break (true for an empty file)
	legacy   bool   // the content is not valid UTF-8 (legacy code page)
}

func parseDocument(data []byte) (*document, error) {
	if bytes.HasPrefix(data, utf16LEBOM) || bytes.HasPrefix(data, utf16BEBOM) {
		return nil, ErrUnsupportedEncoding
	}
	d := &document{}
	body := data
	if bytes.HasPrefix(body, utf8BOM) {
		d.bom = true
		body = body[len(utf8BOM):]
	}
	if bytes.IndexByte(body, 0) >= 0 {
		return nil, ErrCorrupt
	}
	d.trailing = len(body) == 0 || body[len(body)-1] == '\n'
	d.legacy = !utf8.Valid(body)

	var nCRLF, nLF int
	for rest := body; len(rest) > 0; {
		i := bytes.IndexByte(rest, '\n')
		if i < 0 {
			d.lines = append(d.lines, line{text: rest})
			break
		}
		text, eol := rest[:i], lf
		if i > 0 && rest[i-1] == '\r' {
			text, eol = rest[:i-1], crlf
			nCRLF++
		} else {
			nLF++
		}
		d.lines = append(d.lines, line{text: text, eol: eol})
		rest = rest[i+1:]
	}
	switch {
	case nCRLF > nLF:
		d.eol = crlf
	case nLF > nCRLF:
		d.eol = lf
	default:
		d.eol = defaultEOL()
	}
	return d, nil
}

type lineKind int

const (
	kindOther lineKind = iota
	kindStart
	kindEnd
)

func kindOf(l line) lineKind {
	switch string(bytes.TrimSpace(l.text)) {
	case StartMarker:
		return kindStart
	case EndMarker:
		return kindEnd
	}
	return kindOther
}

// looksOurs reports whether a line is exactly what render writes inside the
// section: the header or a "<sink> <domain>" entry. Used to decide how far a
// section with a missing marker extends.
func looksOurs(text []byte) bool {
	t := string(text)
	if t == Header || t == headerASCII {
		return true
	}
	for _, sink := range [...]string{IPv4Sink + " ", IPv6Sink + " "} {
		if len(t) > len(sink) && t[:len(sink)] == sink {
			d := t[len(sink):]
			_, reason := checkDomain(d)
			return reason == ""
		}
	}
	return false
}

// scanResult splits the file into the user's lines and the Céntrate section.
type scanResult struct {
	user    []line   // every line outside the section(s), in order
	at      int      // index in user where the (first) section was; -1 if none
	domains []string // valid domains listed inside the section(s), unsorted
}

// scan finds the Céntrate section and repairs unbalanced markers:
//
//   - START … END: every line in between belongs to the section.
//   - START with no END before the next START or the end of the file: the
//     section is START plus the lines right after it that look exactly like
//     ours (header and "<sink> <domain>" entries). The first other line is the
//     user's and is kept.
//   - END with no START: the section is END plus the lines right above it that
//     look exactly like ours.
//   - Several sections: all of them are removed; the new one goes where the
//     first one was. User lines between them are kept.
func scan(lines []line) scanResult {
	r := scanResult{at: -1}
	mark := func() {
		if r.at < 0 {
			r.at = len(r.user)
		}
	}
	for i := 0; i < len(lines); {
		switch kindOf(lines[i]) {
		case kindStart:
			mark()
			k := i + 1
			for k < len(lines) && kindOf(lines[k]) == kindOther {
				k++
			}
			if k < len(lines) && kindOf(lines[k]) == kindEnd {
				for _, l := range lines[i+1 : k] {
					r.collect(l.text)
				}
				i = k + 1
				continue
			}
			j := i + 1
			for j < k && looksOurs(lines[j].text) {
				r.collect(lines[j].text)
				j++
			}
			i = j
		case kindEnd:
			floor := max(r.at, 0)
			n := len(r.user)
			for n > floor && looksOurs(r.user[n-1].text) {
				n--
			}
			for _, l := range r.user[n:] {
				r.collect(l.text)
			}
			r.user = r.user[:n]
			mark()
			i++
		default:
			r.user = append(r.user, lines[i])
			i++
		}
	}
	return r
}

// collect records the domains of a "<sink> <domain>…" line inside the section.
func (r *scanResult) collect(text []byte) {
	fields := bytes.Fields(text)
	if len(fields) < 2 {
		return
	}
	if s := string(fields[0]); s != IPv4Sink && s != IPv6Sink {
		return
	}
	for _, f := range fields[1:] {
		if f[0] == '#' {
			return
		}
		if d, reason := checkDomain(string(f)); reason == "" {
			r.domains = append(r.domains, d)
		}
	}
}

func isBlank(l line) bool { return len(bytes.TrimSpace(l.text)) == 0 }

// render returns the file content with the Céntrate section holding exactly
// domains (already normalized), or without any section when domains is empty.
// Lines outside the section are copied byte for byte, and the BOM and the
// presence of a final line break are preserved.
func (d *document) render(domains []string) []byte {
	s := scan(d.lines)
	var out []line
	switch {
	case len(domains) == 0:
		out = s.user
		if s.at >= 0 {
			out = collapseBlank(s.user, s.at)
		}
	case s.at >= 0:
		out = make([]line, 0, len(s.user)+2*len(domains)+3)
		out = append(out, s.user[:s.at]...)
		out = append(out, d.section(domains)...)
		out = append(out, s.user[s.at:]...)
	default:
		out = make([]line, 0, len(s.user)+2*len(domains)+4)
		out = append(out, s.user...)
		if len(out) > 0 {
			out = append(out, line{eol: d.eol}) // blank separator, removed again by Remove
		}
		out = append(out, d.section(domains)...)
	}

	var buf bytes.Buffer
	if d.bom {
		buf.Write(utf8BOM)
	}
	for i, l := range out {
		buf.Write(l.text)
		eol := l.eol
		switch {
		case i < len(out)-1:
			if eol == nil {
				eol = d.eol // a user line that used to be the last one
			}
		case d.trailing:
			if eol == nil {
				eol = d.eol
			}
		default:
			eol = nil
		}
		buf.Write(eol)
	}
	return buf.Bytes()
}

// section renders the marker, header and entry lines.
func (d *document) section(domains []string) []line {
	header := Header
	if d.legacy {
		header = headerASCII
	}
	lines := make([]line, 0, 2*len(domains)+3)
	add := func(s string) { lines = append(lines, line{text: []byte(s), eol: d.eol}) }
	add(StartMarker)
	add(header)
	for _, dom := range domains {
		add(IPv4Sink + " " + dom)
		add(IPv6Sink + " " + dom)
	}
	add(EndMarker)
	return lines
}

// collapseBlank removes one of the blank lines that surround position at once
// the section is gone, so removing it does not leave a double blank line (or
// a blank line at the start or end of the file). It returns a new slice.
func collapseBlank(user []line, at int) []line {
	prevBlank := at == 0 || isBlank(user[at-1])
	nextBlank := at == len(user) || isBlank(user[at])
	out := make([]line, 0, len(user))
	switch {
	case !prevBlank || !nextBlank:
		out = append(out, user...)
	case at > 0:
		out = append(out, user[:at-1]...)
		out = append(out, user[at:]...)
	case at < len(user):
		out = append(out, user[1:]...)
	}
	return out
}

// sectionDomains returns the sorted, deduplicated domains listed in the
// section (collect already validated and lowercased them). Never nil.
func (d *document) sectionDomains() []string {
	ds := scan(d.lines).domains
	if len(ds) == 0 {
		return []string{}
	}
	slices.Sort(ds)
	return slices.Compact(ds)
}
