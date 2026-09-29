package catalog

import (
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"
)

// u builds a string from code points, so tests never depend on invisible characters in
// the source.
func u(cps ...rune) string { return string(cps) }

func TestUTF16Len(t *testing.T) {
	for _, tc := range []struct {
		s    string
		want int
	}{
		{"", 0},
		{"abc", 3},
		{"ñandú", 5},
		{u(0x1F600), 2},
		{"a" + u(0x1F600) + "b", 4},
		{u(0xFFFF), 1},
		{u(0x10000), 2},
		{"\xff", 1}, // invalid UTF-8 decodes to U+FFFD
	} {
		if got := UTF16Len(tc.s); got != tc.want {
			t.Errorf("UTF16Len(%q) = %d, want %d", tc.s, got, tc.want)
		}
	}
}

func TestCompareUTF16MatchesCodeUnitOrder(t *testing.T) {
	ref := func(a, b string) int {
		return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
	}
	// JavaScript sorts U+1F600 (a surrogate pair) before U+E000 and U+FFFD.
	list := []string{u(0xFFFD), u(0xE000), u(0x1F600), "a", "", "ab", u(0x10000) + "a"}
	slices.SortFunc(list, compareUTF16)
	want := []string{"", "a", "ab", u(0x10000) + "a", u(0x1F600), u(0xE000), u(0xFFFD)}
	if !slices.Equal(list, want) {
		t.Fatalf("sorted %q, want %q", list, want)
	}
	pool := []rune{'a', 'b', 0xE9, 0x7FF, 0xD7FF, 0xE000, 0xFFFD, 0x10000, 0x1F600, 0x10FFFF}
	r := rand.New(rand.NewPCG(1, 2))
	gen := func() string {
		rs := make([]rune, r.IntN(4))
		for i := range rs {
			rs[i] = pool[r.IntN(len(pool))]
		}
		return string(rs)
	}
	for range 5000 {
		a, b := gen(), gen()
		if got, want := compareUTF16(a, b), ref(a, b); got != want {
			t.Fatalf("compareUTF16(%q, %q) = %d, want %d", a, b, got, want)
		}
	}
}

func TestJSTrim(t *testing.T) {
	if got := jsTrim(u(0xFEFF, 0xA0, 0x3000, 0x2028) + " a b\t\n" + u(0x205F)); got != "a b" {
		t.Errorf("jsTrim = %q", got)
	}
	// U+0085 is not JavaScript white space (unlike unicode.IsSpace).
	if got := jsTrim(u(0x85) + "a"); got != u(0x85)+"a" {
		t.Errorf("jsTrim kept %q", got)
	}
	if got := jsTrim(u(0x1) + "a"); got != u(0x1)+"a" {
		t.Errorf("jsTrim removed a control character: %q", got)
	}
}

func TestJSToLower(t *testing.T) {
	sigma, final, small := u(0x3A3), u(0x3C2), u(0x3C3)
	for _, tc := range []struct{ in, want string }{
		{"", ""},
		{"Steam.EXE", "steam.exe"},
		{"ÑANDÚ", "ñandú"},
		{u(0x130), "i" + u(0x307)}, // İ → i + combining dot above
		{"ΟΔΟ" + sigma, "οδο" + final},
		{sigma, small},
		{"A" + sigma + "B", "a" + small + "b"},
		{"A" + sigma + ".", "a" + final + "."},
		{"A'" + sigma, "a'" + final}, // case-ignorable apostrophe before
		{"A" + sigma + u(0x301), "a" + final + u(0x301)},
		{"ẞ", "ß"},
		{"Ⅻ", "ⅻ"},
	} {
		if got := jsToLower(tc.in); got != tc.want {
			t.Errorf("jsToLower(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestNFC(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"abc", "abc"},
		{"e" + u(0x301), "é"},
		{"Ce" + u(0x301) + "ntrate", "Céntrate"},
		{"e" + u(0x323, 0x302), u(0x1EC7)},      // ệ
		{"e" + u(0x302, 0x323), u(0x1EC7)},      // marks in the other order
		{"u" + u(0x308, 0x301), u(0x1D8)},       // ǘ, two levels
		{u(0x1112, 0x1161, 0x11AB), u(0xD55C)},  // 한 from jamo
		{u(0xD55C), u(0xD55C)},                  // already composed
		{u(0x304B, 0x3099), u(0x304C)},          // か + dakuten → が
		{u(0x212B), u(0xC5)},                    // Angstrom sign → Å (singleton)
		{u(0x958), u(0x915, 0x93C)},             // composition exclusion stays decomposed
		{"q" + u(0x301), "q" + u(0x301)},        // no precomposed q́
		{u(0x3B1, 0x313, 0x345), u(0x1F80)},     // ᾀ
		{"a" + u(0x301, 0x301), u(0xE1, 0x301)}, // the second mark is blocked
		{u(0x301) + "e", u(0x301) + "e"},        // no starter before the mark
		{"e" + u(0x334, 0x301), u(0xE9, 0x334)}, // a lower class in between does not block
	} {
		if got := nfc(tc.in); got != tc.want {
			t.Errorf("nfc(%U) = %U, want %U", []rune(tc.in), []rune(got), []rune(tc.want))
		}
	}
	// Idempotence on random input.
	r := rand.New(rand.NewPCG(3, 4))
	pool := []rune{'a', 'e', 'u', 0x3B1, 0x915, 0x1112, 0x1161, 0x11AB, 0x304B, 0x301, 0x302,
		0x308, 0x323, 0x313, 0x345, 0x3099, 0x93C, 0x334, 0xC5, 0x1EC7}
	for range 5000 {
		rs := make([]rune, 1+r.IntN(6))
		for i := range rs {
			rs[i] = pool[r.IntN(len(pool))]
		}
		once := nfc(string(rs))
		if twice := nfc(once); twice != once {
			t.Fatalf("nfc not idempotent on %U: %U then %U", rs, []rune(once), []rune(twice))
		}
		if d := string(decompose(once)); d != string(decompose(string(rs))) {
			t.Fatalf("nfc changed the canonical decomposition of %U", rs)
		}
	}
}

func TestStripMarks(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"Céntrate", "Centrate"},
		{"Ce" + u(0x301) + "ntrate", "Centrate"},
		{"ÑANDÚ", "NANDU"},
		{u(0xD55C), u(0x1112, 0x1161, 0x11AB)}, // NFD splits Hangul into letters (not marks)
		{"plain", "plain"},
	} {
		if got := stripMarks(tc.in); got != tc.want {
			t.Errorf("stripMarks(%q) = %U, want %U", tc.in, []rune(got), []rune(tc.want))
		}
	}
}

