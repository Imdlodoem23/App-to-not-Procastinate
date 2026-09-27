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
// command line (Process.CmdName) are tried after the executable name. Protected processes
// (see IsProtected and ProtectDir) and system processes (Process.System)
// never match.
//
// Matching is by file name only: a copy of a blocked executable under another
// name is not recognised (see the package documentation).
type Matcher struct {
	goos     string
	keys     map[string]string // matchKey → target name as given
	names    []string
	rejected []string
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

// Empty reports whether the Matcher has no targets.
func (m Matcher) Empty() bool { return len(m.names) == 0 }

// Names returns the accepted targets, trimmed, in input order.
func (m Matcher) Names() []string { return append([]string(nil), m.names...) }

// Rejected returns the input names that were skipped because they are invalid
// or protected, as given.
func (m Matcher) Rejected() []string { return append([]string(nil), m.rejected...) }

// Match reports whether p is blocked and, if so, which target it matched (as
// passed to NewMatcher, trimmed). It tries p.Name, then p.Bundle, p.Comm and
// p.CmdName.
func (m Matcher) Match(p Process) (target string, ok bool) {
	if len(m.keys) == 0 || processProtected(m.goos, p) {
		return "", false
	}
	for _, n := range [...]string{p.Name, p.Bundle, p.Comm, p.CmdName} {
		if n == "" {
			continue
		}
		if t, ok := m.keys[matchKey(m.goos, n)]; ok {
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
