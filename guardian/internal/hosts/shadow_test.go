package hosts

import (
	"os"
	"slices"
	"testing"
)

// Regression: user lines outside the section that map a blocked domain to a
// real address used to be kept and ignored by Verify and Current, so a line
// written above the section defeated the hosts layer for first-match
// resolvers without any tamper being noticed.
func TestShadowingUserLinesAreCommentedOutAndRestored(t *testing.T) {
	const shadow = "142.250.184.14 youtube.com www.youtube.com\r\n2a00:1450:4003:80e::200e m.youtube.com\r\n"
	m, path := newManager(t, []byte(windowsDefaultHosts))
	blocked := []string{"m.youtube.com", "www.youtube.com", "youtube.com"}
	mustApply(t, m, blocked...)

	// Someone prepends the shadowing lines (IPv4 and IPv6).
	if err := os.WriteFile(path, []byte(shadow+readString(t, path)), 0o644); err != nil {
		t.Fatal(err)
	}
	if ok, err := m.Verify(blocked); err != nil || ok {
		t.Fatalf("Verify = %v, %v; want false: the section is overridden", ok, err)
	}
	cur, err := m.Current()
	if err != nil || len(cur) != 0 {
		t.Fatalf("Current = %v, %v; want nothing effectively blocked", cur, err)
	}
	if h, _ := m.CurrentSectionHash(); h == SectionHash(blocked) {
		t.Fatal("CurrentSectionHash ignores the overriding lines")
	}

	mustApply(t, m, blocked...)
	want := ShadowMarker + "142.250.184.14 youtube.com www.youtube.com\r\n" +
		ShadowMarker + "2a00:1450:4003:80e::200e m.youtube.com\r\n" +
		windowsDefaultHosts + "\r\n" + section("\r\n", blocked...)
	if got := readString(t, path); got != want {
		t.Fatalf("after Apply:\n%q\nwant\n%q", got, want)
	}
	if ok, err := m.Verify(blocked); err != nil || !ok {
		t.Fatalf("Verify after Apply = %v, %v", ok, err)
	}
	if cur, _ := m.Current(); !slices.Equal(cur, blocked) {
		t.Fatalf("Current after Apply = %v", cur)
	}

	// Only youtube.com stays blocked: the IPv6 line naming m.youtube.com only
	// is restored, the line naming youtube.com stays commented out.
	mustApply(t, m, "youtube.com")
	want = ShadowMarker + "142.250.184.14 youtube.com www.youtube.com\r\n" +
		"2a00:1450:4003:80e::200e m.youtube.com\r\n" +
		windowsDefaultHosts + "\r\n" + section("\r\n", "youtube.com")
	if got := readString(t, path); got != want {
		t.Fatalf("after narrowing:\n%q\nwant\n%q", got, want)
	}

	if err := m.Remove(); err != nil {
		t.Fatal(err)
	}
	if got := readString(t, path); got != shadow+windowsDefaultHosts {
		t.Fatalf("after Remove: %q", got)
	}
}

func TestOverriddenNames(t *testing.T) {
	set := domainSet([]string{"a.com", "b.com"})
	cases := []struct {
		line string
		want []string
	}{
		{"1.2.3.4 a.com", []string{"a.com"}},
		{"1.2.3.4\tA.COM. x.org b.com", []string{"a.com", "b.com"}},
		{"127.0.0.1 a.com", []string{"a.com"}},
		{"::1 a.com # local", []string{"a.com"}},
		{"0.0.0.0 a.com", nil},
		{":: a.com", nil},
		{"# 1.2.3.4 a.com", nil},
		{"1.2.3.4 x.org # a.com", nil},
		{"notanip a.com", nil},
		{"1.2.3.4", nil},
		{"", nil},
	}
	for _, c := range cases {
		if got := overriddenNames([]byte(c.line), set); !slices.Equal(got, c.want) {
			t.Errorf("overriddenNames(%q) = %v, want %v", c.line, got, c.want)
		}
	}
	if got := overriddenNames([]byte("1.2.3.4 a.com"), nil); got != nil {
		t.Errorf("no blocked domains: %v", got)
	}
}

// A sink mapping of a blocked domain by the user is harmless and kept.
func TestSinkUserLinesAreKept(t *testing.T) {
	content := linuxHosts + "0.0.0.0 a.com\n"
	m, path := newManager(t, []byte(content))
	mustApply(t, m, "a.com")
	if got := readString(t, path); got != content+"\n"+section("\n", "a.com") {
		t.Fatalf("got %q", got)
	}
	if err := m.Remove(); err != nil {
		t.Fatal(err)
	}
	if got := readString(t, path); got != content {
		t.Fatalf("after Remove: %q", got)
	}
}