func TestNormTables(t *testing.T) {
	for c, pair := range canonicalPairs {
		if compositionExclusions[c] {
			continue
		}
		if got := composePairs[pair]; got != c {
			t.Errorf("%U: pair %U composes to %U", c, pair, got)
		}
		if got := nfc(u(pair[0], pair[1])); got != u(c) && combiningClass(pair[1]) != 0 {
			t.Errorf("nfc(%U) = %U, want %U", pair, []rune(got), c)
		}
	}
	for c := range compositionExclusions {
		if _, ok := canonicalPairs[c]; !ok {
			t.Errorf("exclusion %U is not a canonical pair", c)
		}
	}
	for c, target := range canonicalSingletons {
		if nfc(u(c)) == u(c) {
			t.Errorf("singleton %U (→ %U) survives nfc", c, target)
		}
	}
	if !slices.IsSortedFunc(combiningClasses, func(a, b cccRange) int { return int(a.lo - b.lo) }) {
		t.Fatal("combiningClasses is not sorted")
	}
	for i, r := range combiningClasses {
		if r.lo > r.hi || r.class == 0 || (i > 0 && combiningClasses[i-1].hi >= r.lo) {
			t.Fatalf("bad combining class range %+v", r)
		}
	}
	for _, tc := range []struct {
		r    rune
		want uint8
	}{{'a', 0}, {0x301, 230}, {0x323, 220}, {0x334, 1}, {0x345, 240}, {0x3099, 8}, {0x93C, 7}} {
		if got := combiningClass(tc.r); got != tc.want {
			t.Errorf("combiningClass(%U) = %d, want %d", tc.r, got, tc.want)
		}
	}
}

func TestPunycode(t *testing.T) {
	for _, tc := range []struct{ label, ace string }{
		{"bücher", "bcher-kva"},
		{"münchen", "mnchen-3ya"},
		{"ñandú", "and-6ma2c"},
		{"例え", "r8jz45g"},
		{"пример", "e1afmkfd"},
	} {
		got, ok := punyEncode([]rune(tc.label))
		if !ok || got != tc.ace {
			t.Errorf("punyEncode(%q) = %q, %v; want %q", tc.label, got, ok, tc.ace)
		}
		back, ok := punyDecode(tc.ace)
		if !ok || string(back) != tc.label {
			t.Errorf("punyDecode(%q) = %q, %v; want %q", tc.ace, string(back), ok, tc.label)
		}
	}
	for _, bad := range []string{"99999999999999", "ü-abc", "abc-!", "zzzzzzzzzzzzzzzzzzzzzzzzz", strings.Repeat("a", 300)} {
		if rs, ok := punyDecode(bad); ok && len(rs) > 0 && rs[len(rs)-1] > 0x10FFFF {
			t.Errorf("punyDecode(%q) produced an invalid rune", bad)
		}
	}
	if _, ok := punyDecode("99999999999999"); ok {
		t.Error("punyDecode accepted an overflowing delta")
	}
	if _, ok := punyEncode(make([]rune, 300)); ok {
		t.Error("punyEncode accepted a label longer than any DNS label")
	}
}

func FuzzPunycodeRoundTrip(f *testing.F) {
	for _, s := range []string{"bücher", "例え", "a", "ñandú-2", u(0x1F600)} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		rs := []rune(s)
		enc, ok := punyEncode(rs)
		if !ok || len(enc) > punyMaxInput {
			return // longer than any DNS label: punyDecode refuses it by design
		}
		dec, ok := punyDecode(enc)
		if !ok || !slices.Equal(dec, rs) {
			t.Fatalf("round trip of %q: %q → %q (%v)", s, enc, string(dec), ok)
		}
	})
}
