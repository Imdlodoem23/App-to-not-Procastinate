package catalog

import (
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// UTF16Len returns the length of s in UTF-16 code units, the unit JavaScript's .length
// and every text limit of the API count (GUARDIAN_LIMITS): Σ over runes (r ≥ 0x10000 ?
// 2 : 1). A byte of invalid UTF-8 counts as one unit (it decodes to U+FFFD).
func UTF16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// compareUTF16 compares a and b in UTF-16 code unit order, the order of JavaScript's
// default Array.prototype.sort and of the < operator on strings. It differs from byte
// order only when one string has a character above U+FFFF where the other has one in
// U+E000..U+FFFF.
func compareUTF16(a, b string) int {
	for a != "" && b != "" {
		ra, na := utf8.DecodeRuneInString(a)
		rb, nb := utf8.DecodeRuneInString(b)
		a, b = a[na:], b[nb:]
		if ra == rb {
			continue
		}
		ha, la := utf16Units(ra)
		hb, lb := utf16Units(rb)
		if ha != hb {
			if ha < hb {
				return -1
			}
			return 1
		}
		if la < lb {
			return -1
		}
		return 1
	}
	switch {
	case a == "" && b == "":
		return 0
	case a == "":
		return -1
	}
	return 1
}

// utf16Units returns the UTF-16 code units of r: (r, 0) inside the BMP, or its surrogate
// pair.
func utf16Units(r rune) (rune, rune) {
	if r < 0x10000 {
		return r, 0
	}
	r -= 0x10000
	return 0xD800 + (r>>10)&0x3FF, 0xDC00 + r&0x3FF
}

// jsIsSpace reports whether r is removed by String.prototype.trim (WhiteSpace and
// LineTerminator of ECMA-262). Unlike unicode.IsSpace it includes U+FEFF and excludes
// U+0085.
func jsIsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F,
		0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// jsTrim is String.prototype.trim.
func jsTrim(s string) string { return strings.TrimFunc(s, jsIsSpace) }

// jsToLower is String.prototype.toLowerCase: Unicode simple lowercase mappings plus the
// two special cases JavaScript applies without a locale, İ (U+0130) → "i\u0307" and the final
// form of capital sigma.
func jsToLower(s string) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			ascii = false
			break
		}
	}
	if ascii {
		return strings.ToLower(s)
	}
	rs := []rune(s)
	var b strings.Builder
	b.Grow(len(s))
	for i, r := range rs {
		switch r {
		case 0x130:
			b.WriteString("i\u0307")
		case 0x3A3:
			if finalSigma(rs, i) {
				b.WriteRune(0x3C2)
			} else {
				b.WriteRune(0x3C3)
			}
		default:
			b.WriteRune(unicode.ToLower(r))
		}
	}
	return b.String()
}

// finalSigma is the Final_Sigma casing context of rs[i]: a cased letter before it and no
// cased letter after it, skipping case-ignorable characters on both sides.
func finalSigma(rs []rune, i int) bool {
	before := false
	for j := i - 1; j >= 0; j-- {
		if caseIgnorable(rs[j]) {
			continue
		}
		before = cased(rs[j])
		break
	}
	if !before {
		return false
	}
	for j := i + 1; j < len(rs); j++ {
		if caseIgnorable(rs[j]) {
			continue
		}
		return !cased(rs[j])
	}
	return true
}

func cased(r rune) bool {
	return unicode.IsUpper(r) || unicode.IsLower(r) || unicode.IsTitle(r) ||
		unicode.In(r, unicode.Other_Lowercase, unicode.Other_Uppercase)
}

func caseIgnorable(r rune) bool {
	switch r {
	case '\'', '.', ':', 0xB7, 0x387, 0x55F, 0x5F4, 0x2018, 0x2019, 0x2024, 0x2027, 0xFE13,
		0xFE52, 0xFE55, 0xFF07, 0xFF0E, 0xFF1A:
		return true
	}
	return unicode.In(r, unicode.Mn, unicode.Me, unicode.Cf, unicode.Lm, unicode.Sk)
}

// isOtherCategory reports whether r is in the Unicode general category C (\p{C} in a
// JavaScript regular expression): control, format, surrogate, private use or
// unassigned.
func isOtherCategory(r rune) bool {
	if unicode.In(r, unicode.C) {
		return true
	}
	return !unicode.In(r, unicode.L, unicode.M, unicode.N, unicode.P, unicode.S, unicode.Z)
}

// ---------------------------------------------------------------------------------------
// Canonical normalization (NFC, NFD) from the tables in normtable.go
// ---------------------------------------------------------------------------------------

// cccRange is a run of code points with the same non-zero canonical combining class.
type cccRange struct {
	lo, hi rune
	class  uint8
}

