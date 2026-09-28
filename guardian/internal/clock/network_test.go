package clock

import (
	"context"
	"crypto/x509"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// reply describes what a fake time server answers.
type reply struct {
	date  string // Date header; "" suppresses it
	age   string // Age header; "" omits it
	trace string // body served at /cdn-cgi/trace (GET only)
}

// timeServer answers every request as r says. Every httptest TLS server uses
// the same certificate, so the client of any of them trusts all of them.
func timeServer(t *testing.T, r reply) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if ua := req.Header.Get("User-Agent"); ua != "centrate-guardian" {
			t.Errorf("User-Agent = %q", ua)
		}
		if r.date == "" {
			w.Header()["Date"] = nil
		} else {
			w.Header().Set("Date", r.date)
		}
		if r.age != "" {
			w.Header().Set("Age", r.age)
		}
		if req.URL.Path == "/cdn-cgi/trace" {
			if req.Method != http.MethodGet {
				t.Errorf("trace method = %s, want GET", req.Method)
			}
			_, _ = w.Write([]byte(r.trace))
			return
		}
		if req.Method != http.MethodHead {
			t.Errorf("method = %s, want HEAD", req.Method)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0) // rejected handshakes are expected in some tests
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv
}

func dateReply(d time.Time) reply { return reply{date: d.UTC().Format(http.TimeFormat)} }

func testClient(srv *httptest.Server) *http.Client {
	c := srv.Client()
	c.Timeout = 2 * time.Second
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return c
}

func dateSources(srvs ...*httptest.Server) []timeSource {
	var out []timeSource
	for _, s := range srvs {
		out = append(out, timeSource{url: s.URL + "/"})
	}
	return out
}

func traceSource(srv *httptest.Server) timeSource {
	return timeSource{url: srv.URL + "/cdn-cgi/trace", trace: true}
}

// assertAbout checks that got lies in [want+lo, want+hi].
func assertAbout(t *testing.T, got time.Time, ok bool, want time.Time, lo, hi time.Duration) {
	t.Helper()
	if !ok {
		t.Fatal("ok = false, want a time")
	}
	if d := got.Sub(want); d < lo || d > hi {
		t.Fatalf("got %v, want %v plus between %v and %v (off by %v)", got, want, lo, hi, d)
	}
	if got.Location() != time.UTC {
		t.Fatalf("location = %v, want UTC", got.Location())
	}
}

func TestNetworkTimeReadsDateHeader(t *testing.T) {
	want := time.Date(2030, time.March, 4, 5, 6, 7, 0, time.UTC)
	a, b := timeServer(t, dateReply(want)), timeServer(t, dateReply(want))
	got, ok := networkTime(context.Background(), testClient(a), dateSources(a, b))
	// Middle of the Date second, plus half a round trip and the time since.
	assertAbout(t, got, ok, want, 500*time.Millisecond, 2*time.Second)
}

// One answer alone is never trusted: a cached or wrong server would move
// the trusted clock on its own.
func TestNetworkTimeNeedsTwoAnswers(t *testing.T) {
	srv := timeServer(t, dateReply(time.Now()))
	if got, ok := networkTime(context.Background(), testClient(srv), dateSources(srv)); ok {
		t.Fatalf("got %v from a single answer, want ok = false", got)
	}
}

func TestNetworkTimeRejectsDisagreement(t *testing.T) {
	want := time.Date(2031, time.May, 6, 7, 8, 9, 0, time.UTC)
	good1 := timeServer(t, dateReply(want))
	stale := timeServer(t, dateReply(want.Add(-5*time.Minute)))
	good2 := timeServer(t, dateReply(want))
	c := testClient(good1)

	if got, ok := networkTime(context.Background(), c, dateSources(good1, stale)); ok {
		t.Fatalf("two answers 5 min apart gave %v, want ok = false", got)
	}
	// A third answer that agrees with the first settles it; the stale one is
	// left out of the median.
	got, ok := networkTime(context.Background(), c, dateSources(good1, stale, good2))
	assertAbout(t, got, ok, want, 500*time.Millisecond, 2*time.Second)
}

