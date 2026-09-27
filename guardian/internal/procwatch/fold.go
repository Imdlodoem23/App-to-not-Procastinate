package procwatch

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// The guardian avoids golang.org/x/text, so canonical equivalence is handled
// for Latin-1 letters only: each precomposed letter in U+00C0..U+00FF is
// replaced by its base letter and combining mark (its canonical
// decomposition). Applied to both sides of a comparison, "é" (U+00E9) and
// "e" + U+0301 (how macOS file names store it) end up equal. That covers
// Spanish and the other Western European languages the catalog uses.

// latin1Base and latin1Mark give the decomposition of U+00C0 + i; a zero mark
// means the character has none (Æ, Ð, ×, Ø, Þ, ß and their lowercase forms).
var latin1Base = []rune("AAAAAAÆCEEEEIIIIÐNOOOOO×ØUUUUYÞßaaaaaaæceeeeiiiiðnooooo÷øuuuuyþy")

var latin1Mark = [64]rune{
	0x300, 0x301, 0x302, 0x303, 0x308, 0x30A, 0, 0x327, 0x300, 0x301, 0x302, 0x308, 0x300, 0x301, 0x302, 0x308,
	0, 0x303, 0x300, 0x301, 0x302, 0x303, 0x308, 0, 0, 0x300, 0x301, 0x302, 0x308, 0x301, 0, 0,
	0x300, 0x301, 0x302, 0x303, 0x308, 0x30A, 0, 0x327, 0x300, 0x301, 0x302, 0x308, 0x300, 0x301, 0x302, 0x308,
	0, 0x303, 0x300, 0x301, 0x302, 0x303, 0x308, 0, 0, 0x300, 0x301, 0x302, 0x308, 0x301, 0, 0x308,
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

// decomposeLatin1 applies the canonical decomposition of Latin-1 letters.
func decomposeLatin1(s string) string {
	if isASCII(s) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s) + 8)
	for _, r := range s {
		if r >= 0xC0 && r <= 0xFF && latin1Mark[r-0xC0] != 0 {
			b.WriteRune(latin1Base[r-0xC0])
			b.WriteRune(latin1Mark[r-0xC0])
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// stripMarks removes combining diacritical marks (U+0300..U+036F).
func stripMarks(s string) string {
	if isASCII(s) {
		return s
	}
	return strings.Map(func(r rune) rune {
		if r >= 0x300 && r <= 0x36F {
			return -1
		}
		return r
	}, s)
}

// foldsCase reports whether process names are compared case-insensitively on
// goos (the default file systems of Windows and macOS ignore case).
func foldsCase(goos string) bool { return goos == "windows" || goos == "darwin" }

// matchKey is the key under which a target or process name is compared on
// goos: canonical Latin-1 decomposition; lowercase on Windows and macOS;
// without a trailing ".exe" on Windows and ".app" on macOS.
func matchKey(goos, name string) string {
	k := decomposeLatin1(name)
	if !foldsCase(goos) {
		return k
	}
	k = strings.ToLower(k)
	switch goos {
	case "windows":
		k = strings.TrimSuffix(k, ".exe")
	case "darwin":
		k = strings.TrimSuffix(k, ".app")
	}
	return k
}

// sameName reports whether two process names are the same executable on goos.
func sameName(goos, a, b string) bool { return matchKey(goos, a) == matchKey(goos, b) }

// denyKey is the key used for the hard deny-list on every OS: trimmed,
// lowercase, without accents and without a trailing ".exe" or ".app". It is
// deliberately looser than matchKey.
func denyKey(name string) string {
	k := strings.ToLower(stripMarks(decomposeLatin1(strings.TrimSpace(name))))
	k = strings.TrimSuffix(k, ".exe")
	k = strings.TrimSuffix(k, ".app")
	return strings.TrimSpace(k)
}

// validTargetName mirrors isValidProcessName in
// packages/shared/src/catalog/processes.ts: a plain file name of 1–255 bytes
// with no path separators, no characters Windows forbids in file names and no
// control, format or private-use characters.
func validTargetName(name string) bool {
	if name == "" || len(name) > 255 || name == "." || name == ".." || !utf8.ValidString(name) {
		return false
	}
	if strings.ContainsAny(name, `\/<>:"|?*`) {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) || unicode.In(r, unicode.Cf, unicode.Co, unicode.Cs) {
			return false
		}
	}
	return true
}

// baseName returns the last element of a slash- or backslash-separated path.
func baseName(path string) string {
	return path[strings.LastIndexAny(path, `/\`)+1:]
}