// combiningClass returns the canonical combining class of r (0 for starters).
func combiningClass(r rune) uint8 {
	if r < 0x300 {
		return 0
	}
	i, found := slices.BinarySearchFunc(combiningClasses, r, func(c cccRange, r rune) int {
		switch {
		case c.hi < r:
			return -1
		case c.lo > r:
			return 1
		}
		return 0
	})
	if !found {
		return 0
	}
	return combiningClasses[i].class
}

// composePairs is the inverse of canonicalPairs without the composition exclusions:
// (starter, next) → primary composite.
var composePairs = func() map[[2]rune]rune {
	m := make(map[[2]rune]rune, len(canonicalPairs))
	for c, pair := range canonicalPairs {
		if !compositionExclusions[c] {
			m[pair] = c
		}
	}
	return m
}()

// Hangul syllable composition (Unicode chapter 3.12), done algorithmically.
const (
	hangulSBase  = 0xAC00
	hangulLBase  = 0x1100
	hangulVBase  = 0x1161
	hangulTBase  = 0x11A7
	hangulLCount = 19
	hangulVCount = 21
	hangulTCount = 28
	hangulNCount = hangulVCount * hangulTCount
	hangulSCount = hangulLCount * hangulNCount
)

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

// appendDecomposed appends the full canonical decomposition of r.
func appendDecomposed(dst []rune, r rune) []rune {
	if r < 0xC0 {
		return append(dst, r)
	}
	if s := r - hangulSBase; s >= 0 && s < hangulSCount {
		dst = append(dst, hangulLBase+s/hangulNCount, hangulVBase+(s%hangulNCount)/hangulTCount)
		if t := s % hangulTCount; t != 0 {
			dst = append(dst, hangulTBase+t)
		}
		return dst
	}
	if pair, ok := canonicalPairs[r]; ok {
		dst = appendDecomposed(dst, pair[0])
		return append(dst, pair[1])
	}
	if single, ok := canonicalSingletons[r]; ok {
		return appendDecomposed(dst, single)
	}
	return append(dst, r)
}

// decompose returns the canonical decomposition of s (NFD): every character fully
// decomposed and every run of combining marks in canonical order.
func decompose(s string) []rune {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		out = appendDecomposed(out, r)
	}
	// Canonical ordering: a stable sort of each run of non-starters by combining class.
	for i := 0; i < len(out); {
		if combiningClass(out[i]) == 0 {
			i++
			continue
		}
		j := i
		for j < len(out) && combiningClass(out[j]) != 0 {
			j++
		}
		slices.SortStableFunc(out[i:j], func(a, b rune) int {
			return int(combiningClass(a)) - int(combiningClass(b))
		})
		i = j
	}
	return out
}

// composeHangul composes a leading jamo with a vowel jamo, or an LV syllable with a
// trailing jamo.
func composeHangul(a, b rune) (rune, bool) {
	if l, v := a-hangulLBase, b-hangulVBase; l >= 0 && l < hangulLCount && v >= 0 && v < hangulVCount {
		return hangulSBase + (l*hangulVCount+v)*hangulTCount, true
	}
	if s, t := a-hangulSBase, b-hangulTBase; s >= 0 && s < hangulSCount && s%hangulTCount == 0 &&
		t > 0 && t < hangulTCount {
		return a + t, true
	}
	return 0, false
}

// nfc returns s in Unicode Normalization Form C (String.prototype.normalize('NFC')).
func nfc(s string) string {
	if isASCII(s) {
		return s
	}
	rs := decompose(s)
	out := rs[:0]
	starter := -1
	lastClass := -1 // class of the last character kept after the starter; -1: none
	for _, r := range rs {
		class := int(combiningClass(r))
		if starter >= 0 && (lastClass == -1 || lastClass < class) {
			if c, ok := composeHangul(out[starter], r); ok && lastClass == -1 {
				out[starter] = c
				continue
			}
			if c, ok := composePairs[[2]rune{out[starter], r}]; ok {
				out[starter] = c
				continue
			}
		}
		if class == 0 {
			starter = len(out)
			lastClass = -1
		} else {
			lastClass = class
		}
		out = append(out, r)
	}
	return string(out)
}

// stripMarks is the canonical decomposition (NFD) of s without its combining marks
// (\p{M}), as protectedKey in processes.ts does: «Céntrate» → «Centrate».
func stripMarks(s string) string {
	if isASCII(s) {
		return s
	}
	rs := decompose(s)
	out := rs[:0]
	for _, r := range rs {
		if !unicode.Is(unicode.M, r) {
			out = append(out, r)
		}
	}
	return string(out)
}
