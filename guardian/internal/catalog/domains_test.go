package catalog

import (
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
)

func TestNormalizeDomain(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		// The cases of packages/shared/test/catalog-helpers.test.ts.
		{"youtube.com", "youtube.com"},
		{"  YouTube.COM  ", "youtube.com"},
		{"https://www.youtube.com/watch?v=abc#t=1", "www.youtube.com"},
		{"http://m.youtube.com:8080/feed", "m.youtube.com"},
		{"www.tiktok.com/@user", "www.tiktok.com"},
		{"//reddit.com/r/spain", "reddit.com"},
		{"user:pass@instagram.com", "instagram.com"},
		{"example.com.", "example.com"},
		{"*.tiktok.com", "tiktok.com"},
		{".twitch.tv", "twitch.tv"},
		{"ñandú.es", "xn--and-6ma2c.es"},
		{"ＹＯＵＴＵＢＥ.com", "youtube.com"},
		{"bbc.co.uk", "bbc.co.uk"},
		{"xn--and-6ma2c.es", "xn--and-6ma2c.es"},
		// URL parsing details.
		{"HTTP://EXAMPLE.COM", "example.com"},
		{"ftp://files.example.org/x", "files.example.org"},
		{"wss://a.b.example.com:443", "a.b.example.com"},
		{"file://server.example.com/share", "server.example.com"},
		{"foo://example.com", "example.com"},
		{"ex%61mple.com", "example.com"},
		{"http://\\example.com\\x", "example.com"}, // backslashes are slashes in special URLs
		{"exam\tple.com", "example.com"},
		{u(0xFEFF) + "example.com" + u(0xA0), "example.com"},
		{"example" + u(0x3002) + "com", "example.com"},
		{"mailto:x@y.com", "y.com"},
		{"a@b@c.example.com", "c.example.com"},
		{"example.com:65535", "example.com"},
		{"example.com:", "example.com"},
		{"*.*.example.com", "example.com"},
		{"MÜNCHEN.DE", "xn--mnchen-3ya.de"},
		{"mu" + u(0x308) + "nchen.de", "xn--mnchen-3ya.de"},
		{"straße.de", "xn--strae-oqa.de"},
		{"пример.рф", "xn--e1afmkfd.xn--p1ai"},
		{"例え.jp", "xn--r8jz45g.jp"},
		{"İstanbul.com", "xn--istanbul-o0e.com"},
		{"soft" + u(0xAD) + "hyphen.com", "softhyphen.com"},
	} {
		got, ok := NormalizeDomain(tc.in)
		if !ok || got != tc.want {
			t.Errorf("NormalizeDomain(%q) = %q, %v; want %q", tc.in, got, ok, tc.want)
		}
	}
	for _, in := range []string{
		"", "   ", "localhost", "youtube", "127.0.0.1", "http://0x7f.1", "[::1]",
		"http://[2001:db8::1]/", "you tube.com", "foo_bar.com", "-foo.com", "example..com",
		"chrome://extensions", "file:///C:/Windows/System32/drivers/etc/hosts",
		"javascript:alert(1)", strings.Repeat("a", 64) + ".com", strings.Repeat("x", 3000),
		// Without "://" the scheme is not recognised, so "http:" becomes a host.
		"http:\\\\example.com",
		"FOO://Example.com", "example.com:99999", "example.com:abc", "user@", "ex%2561mple.com",
		"a%zz.com", "example.123", "1.2.3", "xn--a.com", "xn--.com", "www.xn--ña.com",
		"zero" + u(0x200B, 0x200D) + "width.com", u(0x1) + "example.com" + u(0x85),
		"http://a b.com", "http://a^b.com", "http://a%00b.com", "http://.",
		// Where TypeScript maps compatibility characters or checks the Bidi Rule, the Go
		// port fails instead of producing another domain.
		"ﬀ.com", "①.com", "עברית.co.il",
	} {
		if got, ok := NormalizeDomain(in); ok {
			t.Errorf("NormalizeDomain(%q) = %q, want failure", in, got)
		}
	}
}

func TestIsValidDomain(t *testing.T) {
	for _, d := range []string{"youtube.com", "youtubei.googleapis.com", "cloud.microsoft", "xn--and-6ma2c.es", "a.co", "xn--p1ai.xn--p1ai"} {
		if !IsValidDomain(d) {
			t.Errorf("IsValidDomain(%q) = false", d)
		}
	}
	for _, d := range []string{
		"", "YouTube.com", "youtube.com.", "https://youtube.com", "1.2.3.4", "com", "a-.com",
		strings.Repeat("a.", 126) + "com", "a.b1", "a.x", "ñ.es", "a..b", ".a.com", "a.xn--",
		"a." + strings.Repeat("a", 64), "a.xn--" + strings.Repeat("a", 60),
	} {
		if IsValidDomain(d) {
			t.Errorf("IsValidDomain(%q) = true", d)
		}
	}
}

