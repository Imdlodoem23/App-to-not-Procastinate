package hosts

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

// SectionHeaderPrefix starts the line that records, inside the section, until
// when it must stay and how many domains it lists (docs/ARCHITECTURE.md
// §10.10):
//
//	# centrate-hosts v1 until=2026-09-27T17:42:00Z count=68
//
// until is the latest trusted endsAt among the active blocks (UTC, whole
// seconds, or milliseconds when it has them) and count the number of domains
// in the section. It lets the guardian keep enforcing when every state file
// is lost (§10.12: a recovered block with the section's domains until
// until).
const SectionHeaderPrefix = "# centrate-hosts v1"

// untilLayout and untilLayoutMs are the two forms of until the header writes.
const (
	untilLayout   = "2006-01-02T15:04:05Z"
	untilLayoutMs = "2006-01-02T15:04:05.000Z"
)

// ErrOverBudget is returned by Apply and ApplyUntil when the list holds more
// domains than SectionBudget. They never cut a list alphabetically; use
// ApplyPrioritized (or Prioritize) to drop entries by priority.
var ErrOverBudget = errors.New("hosts: more domains than the section budget (hostsMaxDomains)")

// SectionBudget is the most domains the section may hold: hostsMaxDomains
// from the generated contract data (guardian/internal/embedded).
func SectionBudget() int { return embedded.API().Limits.HostsMaxDomains }

// FormatSectionHeader returns the header line for until and count. until is
// written in UTC, truncated to the millisecond, as whole seconds when it has
// no milliseconds.
func FormatSectionHeader(until time.Time, count int) string {
	u := until.UTC().Truncate(time.Millisecond)
	layout := untilLayout
	if u.Nanosecond() != 0 {
		layout = untilLayoutMs
	}
	return SectionHeaderPrefix + " until=" + u.Format(layout) + " count=" + strconv.Itoa(max(count, 0))
}

// ParseSectionHeader parses a header line written by FormatSectionHeader.
// Surrounding white space is ignored; the prefix and version must match
// exactly; until (RFC 3339 in UTC, with a "Z") and count (a decimal between 0
// and MaxDomains, no leading zeros) must each appear once, in any order.
// Unknown key=value fields are ignored, so a later v1 writer may add some.
func ParseSectionHeader(line string) (until time.Time, count int, ok bool) {
	rest, found := strings.CutPrefix(strings.TrimSpace(line), SectionHeaderPrefix+" ")
	if !found {
		return time.Time{}, 0, false
	}
	haveUntil, haveCount := false, false
	for _, f := range strings.Fields(rest) {
		k, v, isKV := strings.Cut(f, "=")
		if !isKV || k == "" {
			return time.Time{}, 0, false
		}
		switch k {
		case "until":
			t, err := time.Parse(time.RFC3339Nano, v)
			if haveUntil || err != nil || !strings.HasSuffix(v, "Z") {
				return time.Time{}, 0, false
			}
			until, haveUntil = t.UTC(), true
		case "count":
			n, err := strconv.Atoi(v)
			if haveCount || err != nil || n < 0 || n > MaxDomains || strconv.Itoa(n) != v {
				return time.Time{}, 0, false
			}
			count, haveCount = n, true
		}
	}
	if !haveUntil || !haveCount {
		return time.Time{}, 0, false
	}
	return until, count, true
}

// isMetaLine reports whether text is a header line exactly as
// FormatSectionHeader writes it (the only form ever taken from beside a
// stray marker).
func isMetaLine(text []byte) bool {
	until, count, ok := ParseSectionHeader(string(text))
	return ok && FormatSectionHeader(until, count) == string(text)
}

// SectionHash returns the hex SHA-256 of a section's domain list: the
// domains lowercased, sorted, deduplicated and joined with "\n" (the hash of
// the empty string for no section). The header line is not part of it. The
// engine persists the hash of the last section written (Manager.
// LastSectionHash) and compares it with Manager.CurrentSectionHash at the
// next start (docs/ARCHITECTURE.md §10.12 step 9, hosts_changed_while_stopped).
func SectionHash(domains []string) string {
	list := make([]string, len(domains))
	for i, d := range domains {
		list[i] = strings.ToLower(d)
	}
	slices.Sort(list)
	list = slices.Compact(list)
	sum := sha256.Sum256([]byte(strings.Join(list, "\n")))
	return hex.EncodeToString(sum[:])
}

// Prioritize flattens groups, highest priority first, into at most limit
// distinct domains (validated and lowercased as NormalizeDomains does) and
// returns them sorted, with the number of distinct domains dropped. Within a
// group earlier domains win. The engine orders the groups as
// docs/ARCHITECTURE.md §10.10 says (punishment > exam > hardcore > strict >
// normal blocks, catalog before custom domains, older blocks first); nothing
// is ever dropped alphabetically. A limit below zero keeps nothing. The first
// invalid domain aborts with an *InvalidDomainError whose Index counts across
// the flattened groups.
func Prioritize(groups [][]string, limit int) ([]string, int, error) {
	seen := map[string]bool{}
	kept := []string{}
	dropped, index := 0, 0
	for _, g := range groups {
		for _, s := range g {
			d, reason := checkDomain(s)
			if reason != "" {
				return nil, 0, &InvalidDomainError{Index: index, Domain: s, Reason: reason}
			}
			index++
			if seen[d] {
				continue
			}
			seen[d] = true
			if len(kept) < limit {
				kept = append(kept, d)
			} else {
				dropped++
			}
		}
	}
	slices.Sort(kept)
	return kept, dropped, nil
}

// SectionInfo describes the Céntrate section of the file.
type SectionInfo struct {
	// Present: the file has a section (well-formed or repaired on read).
	Present bool
	// Domains are the valid domains listed, sorted and deduplicated; never nil.
	Domains []string
	// HasHeader: a header line was found; Until and Count come from it.
	HasHeader bool
	Until     time.Time
	Count     int
}

// Consistent reports whether the section has a header whose count matches
// the domains listed: someone deleting entries by hand breaks it.
func (s SectionInfo) Consistent() bool { return s.HasHeader && s.Count == len(s.Domains) }