func TestNetworkTimeAgreementWindow(t *testing.T) {
	base := time.Date(2032, time.January, 1, 0, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		apart time.Duration
		ok    bool
	}{{2 * time.Second, true}, {5 * time.Second, false}} {
		a := timeServer(t, dateReply(base))
		b := timeServer(t, dateReply(base.Add(c.apart)))
		got, ok := networkTime(context.Background(), testClient(a), dateSources(a, b))
		if ok != c.ok {
			t.Fatalf("answers %v apart: ok = %v, want %v", c.apart, ok, c.ok)
		}
		if ok { // median of two: the midpoint
			assertAbout(t, got, ok, base.Add(c.apart/2), 500*time.Millisecond, 2*time.Second)
		}
	}
}

// A CDN cache may serve the origin's old Date with an Age header; without
// adding Age the trusted clock would be moved back and blocks would end later
// than promised.
func TestNetworkTimeAddsAgeHeader(t *testing.T) {
	want := time.Date(2030, time.July, 1, 12, 0, 0, 0, time.UTC)
	cached := timeServer(t, reply{date: want.Add(-10 * time.Minute).Format(http.TimeFormat), age: "600"})
	fresh := timeServer(t, dateReply(want))
	got, ok := networkTime(context.Background(), testClient(fresh), dateSources(cached, fresh))
	assertAbout(t, got, ok, want, 500*time.Millisecond, 2*time.Second)
}

func TestNetworkTimeIgnoresBadAgeHeader(t *testing.T) {
	want := time.Date(2030, time.July, 1, 12, 0, 0, 0, time.UTC)
	for _, age := range []string{"abc", "-5", "1.5", "86401", "99999999999"} {
		bad := timeServer(t, reply{date: want.Format(http.TimeFormat), age: age})
		good := timeServer(t, dateReply(want))
		c := testClient(good)
		if got, ok := networkTime(context.Background(), c, dateSources(bad, good)); ok {
			t.Fatalf("Age %q: got %v, want the answer ignored and ok = false", age, got)
		}
		got, ok := networkTime(context.Background(), c, dateSources(bad, good, good))
		assertAbout(t, got, ok, want, 500*time.Millisecond, 2*time.Second)
	}
}

func TestNetworkTimeReadsTraceTimestamp(t *testing.T) {
	want := time.Unix(1_900_000_000, 250_000_000).UTC()
	body := "fl=123abc\nh=1.1.1.1\nip=192.0.2.1\nts=1900000000.250\nvisit_scheme=https\n"
	// The Date header is an hour off: the trace timestamp must win.
	r := reply{date: want.Add(-time.Hour).Format(http.TimeFormat), trace: body}
	a, b := timeServer(t, r), timeServer(t, r)
	got, ok := networkTime(context.Background(), testClient(a), []timeSource{traceSource(a), traceSource(b)})
	assertAbout(t, got, ok, want, 0, time.Second)
}

func TestNetworkTimeTraceFallsBackToDate(t *testing.T) {
	want := time.Date(2033, time.February, 3, 4, 5, 6, 0, time.UTC)
	for _, body := range []string{"fl=1\nh=1.1.1.1\n", "ts=not-a-number\n", "ts=1.2.3\n"} {
		r := reply{date: want.Format(http.TimeFormat), trace: body}
		a := timeServer(t, r)
		got, ok := networkTime(context.Background(), testClient(a), []timeSource{traceSource(a), traceSource(a)})
		assertAbout(t, got, ok, want, 500*time.Millisecond, 2*time.Second)
	}
}

