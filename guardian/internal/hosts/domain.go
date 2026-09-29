package hosts

import (
	"fmt"
	"net/netip"
	"regexp"
	"slices"
	"strings"
)

const (
	// MaxDomainLength is the longest hostname accepted, in bytes, without a
	// trailing dot (RFC 1035).
	MaxDomainLength = 253
	// MaxDomains caps how many distinct domains one section may hold. Each
	// domain costs two lines; 100 000 domains is a hosts file of about 5 MB.
	MaxDomains = 100_000
)

// ErrTooManyDomains is returned when more than MaxDomains distinct domains are
// passed to Apply, Verify or NormalizeDomains.
var ErrTooManyDomains = fmt.Errorf("hosts: more than %d domains", MaxDomains)

// hostnameRE is a lowercase ASCII hostname with at least two labels. Each label
// is 1–63 letters, digits or hyphens and neither starts nor ends with a hyphen.
// Underscores, wildcards, trailing dots, ports, paths and IDN (non-ASCII)
// characters are rejected; IDNs must be passed in their punycode (xn--) form.
var hostnameRE = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

// InvalidDomainError reports a domain rejected by ValidateDomain or
// NormalizeDomains. Its message never contains the domain itself, so it can be
// logged (see the privacy rules in internal/logx); callers that need to show
// the offending value to the user read the Domain field.
type InvalidDomainError struct {
	Index  int    // position in the input slice, or -1 for ValidateDomain
	Domain string // the rejected input, verbatim
	Reason string // short English reason
}

func (e *InvalidDomainError) Error() string {
	if e.Index < 0 {
		return "hosts: invalid domain: " + e.Reason
	}
	return fmt.Sprintf("hosts: invalid domain at index %d: %s", e.Index, e.Reason)
}

// ValidateDomain checks that s is a plain ASCII hostname that can be blocked
// through the hosts file and returns it lowercased. It rejects empty strings,
// surrounding whitespace, non-ASCII characters, wildcards, IP addresses,
// single-label names, a numeric top-level label, and loopback names
// (localhost, *.localhost, localhost.localdomain, broadcasthost).
func ValidateDomain(s string) (string, error) {
	d, reason := checkDomain(s)
	if reason != "" {
		return "", &InvalidDomainError{Index: -1, Domain: s, Reason: reason}
	}
	return d, nil
}

// NormalizeDomains validates every domain (see ValidateDomain), lowercases
// them, removes duplicates and sorts the result. The first invalid domain
// aborts the call with an *InvalidDomainError. An empty or nil input returns an
// empty, non-nil slice.
func NormalizeDomains(domains []string) ([]string, error) {
	out := make([]string, 0, len(domains))
	for i, s := range domains {
		d, reason := checkDomain(s)
		if reason != "" {
			return nil, &InvalidDomainError{Index: i, Domain: s, Reason: reason}
		}
		out = append(out, d)
	}
	slices.Sort(out)
	out = slices.Compact(out)
	if len(out) > MaxDomains {
		return nil, ErrTooManyDomains
	}
	return out, nil
}

// checkDomain returns the lowercased domain, or a non-empty rejection reason.
func checkDomain(s string) (string, string) {
	switch {
	case s == "":
		return "", "empty"
	case len(s) > MaxDomainLength:
		return "", "longer than 253 bytes"
	case strings.TrimSpace(s) != s:
		return "", "surrounding whitespace"
	case strings.ContainsRune(s, '*'):
		return "", "wildcards are not supported by the hosts file"
	}
	// Lowercase byte by byte: strings.ToLower would fold some non-ASCII runes
	// (the Kelvin sign, for one) into ASCII letters and let them through.
	b := make([]byte, len(s))
	for i := range len(s) {
		c := s[i]
		switch {
		case c >= 0x80:
			return "", "not ASCII (use the punycode form)"
		case c >= 'A' && c <= 'Z':
			c += 'a' - 'A'
		}
		b[i] = c
	}
	d := string(b)
	if _, err := netip.ParseAddr(strings.Trim(d, "[]")); err == nil {
		return "", "IP addresses are not allowed"
	}
	if isLoopbackName(d) {
		return "", "loopback names are not allowed"
	}
	if !strings.Contains(d, ".") {
		return "", "needs at least two labels"
	}
	if !hostnameRE.MatchString(d) {
		return "", "not a valid hostname"
	}
	tld := d[strings.LastIndexByte(d, '.')+1:]
	if strings.Trim(tld, "0123456789") == "" {
		return "", "numeric top-level label (IP-like)"
	}
	return d, ""
}

func isLoopbackName(d string) bool {
	switch d {
	case "localhost", "localhost.localdomain", "broadcasthost",
		"ip6-localhost", "ip6-loopback":
		return true
	}
	return strings.HasSuffix(d, ".localhost")
}
