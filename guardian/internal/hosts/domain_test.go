package hosts

import (
	"errors"
	"slices"
	"strconv"
	"strings"
	"testing"
)

var invalidDomains = []string{
	"",
	" a.com",
	"a.com ",
	"*.example.com",
	"*",
	"1.2.3.4",
	"0.0.0.0",
	"::1",
	"[::1]",
	"2001:db8::1",
	"localhost",
	"LOCALHOST",
	"foo.localhost",
	"localhost.localdomain",
	"broadcasthost",
	"com",
	"a..com",
	".a.com",
	"a.com.",
	"-a.com",
	"a-.com",
	"a_b.com",
	"a b.com",
	"ñandú.com",
	"Kelvin.com", // Kelvin sign: strings.ToLower folds it to "k"
	"http://a.com",
	"a.com/path",
	"a.com:443",
	"user@a.com",
	"a.com#frag",
	"a.123",
	strings.Repeat("a", 64) + ".com",
	strings.Repeat("abcdefghi.", 25) + "com.xyz", // 257 bytes
	"a.com\n0.0.0.0 evil.com",
	"a.com\x00",
}

func TestValidateDomain(t *testing.T) {
	valid := map[string]string{
		"example.com":                     "example.com",
		"WWW.Example.COM":                 "www.example.com",
		"a-b.co.uk":                       "a-b.co.uk",
		"1password.com":                   "1password.com",
		"123.example":                     "123.example",
		"xn--bcher-kva.example":           "xn--bcher-kva.example",
		strings.Repeat("a", 63) + ".com":  strings.Repeat("a", 63) + ".com",
		"x.y":                             "x.y",
		"cdn-1.static.example-cdn.net":    "cdn-1.static.example-cdn.net",
		"s3.eu-west-1.amazonaws.com":      "s3.eu-west-1.amazonaws.com",
		"sub.domain.with.many.labels.org": "sub.domain.with.many.labels.org",
	}
	for in, want := range valid {
		got, err := ValidateDomain(in)
		if err != nil || got != want {
			t.Errorf("ValidateDomain(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range invalidDomains {
		got, err := ValidateDomain(in)
		var de *InvalidDomainError
		if !errors.As(err, &de) || got != "" {
			t.Errorf("ValidateDomain(%q) = %q, %v; want *InvalidDomainError", in, got, err)
			continue
		}
		if de.Index != -1 || de.Reason == "" {
			t.Errorf("ValidateDomain(%q): error %+v", in, de)
		}
	}
}

func TestNormalizeDomains(t *testing.T) {
	got, err := NormalizeDomains([]string{"b.com", "A.com", "B.COM", "a.com", "c.org"})
	if err != nil || !slices.Equal(got, []string{"a.com", "b.com", "c.org"}) {
		t.Fatalf("NormalizeDomains = %v, %v", got, err)
	}
	for _, in := range [][]string{nil, {}} {
		got, err := NormalizeDomains(in)
		if err != nil || got == nil || len(got) != 0 {
			t.Fatalf("NormalizeDomains(%#v) = %#v, %v; want empty non-nil", in, got, err)
		}
	}
	_, err = NormalizeDomains([]string{"a.com", "b.com", "*.c.com"})
	var de *InvalidDomainError
	if !errors.As(err, &de) || de.Index != 2 {
		t.Fatalf("NormalizeDomains error = %v", err)
	}
	if strings.Contains(err.Error(), "c.com") {
		t.Fatalf("error message leaks the domain: %q", err)
	}
}

func TestNormalizeDomainsLimit(t *testing.T) {
	many := make([]string, 0, MaxDomains+1)
	for i := range MaxDomains + 1 {
		many = append(many, "d"+strconv.Itoa(i)+".com")
	}
	if _, err := NormalizeDomains(many); !errors.Is(err, ErrTooManyDomains) {
		t.Fatalf("NormalizeDomains(%d) = %v, want ErrTooManyDomains", len(many), err)
	}
	// Duplicates do not count against the limit.
	dup := append(many[:MaxDomains:MaxDomains], many[0])
	if got, err := NormalizeDomains(dup); err != nil || len(got) != MaxDomains {
		t.Fatalf("NormalizeDomains with a duplicate = %d, %v", len(got), err)
	}
}
