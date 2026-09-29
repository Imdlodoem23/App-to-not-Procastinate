package procwatch

import (
	"runtime"
	"strings"
)

// Matcher decides which processes are blocked. Build it with NewMatcher from
// the catalog's process names for the current OS; the zero Matcher matches
// nothing. A Matcher is immutable and safe for concurrent use.
//
// Comparison rules (see matchKey): case-insensitive on Windows and macOS,
// exact on Linux; ".exe" optional on Windows ("Discord" matches
// "Discord.exe" and the other way round); ".app" optional on macOS, where the
// process's .app bundle name is tried too; on Linux the kernel task name
// (Process.Comm) and then the continuation of a cut task name in the
// command line (Process.CmdName) are tried after the executable name, and
// Process.Identity last. Protected processes
// (see IsProtected and ProtectDir) and system processes (Process.System)
// never match.
//
// Besides names, Match compares Process.Identity (what the executable file
// says it is, see OSLister) with the target names and with the identities
// added by WithIdentities, so a renamed copy of a blocked executable is still
// recognised on Windows and macOS (see the package documentation).
type Matcher struct {
	goos     string
	keys     map[string]string // matchKey → target name as given
	ids      map[string]string // lowercased identity → target
	names    []string
	rejected []string
}

// WithIdentities returns a copy of m that also matches processes whose
// Process.Identity equals a key of ids (case-insensitively), reporting the
// key's value as the target. The catalog passes the bundle ids of blocked
// macOS apps here ("com.hnc.Discord" → "Discord"), and it can pass Windows
// OriginalFilename values that differ from the executable names. Empty,
// over-long or non-printable identities and targets are skipped. The
// protection rules apply unchanged: an identity never protects.
func (m Matcher) WithIdentities(ids map[string]string) Matcher {
	out := m
	out.ids = make(map[string]string, len(m.ids)+len(ids))
	for k, v := range m.ids {
		out.ids[k] = v
	}
	for id, target := range ids {
		id, target = cleanIdentity(id), cleanIdentity(target)
		if id == "" || target == "" {
			continue
		}
		out.ids[strings.ToLower(id)] = target
	}
	return out
}

// NewMatcher builds a Matcher for the current OS.
func NewMatcher(names []string) Matcher { return NewMatcherFor(runtime.GOOS, names) }

// NewMatcherFor builds a Matcher that compares names the way goos does
// ("windows", "darwin", "linux"; anything else compares like Linux).
//
// Names are trimmed. Invalid names (empty, longer than 255 bytes, containing
// path separators, characters Windows forbids in file names or control
// characters) and protected names are skipped and reported by Rejected.
// Duplicates (under the comparison rules) are kept once.
func NewMatcherFor(goos string, names []string) Matcher {
	m := Matcher{goos: goos}
	for _, raw := range names {
		name := strings.TrimSpace(raw)
		key := matchKey(goos, name)
		if !validTargetName(name) || key == "" || IsProtected(name) {
			m.rejected = append(m.rejected, raw)
			continue
		}
		if _, dup := m.keys[key]; dup {
			continue
		}
		if m.keys == nil {
			m.keys = make(map[string]string)
		}
		m.keys[key] = name
		m.names = append(m.names, name)
	}
	return m
}

// Len returns the number of distinct targets.
func (m Matcher) Len() int { return len(m.names) }

// Empty reports whether the Matcher has no targets (no names and no
// identities).
func (m Matcher) Empty() bool { return len(m.names) == 0 && len(m.ids) == 0 }

// Names returns the accepted targets, trimmed, in input order.
func (m Matcher) Names() []string { return append([]string(nil), m.names...) }

// Rejected returns the input names that were skipped because they are invalid
// or protected, as given.
func (m Matcher) Rejected() []string { return append([]string(nil), m.rejected...) }

// Match reports whether p is blocked and, if so, which target it matched (as
// passed to NewMatcher, trimmed, or to WithIdentities). It tries p.Name, then
// p.Bundle, p.Comm, p.CmdName and p.Identity against the names, then
// p.Identity against the identities.
func (m Matcher) Match(p Process) (target string, ok bool) {
	if m.Empty() || processProtected(m.goos, p) {
		return "", false
	}
	for _, n := range [...]string{p.Name, p.Bundle, p.Comm, p.CmdName, p.Identity} {
		if n == "" {
			continue
		}
		if t, ok := m.keys[matchKey(m.goos, n)]; ok {
			return t, true
		}
	}
	if p.Identity != "" {
		if t, ok := m.ids[strings.ToLower(p.Identity)]; ok {
			return t, true
		}
	}
	return "", false
}

// MatchName is Match for a bare executable name.
func (m Matcher) MatchName(name string) (target string, ok bool) {
	if len(m.keys) == 0 || name == "" || IsProtected(name) {
		return "", false
	}
	t, ok := m.keys[matchKey(m.goos, name)]
	return t, ok
}
