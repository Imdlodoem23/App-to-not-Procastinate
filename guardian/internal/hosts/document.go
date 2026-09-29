package hosts

import (
	"bytes"
	"errors"
	"net/netip"
	"runtime"
	"slices"
	"strings"
	"time"
)

const (
	// StartMarker opens the Céntrate section.
	StartMarker = "# >>> CENTRATE START"
	// EndMarker closes the Céntrate section.
	EndMarker = "# <<< CENTRATE END"
	// Header is the comment written right after StartMarker. It is plain
	// ASCII on purpose: a non-ASCII byte makes some editors (older Notepad
	// among them) save the file as UTF-8 with a BOM, and the Windows resolver
	// does not skip a BOM, so the user's first entry would stop working.
	Header = "# Managed by Centrate. Do not edit: changes are restored."
	// headerUTF8 is the header written by earlier builds. It is still
	// recognised as ours and replaced by Header on the next write.
	headerUTF8 = "# Managed by C\u00e9ntrate. Do not edit: changes are restored."

	// ShadowMarker prefixes a user line outside the section that the guardian
	// commented out because it maps a blocked domain to a real address (see
	// the package documentation, «Lines that override the section»). The
	// rest of the line is the user's line, byte for byte; it is restored as
	// soon as none of its names is blocked any more, and always by Remove.
	ShadowMarker = "#centrate-shadowed# "

	// IPv4Sink and IPv6Sink are the unroutable addresses blocked domains map to.
	IPv4Sink = "0.0.0.0"
	IPv6Sink = "::"

	// nulRunDamage is the length of a run of NUL bytes taken as the remains
	// of an interrupted write (file systems zero-fill whole blocks). Text in
	// UTF-16 or UTF-32 never has more than a handful of NULs in a row.
	nulRunDamage = 16
)

var (
	// ErrCorrupt is returned when the hosts file looks broken by an
	// interrupted write: it contains a run of NUL bytes (or is nothing but
	// NUL bytes), which a text hosts file in any encoding never does. The
	// file is not modified; see Manager.Damaged and Manager.Recover.
	ErrCorrupt = errors.New("hosts: file contains blocks of NUL bytes (corrupt)")
	// ErrUnsupportedEncoding is returned for UTF-16 or UTF-32 hosts files
	// (with or without a byte order mark) and for any other file with
	// scattered NUL bytes. They are left untouched and are not damage.
	ErrUnsupportedEncoding = errors.New("hosts: UTF-16/UTF-32 or binary hosts files are not supported")
)

var (
	utf8BOM    = []byte{0xEF, 0xBB, 0xBF}
	utf16LEBOM = []byte{0xFF, 0xFE}
	utf16BEBOM = []byte{0xFE, 0xFF}
	utf32LEBOM = []byte{0xFF, 0xFE, 0x00, 0x00}
	utf32BEBOM = []byte{0x00, 0x00, 0xFE, 0xFF}
	nulRun     = make([]byte, nulRunDamage)
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
}