func TestExpandDomainVariants(t *testing.T) {
	c := testCatalog(t)
	for _, tc := range []struct {
		in   string
		want []string
	}{
		{"example.com", []string{"example.com", "www.example.com"}},
		{"www.example.com", []string{"www.example.com", "example.com"}},
		{"https://Example.com/path", []string{"example.com", "www.example.com"}},
		{"bbc.co.uk", []string{"bbc.co.uk", "www.bbc.co.uk"}},
		{"www.bbc.co.uk", []string{"www.bbc.co.uk", "bbc.co.uk"}},
		{"m.example.com", []string{"m.example.com"}},
		{"news.bbc.co.uk", []string{"news.bbc.co.uk"}},
		{"educacion.gob.es", []string{"educacion.gob.es", "www.educacion.gob.es"}},
		{"www.com", []string{"www.com"}},
		{"not a domain", []string{}},
	} {
		got := c.ExpandDomainVariants(tc.in)
		if got == nil || !slices.Equal(got, tc.want) {
			t.Errorf("ExpandDomainVariants(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestIsSameOrSubdomain(t *testing.T) {
	for _, tc := range []struct {
		d, p string
		want bool
	}{
		{"a.com", "a.com", true},
		{"x.a.com", "a.com", true},
		{"xa.com", "a.com", false},
		{"a.com", "x.a.com", false},
	} {
		if got := IsSameOrSubdomain(tc.d, tc.p); got != tc.want {
			t.Errorf("IsSameOrSubdomain(%q, %q) = %v", tc.d, tc.p, got)
		}
	}
}

func TestIsDomainAllowedInWhitelist(t *testing.T) {
	whitelist := []string{"wikipedia.org", "docs.google.com", "https://www.deepl.com/translator"}
	for _, d := range []string{"wikipedia.org", "es.m.wikipedia.org", "https://docs.google.com/document/d/1", "www.deepl.com"} {
		if !IsDomainAllowedInWhitelist(d, whitelist, nil) {
			t.Errorf("%q not allowed", d)
		}
	}
	for _, d := range []string{"google.com", "drive.google.com", "notwikipedia.org", "wikipedia.org.evil.com", "deepl.com", "not a domain"} {
		if IsDomainAllowedInWhitelist(d, whitelist, nil) {
			t.Errorf("%q allowed", d)
		}
	}
	if IsDomainAllowedInWhitelist("wikipedia.org", nil, nil) {
		t.Error("an empty whitelist allows something")
	}
	patterns := []string{`^[a-z0-9-]+-docs\.googleusercontent\.com$`}
	for d, want := range map[string]bool{
		"doc-0s-8c-docs.googleusercontent.com":            true,
		"https://doc-0s-8c-docs.googleusercontent.com/x":  true,
		"googleusercontent.com":                           false,
		"yt3.googleusercontent.com":                       false,
		"a-docs.googleusercontent.com.evil.com":           false,
		"evil.com.doc-0s-docs.googleusercontent.com":      false,
		"https://a-docs.googleusercontent.com.evil.com/x": false,
	} {
		if got := IsDomainAllowedInWhitelist(d, nil, patterns); got != want {
			t.Errorf("IsDomainAllowedInWhitelist(%q, patterns) = %v, want %v", d, got, want)
		}
	}
}

func TestMatchesHostPattern(t *testing.T) {
	for _, tc := range []struct {
		host, pattern string
		want          bool
	}{
		{"lh3.google.com", `^lh[3-7]\.google\.com$`, true},
		{"lh8.google.com", `^lh[3-7]\.google\.com$`, false},
		{"lh3.google.com", `lh3`, false},               // unanchored
		{"lh3.google.com", `^lh3\.google\.com`, false}, // unanchored end
		{"lh3.google.com", `^(lh3$`, false},            // invalid
		{"lh3.google.com", `^(?=lh3).*$`, false},       // not RE2
		{"LH3.google.com", `^.*$`, false},              // not canonical
		{"not a host", `^.*$`, false},
	} {
		if got := MatchesHostPattern(tc.host, tc.pattern); got != tc.want {
			t.Errorf("MatchesHostPattern(%q, %q) = %v", tc.host, tc.pattern, got)
		}
	}
}

// The pattern cache is shared by every goroutine (run with -race).
func TestMatchesHostPatternConcurrent(t *testing.T) {
	var wg sync.WaitGroup
	for g := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range 200 {
				pattern := fmt.Sprintf(`^h%d\.example\.com$`, (g*200+i)%100)
				host := fmt.Sprintf("h%d.example.com", (g*200+i)%100)
				if !MatchesHostPattern(host, pattern) {
					t.Errorf("%q does not match %q", host, pattern)
					return
				}
			}
		}()
	}
	wg.Wait()
}

func FuzzNormalizeDomain(f *testing.F) {
	for _, s := range []string{"https://M.YouTube.com/watch?v=1", "*.tiktok.com", "ñandú.es.", "xn--and-6ma2c.es", "a@b:1/c", "[::1]", "ex%61mple.com", "ＹＯＵＴＵＢＥ.com"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, in string) {
		out, ok := NormalizeDomain(in)
		if !ok {
			if out != "" {
				t.Fatalf("failure with output %q", out)
			}
			return
		}
		if !IsValidDomain(out) {
			t.Fatalf("NormalizeDomain(%q) = %q, not canonical", in, out)
		}
		if again, ok := NormalizeDomain(out); !ok || again != out {
			t.Fatalf("NormalizeDomain not idempotent: %q → %q → %q (%v)", in, out, again, ok)
		}
	})
}