func TestNetworkTimeSkipsFailingSources(t *testing.T) {
	want := time.Date(2031, time.January, 2, 3, 4, 5, 0, time.UTC)
	good := timeServer(t, dateReply(want))
	noDate := timeServer(t, reply{})
	// The malformed URL fails before any connection; the second server answers
	// without a Date.
	sources := append([]timeSource{{url: "https://bad host/"}}, dateSources(noDate, good, good)...)
	got, ok := networkTime(context.Background(), testClient(good), sources)
	assertAbout(t, got, ok, want, 500*time.Millisecond, 2*time.Second)
}

func TestNetworkTimeRejectsBadDates(t *testing.T) {
	for _, date := range []string{"", "not a date", "Mon, 01 Jan 1990 00:00:00 GMT"} {
		srv := timeServer(t, reply{date: date})
		if got, ok := networkTime(context.Background(), testClient(srv), dateSources(srv, srv)); ok {
			t.Errorf("Date %q: got %v, want ok = false", date, got)
		}
	}
}

func TestNetworkTimeHonoursContext(t *testing.T) {
	srv := timeServer(t, dateReply(time.Now()))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, ok := networkTime(ctx, testClient(srv), dateSources(srv, srv)); ok {
		t.Fatal("a cancelled context must give ok = false")
	}
}

func TestNetworkTimeDoesNotFollowRedirects(t *testing.T) {
	want := time.Date(2032, time.June, 1, 0, 0, 0, 0, time.UTC)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			t.Errorf("redirect followed to %s", r.URL.Path)
		}
		w.Header().Set("Date", want.Format(http.TimeFormat))
		http.Redirect(w, r, "/elsewhere", http.StatusFound)
	}))
	t.Cleanup(srv.Close)
	got, ok := networkTime(context.Background(), testClient(srv), dateSources(srv, srv))
	assertAbout(t, got, ok, want, 500*time.Millisecond, 2*time.Second)
}

// Certificates are checked at the trusted time, not at the wall clock: with
// a wall clock moved decades ahead they would all look expired.
func TestNetworkTimeVerifiesCertificatesAtTrustedNow(t *testing.T) {
	want := time.Date(2030, time.March, 4, 5, 6, 7, 0, time.UTC)
	srv := timeServer(t, dateReply(want))
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate()) // the httptest certificate expires in 2084
	sources := dateSources(srv, srv)

	c := newNetworkClient(func() time.Time { return want }, roots)
	got, ok := networkTime(context.Background(), c, sources)
	assertAbout(t, got, ok, want, 500*time.Millisecond, 2*time.Second)

	late := newNetworkClient(func() time.Time { return time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC) }, roots)
	if got, ok := networkTime(context.Background(), late, sources); ok {
		t.Fatalf("certificate accepted after it expired at the trusted time: %v", got)
	}
	// Unknown roots are rejected too (the system roots do not know httptest).
	if got, ok := networkTime(context.Background(), newNetworkClient(nil, x509.NewCertPool()), sources); ok {
		t.Fatalf("untrusted certificate accepted: %v", got)
	}
}

// The sources are fixed HTTPS URLs, and the IP literals come first so that
// neither DNS nor the hosts file can turn the check off.
func TestNetworkTimeSourcesAreFixed(t *testing.T) {
	if len(networkTimeSources) < minAgreeing {
		t.Fatal("not enough sources configured")
	}
	literals, sawHostname := 0, false
	for _, s := range networkTimeSources {
		u, err := url.Parse(s.url)
		if err != nil || u.Scheme != "https" {
			t.Fatalf("%s is not an HTTPS URL", s.url)
		}
		if net.ParseIP(u.Hostname()) != nil {
			if sawHostname {
				t.Errorf("IP literal %s comes after a hostname", s.url)
			}
			literals++
		} else {
			sawHostname = true
		}
		if s.trace != strings.HasSuffix(u.Path, "/cdn-cgi/trace") {
			t.Errorf("%s: trace = %v", s.url, s.trace)
		}
	}
	if literals < minAgreeing {
		t.Fatalf("%d IP-literal sources, want at least %d", literals, minAgreeing)
	}
	c := newNetworkClient(nil, nil)
	if c.Timeout <= 0 || c.CheckRedirect == nil {
		t.Fatal("client must have a timeout and must not follow redirects")
	}
}

