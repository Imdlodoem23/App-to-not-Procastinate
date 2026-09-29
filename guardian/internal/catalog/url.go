package catalog

import (
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// This file ports what normalizeDomain (packages/shared/src/catalog/domains.ts) gets from
// `new URL(text).hostname`: the host of a WHATWG URL. Only what can end in a valid
// domain has to match exactly; every other input only has to fail, since the caller
// rejects any hostname that is not a canonical domain.

// hasURLScheme is SCHEME_RE of domains.ts: /^[a-z][a-z0-9+.-]*:\/\//i.
func hasURLScheme(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i] | 0x20 // ASCII lowercase for letters
		switch {
		case c >= 'a' && c <= 'z':
		case i > 0 && (s[i] >= '0' && s[i] <= '9' || s[i] == '+' || s[i] == '.' || s[i] == '-'):
		case i > 0 && s[i] == ':':
			return strings.HasPrefix(s[i+1:], "//")
		default:
			return false
		}
	}
	return false
}

// isSpecialScheme reports whether the WHATWG URL standard treats scheme as special.
func isSpecialScheme(scheme string) bool {
	switch scheme {
	case "http", "https", "ws", "wss", "ftp", "file":
		return true
	}
	return false
}

// forbiddenHostByte reports whether c is a forbidden host code point (ASCII).
func forbiddenHostByte(c byte) bool {
	switch c {
	case 0, '\t', '\n', '\r', ' ', '#', '/', ':', '<', '>', '?', '@', '[', '\\', ']', '^', '|':
		return true
	}
	return false
}

// forbiddenDomainByte reports whether c is a forbidden domain code point (ASCII).
func forbiddenDomainByte(c byte) bool {
	return forbiddenHostByte(c) || c <= 0x1F || c == '%' || c == 0x7F
}

// urlHostname returns what `new URL(hasURLScheme(text) ? text : "http://" + text).hostname`
// returns in a browser or Node.js, or ok = false when the URL constructor would throw.
// IPv6 literals and hosts that parse as IPv4 addresses are reported as failures too: they
// are never valid domains.
func urlHostname(text string) (string, bool) {
	input := text
	if !hasURLScheme(text) {
		input = "http://" + text
	}
	// The URL parser strips leading and trailing C0 controls and spaces, then removes
	// every tab and newline.
	input = strings.TrimFunc(input, func(r rune) bool { return r <= 0x20 })
	if strings.ContainsAny(input, "\t\n\r") {
		input = strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(input)
	}
	colon := strings.IndexByte(input, ':')
	if colon <= 0 || !hasURLScheme(input) {
		return "", false
	}
	scheme := strings.ToLower(input[:colon])
	rest := input[colon+1:]

	var authority string
	switch {
	case scheme == "file":
		// file: exactly two slashes (either kind) and then the host; no user info or port.
		for range 2 {
			if rest == "" || (rest[0] != '/' && rest[0] != '\\') {
				return "", false
			}
			rest = rest[1:]
		}
		if end := strings.IndexAny(rest, `/\?#`); end >= 0 {
			rest = rest[:end]
		}
		if rest == "" {
			return "", false
		}
		return parseSpecialHost(rest)
	case isSpecialScheme(scheme):
		// Special authority: any number of slashes or backslashes, then the authority up
		// to the next slash, backslash, "?" or "#".
		rest = strings.TrimLeft(rest, `/\`)
		authority = rest
		if end := strings.IndexAny(rest, `/\?#`); end >= 0 {
			authority = rest[:end]
		}
	default:
		rest = strings.TrimPrefix(rest, "//")
		authority = rest
		if end := strings.IndexAny(rest, "/?#"); end >= 0 {
			authority = rest[:end]
		}
	}
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		authority = authority[at+1:]
	}
	if strings.HasPrefix(authority, "[") {
		return "", false // IPv6 literal: never a domain
	}
	host := authority
	if c := strings.IndexByte(authority, ':'); c >= 0 {
		host = authority[:c]
		if !validPort(authority[c+1:]) {
			return "", false
		}
	}
	if isSpecialScheme(scheme) {
		if host == "" {
			return "", false
		}
		return parseSpecialHost(host)
	}
	// Opaque host (non-special scheme): kept as typed, without lowercasing. Anything the
	// parser would percent-encode or reject can never be a valid domain.
	for i := 0; i < len(host); i++ {
		c := host[i]
		if forbiddenHostByte(c) || c <= 0x1F || c >= 0x7F || c == '%' {
			return "", false
		}
	}
	return host, true
}

// validPort reports whether the text after the host's colon is an acceptable port:
// empty or ASCII digits up to 65535.
func validPort(port string) bool {
	if port == "" {
		return true
	}
	for i := 0; i < len(port); i++ {
		if port[i] < '0' || port[i] > '9' {
			return false
		}
	}
	trimmed := strings.TrimLeft(port, "0")
	if trimmed == "" {
		return true
	}
	if len(trimmed) > 5 {
		return false
	}
	n, err := strconv.Atoi(trimmed)
	return err == nil && n <= 65535
}

// parseSpecialHost is the WHATWG host parser for special schemes: percent-decoding,
// domain to ASCII, the forbidden domain code point check and the IPv4 detection.
func parseSpecialHost(host string) (string, bool) {
	ascii, ok := domainToASCII(percentDecode(host))
	if !ok || ascii == "" {
		return "", false
	}
	for i := 0; i < len(ascii); i++ {
		if forbiddenDomainByte(ascii[i]) {
			return "", false
		}
	}
	if endsInNumber(ascii) {
		return "", false // an IPv4 address, or a parse failure: never a domain
	}
	return ascii, true
}