func parseDocument(data []byte) (*document, error) {
	if err := checkEncoding(data); err != nil {
		return nil, err
	}
	d := &document{}
	body := data
	if bytes.HasPrefix(body, utf8BOM) {
		d.bom = true
		body = body[len(utf8BOM):]
	}
	d.trailing = len(body) == 0 || body[len(body)-1] == '\n'

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

// checkEncoding refuses what parseDocument cannot edit safely:
//
//   - a UTF-32 or UTF-16 byte order mark: ErrUnsupportedEncoding;
//   - NUL bytes forming a run of nulRunDamage or more, or making up the whole
//     file: ErrCorrupt (zero-filled blocks left by an interrupted write);
//   - any other NUL bytes: ErrUnsupportedEncoding (wide text without a byte
//     order mark, or a binary file), which is not damage.
func checkEncoding(data []byte) error {
	switch {
	case bytes.HasPrefix(data, utf32LEBOM), bytes.HasPrefix(data, utf32BEBOM),
		bytes.HasPrefix(data, utf16LEBOM), bytes.HasPrefix(data, utf16BEBOM):
		return ErrUnsupportedEncoding
	}
	body := bytes.TrimPrefix(data, utf8BOM)
	if bytes.IndexByte(body, 0) < 0 {
		return nil
	}
	if bytes.Contains(body, nulRun) || len(bytes.Trim(body, "\x00")) == 0 {
		return ErrCorrupt
	}
	return ErrUnsupportedEncoding
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

// isHeader reports whether a line is a header some build of ours wrote.
func isHeader(text []byte) bool {
	t := string(text)
	return t == Header || t == headerUTF8
}

// pairAt reports whether a and b are exactly the two lines render writes for
// one domain, "0.0.0.0 <d>" followed by ":: <d>", and returns d. The domain
// must be valid and already normalized (lowercase), as render writes it.
func pairAt(a, b []byte) (string, bool) {
	const v4, v6 = IPv4Sink + " ", IPv6Sink + " "
	if !bytes.HasPrefix(a, []byte(v4)) || !bytes.HasPrefix(b, []byte(v6)) {
		return "", false
	}
	d := string(a[len(v4):])
	if string(b[len(v6):]) != d {
		return "", false
	}
	if norm, reason := checkDomain(d); reason != "" || norm != d {
		return "", false
	}
	return d, true
}

// claimAfterStart returns the end (exclusive) of the lines in lines[from:to]
// that an orphan START marker at from-1 owns: an optional header, an optional
// header line (see FormatSectionHeader) and a run of strict pairs (see pairAt) in strictly ascending domain order, as
// render writes them. The first line that breaks the pattern, and everything
// after it, is the user's.
func claimAfterStart(lines []line, from, to int) int {
	j := from
	if j < to && isHeader(lines[j].text) {
		j++
	}
	if j < to && isMetaLine(lines[j].text) {
		j++
	}
	prev := ""
	for j+1 < to {
		d, ok := pairAt(lines[j].text, lines[j+1].text)
		if !ok || d <= prev {
			break
		}
		prev = d
		j += 2
	}
	return j
}

// claimBeforeEnd returns the start of the lines in user[floor:] that an
// orphan END marker right after them owns. Walking upward it accepts a run of
// strict pairs in strictly descending domain order (ascending as written).
// The run is claimed only if our header or our exact header line (see
// FormatSectionHeader) sits right above it, or if it starts at a boundary: the start of the file, the position of an earlier section,
// or a blank line (the separator render writes before an appended section).
// Otherwise nothing is claimed and only the stray marker goes: a run that
// directly follows other lines may be the tail of the user's own list, and
// losing user lines is worse than leaving a few of ours behind.
func claimBeforeEnd(user []line, floor int) int {
	n := len(user)
	next := "" // domain of the pair below; "" before the first one
	for n-2 >= floor {
		d, ok := pairAt(user[n-2].text, user[n-1].text)
		if !ok || (next != "" && d >= next) {
			break
		}
		next = d
		n -= 2
	}
	j := n
	if j > floor && isMetaLine(user[j-1].text) {
		j--
	}
	switch {
	case j > floor && isHeader(user[j-1].text):
		return j - 1
	case j < n:
		return j // our exact header line sits right above the pairs
	case n == len(user):
		return n // no pairs: a lone END
	case n == floor || isBlank(user[n-1]):
		return n
	}
	return len(user)
}

// scanResult splits the file into the user's lines and the Céntrate section.
type scanResult struct {
	user    []line   // every line outside the section(s), in order
	at      int      // index in user where the (first) section was; -1 if none
	domains []string // valid domains listed inside the section(s), unsorted
	// until and count come from the first valid header line inside the
	// section(s); hasMeta says one was found.
	until   time.Time
	count   int
	hasMeta bool
}

// scan finds the Céntrate section and repairs unbalanced markers. Only lines
// that match what render writes, in the order it writes them, are ever taken
// from the user's side of a missing marker (see claimAfterStart and
// claimBeforeEnd), so lists of the user's own "0.0.0.0 <domain>" entries next
// to a stray marker survive:
//
//   - START … END: every line in between belongs to the section.
//   - START with no END before the next START or the end of the file: the
//     section is START plus the header and entry pairs right after it.
//   - END with no START: the section is END plus the entry pairs (and header)
//     right above it, when they start at a boundary; otherwise just END.
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
			j := claimAfterStart(lines, i+1, k)
			for _, l := range lines[i+1 : j] {
				r.collect(l.text)
			}
			i = j
		case kindEnd:
			n := claimBeforeEnd(r.user, max(r.at, 0))
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

// collect records the domains of a "<sink> <domain>…" line inside the
// section, and the first valid header line.
func (r *scanResult) collect(text []byte) {
	if !r.hasMeta && bytes.HasPrefix(bytes.TrimSpace(text), []byte(SectionHeaderPrefix)) {
		if until, count, ok := ParseSectionHeader(string(text)); ok {
			r.until, r.count, r.hasMeta = until, count, true
		}
		return
	}
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
// A non-zero until adds the header line (FormatSectionHeader). Lines outside
// the section are copied byte for byte, and the BOM and the presence of a
// final line break are preserved.
//
// The one exception to the byte-for-byte rule: a user line that maps one of
// domains to anything but a sink address is commented out with ShadowMarker
// (see shadowLines), and lines commented out earlier are restored once none
// of their names is in domains (always when domains is empty).
func (d *document) render(domains []string, until time.Time) []byte {
	s := scan(d.lines)
	user := shadowLines(s.user, domains)
	var out []line
	switch {
	case len(domains) == 0:
		out = user
		if s.at >= 0 {
			out = collapseBlank(user, s.at)
		}
	case s.at >= 0:
		out = make([]line, 0, len(user)+2*len(domains)+3)
		out = append(out, user[:s.at]...)
		out = append(out, d.section(domains, until)...)
		out = append(out, user[s.at:]...)
	default:
		out = make([]line, 0, len(user)+2*len(domains)+4)
		out = append(out, user...)
		if len(out) > 0 {
			out = append(out, line{eol: d.eol}) // blank separator, removed again by Remove
		}
		out = append(out, d.section(domains, until)...)
	}

	var buf bytes.Buffer
	if d.bom {
		buf.Write(utf8BOM)
	}
	for i, l := range out {
		buf.Write(l.text)
		eol := l.eol
		switch {
		case i == len(out)-1 && !d.trailing:
			eol = nil
		case eol == nil: // a user line that used to be the last one
			eol = d.eol
			if bytes.HasSuffix(l.text, []byte{'\r'}) {
				// "x\r" + "\n" would read back as "x" + CRLF and lose the
				// '\r'; "x\r" + CRLF reads back as "x\r" + CRLF.
				eol = crlf
			}
		}
		buf.Write(eol)
	}
	return buf.Bytes()
}

// section renders the marker, header, header line (when until is set) and
// entry lines.
func (d *document) section(domains []string, until time.Time) []line {
	lines := make([]line, 0, 2*len(domains)+4)
	add := func(s string) { lines = append(lines, line{text: []byte(s), eol: d.eol}) }
	add(StartMarker)
	add(Header)
	if !until.IsZero() {
		add(FormatSectionHeader(until, len(domains)))
	}
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
	return d.sectionInfo().Domains
}

// sectionInfo describes the section: its domains (sorted, deduplicated, never
// nil) and its header line.
func (d *document) sectionInfo() SectionInfo {
	s := scan(d.lines)
	info := SectionInfo{Present: s.at >= 0, Domains: []string{}, HasHeader: s.hasMeta, Until: s.until, Count: s.count}
	if len(s.domains) > 0 {
		slices.Sort(s.domains)
		info.Domains = slices.Compact(s.domains)
	}
	return info
}

// effectiveDomains returns the section's domains (sorted, deduplicated, never
// nil) minus those that an active user line outside the section maps to a
// real address (see overriddenNames): the domains the hosts layer really
// blocks for a resolver that honours the first matching line.
func (d *document) effectiveDomains() []string {
	s := scan(d.lines)
	listed := d.sectionInfo().Domains
	if len(listed) == 0 {
		return listed
	}
	set := domainSet(listed)
	over := make(map[string]bool)
	for _, l := range s.user {
		if bytes.HasPrefix(l.text, []byte(ShadowMarker)) {
			continue
		}
		for _, n := range overriddenNames(l.text, set) {
			over[n] = true
		}
	}
	if len(over) == 0 {
		return listed
	}
	out := make([]string, 0, len(listed))
	for _, dom := range listed {
		if !over[dom] {
			out = append(out, dom)
		}
	}
	return out
}

func domainSet(domains []string) map[string]bool {
	set := make(map[string]bool, len(domains))
	for _, dom := range domains {
		set[dom] = true
	}
	return set
}

// shadowLines returns user with every line that overrides one of domains
// commented out with ShadowMarker, and every line commented out earlier whose
// names are no longer all unblocked restored. The result is user itself when
// nothing changes. Resolvers that stop at the first matching line (the
// Windows DNS Client, Chromium's built-in resolver) would otherwise follow a
// user line such as "142.250.184.14 youtube.com" written above the section,
// and glibc with "multi on" merges the addresses of every matching line.
func shadowLines(user []line, domains []string) []line {
	var set map[string]bool
	if len(domains) > 0 {
		set = domainSet(domains)
	}
	var out []line
	for i, l := range user {
		text := l.text
		switch orig, marked := bytes.CutPrefix(l.text, []byte(ShadowMarker)); {
		case marked && len(overriddenNames(orig, set)) == 0:
			text = orig
		case !marked && len(overriddenNames(l.text, set)) > 0:
			text = append([]byte(ShadowMarker), l.text...)
		}
		if out == nil {
			if bytes.Equal(text, l.text) {
				continue
			}
			out = make([]line, len(user))
			copy(out, user[:i])
		}
		out[i] = line{text: text, eol: l.eol}
	}
	if out == nil {
		return user
	}
	return out
}

// overriddenNames returns the names of set that a hosts line maps to an
// address other than a sink: any parseable address except 0.0.0.0 and ::
// (loopback included, since a local proxy can serve the real site). Names
// compare case-insensitively and without a final dot, as resolvers do.
// Comments, blank lines and lines whose first field is not an address (which
// resolvers ignore) override nothing.
func overriddenNames(text []byte, set map[string]bool) []string {
	if len(set) == 0 {
		return nil
	}
	if i := bytes.IndexByte(text, '#'); i >= 0 {
		text = text[:i]
	}
	fields := bytes.Fields(text)
	if len(fields) < 2 {
		return nil
	}
	addr, err := netip.ParseAddr(string(fields[0]))
	if err != nil || addr.IsUnspecified() {
		return nil
	}
	var out []string
	for _, f := range fields[1:] {
		name := strings.TrimSuffix(strings.ToLower(string(f)), ".")
		if set[name] {
			out = append(out, name)
		}
	}
	return out
}