func TestAgreed(t *testing.T) {
	now := time.Now()
	base := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	at := func(offsets ...time.Duration) []answer {
		var out []answer
		for _, o := range offsets {
			out = append(out, answer{server: base.Add(o), local: now})
		}
		return out
	}
	cases := []struct {
		name    string
		answers []answer
		want    time.Duration
		ok      bool
	}{
		{"none", nil, 0, false},
		{"one", at(0), 0, false},
		{"two agree", at(0, 2*time.Second), time.Second, true},
		{"exactly the spread", at(0, maxSpread), maxSpread / 2, true},
		{"just above the spread", at(0, maxSpread+time.Millisecond), 0, false},
		{"odd group median", at(0, time.Second, 3*time.Second), time.Second, true},
		{"outlier left out", at(-time.Hour, 0, time.Second), 500 * time.Millisecond, true},
		{"largest group wins", at(0, time.Second, time.Minute, time.Minute+time.Second, time.Minute+2*time.Second), time.Minute + time.Second, true},
	}
	for _, c := range cases {
		got, n, ok := agreed(c.answers, now)
		if ok != c.ok || (ok && !got.Equal(base.Add(c.want))) || (ok && n < minAgreeing) {
			t.Errorf("%s: got %v, %v; want %v, %v", c.name, got, ok, base.Add(c.want), c.ok)
		}
	}
	// Answers taken at different moments are projected to the same instant.
	later := []answer{{server: base, local: now}, {server: base.Add(10 * time.Second), local: now.Add(10 * time.Second)}}
	if got, n, ok := agreed(later, now.Add(10*time.Second)); !ok || n != 2 || !got.Equal(base.Add(10*time.Second)) {
		t.Errorf("projection: got %v, %v", got, ok)
	}
}

func TestTraceTime(t *testing.T) {
	cases := map[string]time.Time{
		"ts=1700000000.123\n":           time.Unix(1_700_000_000, 123_000_000),
		"a=b\nts=1700000000\nc=d\n":     time.Unix(1_700_000_000, 0),
		"  ts=1700000000.5  \r\n":       time.Unix(1_700_000_000, 500_000_000),
		"ts=1700000000.123456789\n":     time.Unix(1_700_000_000, 123_456_789),
		"ts=\n":                         {},
		"ts=abc\n":                      {},
		"ts=-5\n":                       {},
		"ts=1.2.3\n":                    {},
		"ts=1700000000.1234567890\n":    {},
		"ts=999999999999\n":             {},
		"no timestamp here\n":           {},
		"":                              {},
		"xts=1700000000\nts=nonsense\n": {},
	}
	for body, want := range cases {
		got, ok := traceTime([]byte(body))
		if ok != !want.IsZero() || (ok && !got.Equal(want)) {
			t.Errorf("traceTime(%q) = %v, %v; want %v", body, got, ok, want)
		}
	}
}

func TestAgeHeader(t *testing.T) {
	cases := []struct {
		v    string
		want time.Duration
		ok   bool
	}{
		{"", 0, true},
		{"0", 0, true},
		{" 42 ", 42 * time.Second, true},
		{"86400", 24 * time.Hour, true},
		{"86401", 0, false},
		{"-1", 0, false},
		{"1e3", 0, false},
		{"12345678901", 0, false},
	}
	for _, c := range cases {
		h := http.Header{}
		if c.v != "" {
			h.Set("Age", c.v)
		}
		got, ok := ageHeader(h)
		if got != c.want || ok != c.ok {
			t.Errorf("Age %q: got %v, %v; want %v, %v", c.v, got, ok, c.want, c.ok)
		}
	}
}