// percentDecode decodes %XX escapes and leaves any other "%" as it is.
func percentDecode(s string) string {
	if !strings.Contains(s, "%") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]) {
			b.WriteByte(unhex(s[i+1])<<4 | unhex(s[i+2]))
			i += 2
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func isHex(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

func unhex(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	}
	return c - 'A' + 10
}

// endsInNumber is the WHATWG "ends in a number" checker: the last label (ignoring one
// trailing empty label) is all digits or a 0x hex number.
func endsInNumber(host string) bool {
	labels := strings.Split(host, ".")
	if labels[len(labels)-1] == "" {
		if len(labels) == 1 {
			return false
		}
		labels = labels[:len(labels)-1]
	}
	last := labels[len(labels)-1]
	if last != "" && strings.Trim(last, "0123456789") == "" {
		return true
	}
	if len(last) >= 2 && last[0] == '0' && (last[1] == 'x' || last[1] == 'X') {
		for i := 2; i < len(last); i++ {
			if !isHex(last[i]) {
				return false
			}
		}
		return true
	}
	return false
}

// domainToASCII is UTS #46 ToASCII as the URL standard calls it (no STD3 rules, no
// hyphen or DNS length checks, nontransitional), for the mappings described in the
// package documentation. ok is false where the URL parser would fail.
func domainToASCII(domain string) (string, bool) {
	if !utf8.ValidString(domain) {
		return "", false // decodes to U+FFFD, which UTS #46 disallows
	}
	if isASCII(domain) {
		lower := strings.ToLower(domain)
		if !strings.Contains(lower, "xn--") {
			return lower, true
		}
		for _, label := range strings.Split(lower, ".") {
			if strings.HasPrefix(label, "xn--") && !validACELabel(label) {
				return "", false
			}
		}
		return lower, true
	}
	var mapped strings.Builder
	mapped.Grow(len(domain))
	for _, r := range domain {
		switch {
		case r < utf8.RuneSelf:
			mapped.WriteRune(unicode.ToLower(r))
		case idnaIgnored(r):
		case r == 0x3002 || r == 0xFF0E || r == 0xFF61:
			mapped.WriteByte('.')
		case r >= 0xFF01 && r <= 0xFF5E: // full-width ASCII
			mapped.WriteRune(unicode.ToLower(r - 0xFEE0))
		case r == 0x130:
			mapped.WriteString("i\u0307")
		default:
			if idnaDisallowed(r) || unicode.Is(idnaUnmappable, r) || rightToLeft(r) {
				return "", false
			}
			mapped.WriteRune(unicode.ToLower(r))
		}
	}
	labels := strings.Split(nfc(mapped.String()), ".")
	for i, label := range labels {
		if isASCII(label) {
			if strings.HasPrefix(label, "xn--") && !validACELabel(label) {
				return "", false
			}
			continue
		}
		// A non-ASCII label may not look like an ACE label.
		rs := []rune(label)
		if strings.HasPrefix(label, "xn--") || !validUnicodeLabel(rs) {
			return "", false
		}
		encoded, ok := punyEncode(rs)
		if !ok {
			return "", false
		}
		labels[i] = "xn--" + encoded
	}
	return strings.Join(labels, "."), true
}

// validACELabel reports whether an ASCII "xn--" label decodes to a valid Unicode label
// that is already in the form domainToASCII would produce.
func validACELabel(label string) bool {
	rs, ok := punyDecode(label[len("xn--"):])
	if !ok || len(rs) == 0 || isASCII(string(rs)) || !validUnicodeLabel(rs) {
		return false
	}
	s := string(rs)
	for _, r := range rs {
		if idnaDisallowed(r) || unicode.Is(idnaUnmappable, r) || unicode.ToLower(r) != r {
			return false
		}
	}
	return nfc(s) == s
}

// rightToLeft reports whether r belongs to a block of right-to-left scripts (Hebrew,
// Arabic, Syriac, Thaana, NKo and the other RTL blocks, with their presentation forms).
// The Bidi Rule (RFC 5893) that UTS #46 applies to such domains needs the Bidi_Class
// tables of golang.org/x/text, so domainToASCII fails on them instead: never a domain
// TypeScript would refuse. Their canonical xn-- form is still accepted.
func rightToLeft(r rune) bool {
	return r >= 0x0590 && r <= 0x08FF || r >= 0xFB1D && r <= 0xFDFF ||
		r >= 0xFE70 && r <= 0xFEFF || r >= 0x10800 && r <= 0x10FFF ||
		r >= 0x1E800 && r <= 0x1EFFF
}

// validUnicodeLabel is the part of the UTS #46 validity criteria that applies here: the
// label must not begin with a combining mark.
func validUnicodeLabel(rs []rune) bool {
	return len(rs) > 0 && !unicode.Is(unicode.M, rs[0])
}

// idnaIgnored reports whether UTS #46 maps r to nothing (default ignorable characters:
// soft hyphen, zero-width space, word joiner, variation selectors, byte order mark…).
func idnaIgnored(r rune) bool {
	switch {
	case r == 0xAD, r == 0x34F, r == 0x200B, r == 0x2060, r == 0xFEFF:
		return true
	case r >= 0x180B && r <= 0x180D, r >= 0xFE00 && r <= 0xFE0F:
		return true
	}
	return false
}

// idnaDisallowed reports characters UTS #46 disallows or maps to disallowed ones:
// controls, format characters (including the joiners, which CheckJoiners rejects in
// almost every context), private use, unassigned code points, separators and U+FFFD.
func idnaDisallowed(r rune) bool {
	return r == utf8.RuneError || isOtherCategory(r) || unicode.In(r, unicode.Z)
}
