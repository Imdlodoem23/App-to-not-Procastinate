package catalog

import (
	"regexp"
	"strings"
	"sync"
)

// Port of packages/shared/src/catalog/domains.ts.
//
// Canonical form: lowercase ASCII (IDNs in punycode), no scheme, path, port or trailing
// dot, at least two labels, letters-only (or xn--) top-level label. IP addresses are
// rejected: the hosts file maps names, and blocking an IP needs a firewall.

const (
	// maxDomainLength is the longest canonical domain (RFC 1035, without the root dot).
	maxDomainLength = 253
	// maxDomainInputLength bounds what NormalizeDomain parses, in UTF-16 code units.
	maxDomainInputLength = 2048
)

// IsValidDomain reports whether domain is already in canonical form: 1–253 characters,
// at least two labels of 1–63 lowercase letters, digits or inner hyphens, and a
// top-level label of 2–63 letters or an xn-- label.
func IsValidDomain(domain string) bool {
	if domain == "" || len(domain) > maxDomainLength || !isASCII(domain) {
		return false
	}
	labels := strings.Split(domain, ".")
	if len(labels) < 2 || !validTLD(labels[len(labels)-1]) {
		return false
	}
	for _, label := range labels {
		if !validLabel(label) {
			return false
		}
	}
	return true
}

// validLabel is LABEL_RE: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.
func validLabel(label string) bool {
	n := len(label)
	if n == 0 || n > 63 || label[0] == '-' || label[n-1] == '-' {
		return false
	}
	for i := 0; i < n; i++ {
		c := label[i]
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

// validTLD is TLD_RE: /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.
func validTLD(tld string) bool {
	if rest, ok := strings.CutPrefix(tld, "xn--"); ok && rest != "" && len(rest) <= 59 {
		for i := 0; i < len(rest); i++ {
			c := rest[i]
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
		return true
	}
	if len(tld) < 2 || len(tld) > 63 {
		return false
	}
	for i := 0; i < len(tld); i++ {
		if tld[i] < 'a' || tld[i] > 'z' {
			return false
		}
	}
	return true
}

// NormalizeDomain turns what a user types («https://M.YouTube.com/watch?v=1»,
// «*.tiktok.com», «ñandú.es.») into a canonical domain; ok is false when it is not a
// usable domain. Like normalizeDomain in TypeScript it takes the hostname the WHATWG URL
// parser finds (lowercased, without user info, port, path, query or fragment,
// percent-decoded, IDNs in punycode), drops a leading «*.» or «.» (the site itself) and
// one trailing dot, and requires the result to be canonical.
func NormalizeDomain(input string) (string, bool) {
	text := jsTrim(input)
	if text == "" || UTF16Len(text) > maxDomainInputLength {
		return "", false
	}
	host, ok := urlHostname(text)
	if !ok {
		return "", false
	}
	// /^(?:\*?\.)+/: «*.example.com» and «.example.com» mean the site itself.
	for {
		if rest, cut := strings.CutPrefix(host, "."); cut {
			host = rest
		} else if rest, cut := strings.CutPrefix(host, "*."); cut {
			host = rest
		} else {
			break
		}
	}
	host = strings.TrimSuffix(host, ".")
	if !IsValidDomain(host) {
		return "", false
	}
	return host, true
}

// canonical returns entry when it is already canonical, else its normalization.
func canonical(entry string) (string, bool) {
	if IsValidDomain(entry) {
		return entry, true
	}
	return NormalizeDomain(entry)
}

// IsSameOrSubdomain reports whether domain equals parent or is one of its subdomains
// (canonical inputs).
func IsSameOrSubdomain(domain, parent string) bool {
	return domain == parent || strings.HasSuffix(domain, "."+parent)
}

// isApex reports whether domain is a site's apex: two labels, or three under a
// multi-label public suffix (bbc.co.uk).
func (c *Catalog) isApex(domain string) bool {
	if !IsValidDomain(domain) {
		return false
	}
	labels := strings.Split(domain, ".")
	if len(labels) == 2 {
		return true
	}
	return len(labels) == 3 && c.IsPublicSuffixLike(labels[1]+"."+labels[2])
}

// ExpandDomainVariants returns the hosts to block for a custom domain. The hosts file
// has no wildcards, so an apex domain also gets its www. host and a www. host gets its
// apex: example.com → [example.com www.example.com]; www.example.com →
// [www.example.com example.com]; m.example.com → [m.example.com]. It returns an empty
// slice when the input is not a usable domain.
func (c *Catalog) ExpandDomainVariants(domain string) []string {
	normalized, ok := NormalizeDomain(domain)
	if !ok {
		return []string{}
	}
	if apex, isWWW := strings.CutPrefix(normalized, "www."); isWWW {
		if c.isApex(apex) {
			return []string{normalized, apex}
		}
		return []string{normalized}
	}
	if c.isApex(normalized) {
		return []string{normalized, "www." + normalized}
	}
	return []string{normalized}
}

// IsPublicSuffixLike reports whether domain (canonical) is exactly a multi-label public
// suffix such as co.uk or com.br (the catalog's multiLabelSuffixes): a whitelist entry
// like that would allow every site under it.
func (c *Catalog) IsPublicSuffixLike(domain string) bool {
	_, ok := c.multiLabel[domain]
	return ok
}

// maxPatternCache bounds the compiled host patterns kept (MAX_PATTERN_CACHE).
const maxPatternCache = 64

var patternCache struct {
	sync.Mutex
	m map[string]*regexp.Regexp // nil value: invalid or unanchored
}

// compileHostPattern compiles a host pattern once; invalid or unanchored patterns yield
// nil.
func compileHostPattern(pattern string) *regexp.Regexp {
	patternCache.Lock()
	defer patternCache.Unlock()
	if re, ok := patternCache.m[pattern]; ok {
		return re
	}
	var re *regexp.Regexp
	if strings.HasPrefix(pattern, "^") && strings.HasSuffix(pattern, "$") {
		re, _ = regexp.Compile(pattern)
	}
	if patternCache.m == nil || len(patternCache.m) >= maxPatternCache {
		patternCache.m = make(map[string]*regexp.Regexp)
	}
	patternCache.m[pattern] = re
	return re
}

// MatchesHostPattern reports whether the canonical host matches a whitelist host
// pattern: a regular expression anchored with ^…$ (see StudySite.HostPatterns). The
// patterns use RE2 syntax, which Go's regexp and the extension's regexFilter share;
// invalid or unanchored patterns match nothing.
func MatchesHostPattern(host, pattern string) bool {
	if !IsValidDomain(host) {
		return false
	}
	re := compileHostPattern(pattern)
	return re != nil && re.MatchString(host)
}

// IsDomainAllowedInWhitelist reports whether domain is allowed by whitelist: an entry
// allows itself and every subdomain (wikipedia.org allows es.m.wikipedia.org), and
// hostPatterns allow the hosts they match. Inputs are normalized, so URLs work too;
// invalid entries and patterns are ignored.
func IsDomainAllowedInWhitelist(domain string, whitelist, hostPatterns []string) bool {
	normalized, ok := NormalizeDomain(domain)
	if !ok {
		return false
	}
	for _, entry := range whitelist {
		if allowed, ok := canonical(entry); ok && IsSameOrSubdomain(normalized, allowed) {
			return true
		}
	}
	for _, pattern := range hostPatterns {
		if MatchesHostPattern(normalized, pattern) {
			return true
		}
	}
	return false
}
