package clock

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// rr is one answer record a fake resolver returns: an address (A or AAAA
// by its family) or, with cname set, a CNAME record (whose target is not
// encoded: only its type matters to the parser).
type rr struct {
	addr  netip.Addr
	cname bool
}

// dnsReply builds the response to query with rcode and the given records,
// owner names compressed to the question (offset 12), as resolvers write them.
func dnsReply(t *testing.T, query []byte, rcode uint16, records ...rr) []byte {
	t.Helper()
	_, end, ok := readDNSName(query, dnsHeaderLen)
	if !ok {
		t.Fatalf("bad query %x", query)
	}
	out := make([]byte, dnsHeaderLen)
	copy(out, query[:2])
	binary.BigEndian.PutUint16(out[2:], dnsFlagQR|dnsFlagRD|0x0080|rcode)
	binary.BigEndian.PutUint16(out[4:], 1)
	binary.BigEndian.PutUint16(out[6:], uint16(len(records)))
	out = append(out, query[dnsHeaderLen:end+4]...)
	for _, r := range records {
		out = append(out, 0xc0, dnsHeaderLen)
		var typ uint16
		var data []byte
		switch {
		case r.cname:
			typ, data = 5, []byte{3, 'c', 'd', 'n', 0xc0, dnsHeaderLen}
		case r.addr.Is4():
			typ, data = dnsTypeA, r.addr.AsSlice()
		default:
			typ, data = dnsTypeAAAA, r.addr.AsSlice()
		}
		out = binary.BigEndian.AppendUint16(out, typ)
		out = binary.BigEndian.AppendUint16(out, dnsClassIN)
		out = binary.BigEndian.AppendUint32(out, 60)
		out = binary.BigEndian.AppendUint16(out, uint16(len(data)))
		out = append(out, data...)
	}
	return out
}

// dohServer is a fake RFC 8484 resolver: answer decides the reply to each
// question (nil: HTTP 500). It counts the queries.
type dohServer struct {
	*httptest.Server
	queries atomic.Int32
}

func newDoHServer(t *testing.T, answer func(name string, qtype uint16) (rcode uint16, records []rr, ok bool)) *dohServer {
	t.Helper()
	d := &dohServer{}
	d.Server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		d.queries.Add(1)
		if req.URL.Path != "/dns-query" || req.Method != http.MethodGet {
			t.Errorf("DoH request %s %s", req.Method, req.URL.Path)
		}
		if req.Header.Get("Accept") != dnsMessageType || req.Header.Get("User-Agent") != userAgent {
			t.Errorf("DoH headers %v", req.Header)
		}
		q, err := base64.RawURLEncoding.DecodeString(req.URL.Query().Get("dns"))
		if err != nil {
			t.Errorf("dns parameter: %v", err)
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		name, end, ok := readDNSName(q, dnsHeaderLen)
		if !ok || end+4 > len(q) {
			t.Errorf("bad query %x", q)
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		rcode, records, ok := answer(name, binary.BigEndian.Uint16(q[end:]))
		if !ok {
			http.Error(w, "down", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", dnsMessageType)
		_, _ = w.Write(dnsReply(t, q, rcode, records...))
	}))
	d.Config.ErrorLog = log.New(io.Discard, "", 0)
	d.StartTLS()
	t.Cleanup(d.Close)
	return d
}

func (d *dohServer) endpoint() string { return d.URL + "/dns-query" }

var loopback4 = netip.MustParseAddr("127.0.0.1")

func TestBuildDNSQuery(t *testing.T) {
	got, err := buildDNSQuery("www.Google.com.", dnsTypeAAAA)
	if err != nil {
		t.Fatal(err)
	}
	want := []byte{0, 0, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0,
		3, 'w', 'w', 'w', 6, 'G', 'o', 'o', 'g', 'l', 'e', 3, 'c', 'o', 'm', 0, 0, 28, 0, 1}
	if !bytes.Equal(got, want) {
		t.Fatalf("query = %x, want %x", got, want)
	}
	for _, bad := range []string{"", ".", "a..b", "exa mple.com", "ex_ample.com", strings.Repeat("a", 64) + ".com", strings.Repeat("a.", 127) + "com"} {
		if _, err := buildDNSQuery(bad, dnsTypeA); err == nil {
			t.Errorf("buildDNSQuery(%q) accepted", bad)
		}
	}
}

func TestParseDNSResponse(t *testing.T) {
	q, _ := buildDNSQuery("www.apple.com", dnsTypeA)
	a1, a2 := netip.MustParseAddr("17.253.144.10"), netip.MustParseAddr("17.253.144.11")

	got, err := parseDNSResponse(dnsReply(t, q, 0, rr{cname: true}, rr{addr: a1}, rr{addr: a2}), "www.apple.com", dnsTypeA)
	if err != nil || len(got) != 2 || got[0] != a1 || got[1] != a2 {
		t.Fatalf("got %v, %v", got, err)
	}
	// The question is compared case-insensitively, with or without a final dot.
	if _, err := parseDNSResponse(dnsReply(t, q, 0, rr{addr: a1}), "WWW.Apple.com.", dnsTypeA); err != nil {
		t.Fatalf("case-insensitive question: %v", err)
	}

	cases := []struct {
		name string
		msg  []byte
		want error
	}{
		{"blocking answer", dnsReply(t, q, 0, rr{addr: a1}, rr{addr: netip.IPv4Unspecified()}), errDNSUnspecified},
		{"only a CNAME", dnsReply(t, q, 0, rr{cname: true}), errDNSNoAddress},
		{"no answer", dnsReply(t, q, 0), errDNSNoAddress},
		{"NXDOMAIN", dnsReply(t, q, 3), errDNSRcode},
		{"SERVFAIL", dnsReply(t, q, 2), errDNSRcode},
		{"short", q[:5], errDNSMalformed},
		{"a query, not a response", q, errDNSMalformed},
	}
	for _, c := range cases {
		if _, err := parseDNSResponse(c.msg, "www.apple.com", dnsTypeA); !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", c.name, err, c.want)
		}
	}

	// Answers that do not match the query.
	good := dnsReply(t, q, 0, rr{addr: a1})
	mutate := func(f func(m []byte) []byte) []byte { return f(bytes.Clone(good)) }
	for name, msg := range map[string][]byte{
		"other id":        mutate(func(m []byte) []byte { m[1] = 7; return m }),
		"truncated flag":  mutate(func(m []byte) []byte { m[2] |= 0x02; return m }),
		"two questions":   mutate(func(m []byte) []byte { m[5] = 2; return m }),
		"cut record":      good[:len(good)-2],
		"other question":  dnsReply(t, mustQuery(t, "www.google.com", dnsTypeA), 0, rr{addr: a1}),
		"other type":      dnsReply(t, mustQuery(t, "www.apple.com", dnsTypeAAAA), 0, rr{addr: a1}),
		"forward pointer": mutate(func(m []byte) []byte { m[len(q)+1] = byte(len(m) - 1); return m }),
		"self pointer":    mutate(func(m []byte) []byte { m[len(q)+1] = byte(len(q)); return m }),
		"bad rdlength":    mutate(func(m []byte) []byte { m[len(m)-5] = 3; return m[:len(m)-1] }),
	} {
		if _, err := parseDNSResponse(msg, "www.apple.com", dnsTypeA); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// AAAA answers, and :: as a blocking answer.
	v6 := dnsReply(t, mustQuery(t, "www.apple.com", dnsTypeAAAA), 0, rr{addr: netip.MustParseAddr("2001:db8::1")})
	if got, err := parseDNSResponse(v6, "www.apple.com", dnsTypeAAAA); err != nil || len(got) != 1 {
		t.Fatalf("AAAA: %v, %v", got, err)
	}
	if _, err := parseDNSResponse(dnsReply(t, mustQuery(t, "www.apple.com", dnsTypeAAAA), 0, rr{addr: netip.IPv6Unspecified()}), "www.apple.com", dnsTypeAAAA); !errors.Is(err, errDNSUnspecified) {
		t.Fatalf(":: answer: err = %v", err)
	}
}

func mustQuery(t *testing.T, name string, qtype uint16) []byte {
	t.Helper()
	q, err := buildDNSQuery(name, qtype)
	if err != nil {
		t.Fatal(err)
	}
	return q
}

// FuzzParseDNSResponse: the parser never panics and never returns an
// unspecified address.
func FuzzParseDNSResponse(f *testing.F) {
	q, _ := buildDNSQuery("www.google.com", dnsTypeA)
	f.Add(q)
	f.Add(append(bytes.Clone(q), 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 1, 2, 3, 4))
	f.Fuzz(func(t *testing.T, msg []byte) {
		addrs, err := parseDNSResponse(msg, "www.google.com", dnsTypeA)
		if err == nil && len(addrs) == 0 {
			t.Fatal("no error and no address")
		}
		for _, a := range addrs {
			if a.IsUnspecified() || !a.Is4() {
				t.Fatalf("returned %v", a)
			}
		}
	})
}

func testRoots(srv *httptest.Server) *x509.CertPool {
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	return roots
}

func TestDoHResolverFallsBackAcrossServersAndTypes(t *testing.T) {
	down := newDoHServer(t, func(string, uint16) (uint16, []rr, bool) { return 0, nil, false })
	v6 := netip.MustParseAddr("::1")
	up := newDoHServer(t, func(name string, qtype uint16) (uint16, []rr, bool) {
		switch {
		case name == "v6only.example" && qtype == dnsTypeAAAA:
			return 0, []rr{{addr: v6}}, true
		case name == "v6only.example":
			return 0, nil, true
		case name == "missing.example":
			return 3, nil, true
		}
		return 0, []rr{{addr: loopback4}}, true
	})
	r := dohResolver{client: newNetworkClient(nil, testRoots(up.Server)), servers: []string{down.endpoint(), up.endpoint()}}
	ctx := context.Background()

	if got, err := r.lookup(ctx, "example.com"); err != nil || len(got) != 1 || got[0] != loopback4 {
		t.Fatalf("lookup = %v, %v", got, err)
	}
	if got, err := r.lookup(ctx, "v6only.example"); err != nil || len(got) != 1 || got[0] != v6 {
		t.Fatalf("AAAA fallback = %v, %v", got, err)
	}
	if got, err := r.lookup(ctx, "missing.example"); err == nil {
		t.Fatalf("NXDOMAIN resolved to %v", got)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := r.lookup(cancelled, "example.com"); err == nil {
		t.Fatal("a cancelled lookup must fail")
	}
}

func TestDoHResolverReportsBlockingAnswer(t *testing.T) {
	blocking := newDoHServer(t, func(string, uint16) (uint16, []rr, bool) {
		return 0, []rr{{addr: netip.IPv4Unspecified()}}, true
	})
	honest := newDoHServer(t, func(string, uint16) (uint16, []rr, bool) { return 0, []rr{{addr: loopback4}}, true })
	r := dohResolver{client: newNetworkClient(nil, testRoots(honest.Server)), servers: []string{blocking.endpoint(), honest.endpoint()}}
	if _, err := r.lookup(context.Background(), "www.google.com"); !errors.Is(err, errDNSUnspecified) {
		t.Fatalf("err = %v, want errDNSUnspecified", err)
	}
	if honest.queries.Load() != 0 {
		t.Fatal("one blocking answer is enough: no other server is asked")
	}
}

func TestDoHServersAreIPLiterals(t *testing.T) {
	if len(dohServers) < 2 {
		t.Fatal("want at least two DoH servers")
	}
	for _, s := range dohServers {
		src := timeSource{url: s}
		if !strings.HasPrefix(s, "https://") || src.hostname() != "" || !strings.HasSuffix(s, "/dns-query") {
			t.Errorf("%s is not an HTTPS IP-literal RFC 8484 endpoint", s)
		}
	}
}

// hostSource is a time source named by hostname: example.com is in the
// httptest certificate, and the fake resolver maps it to the server.
func hostSource(srv *httptest.Server) timeSource {
	return timeSource{url: "https://example.com:" + srv.URL[strings.LastIndexByte(srv.URL, ':')+1:] + "/"}
}

func TestCheckNetworkTimeResolvesHostnamesWithDoH(t *testing.T) {
	want := time.Date(2030, time.April, 1, 8, 0, 0, 0, time.UTC)
	a, b := timeServer(t, dateReply(want)), timeServer(t, dateReply(want))
	doh := newDoHServer(t, func(name string, qtype uint16) (uint16, []rr, bool) {
		if name != "example.com" {
			t.Errorf("resolved %q", name)
		}
		return 0, []rr{{addr: loopback4}}, true
	})
	c := newChecker(nil, testRoots(a), []timeSource{hostSource(a), hostSource(b)}, []string{doh.endpoint()})
	r := c.check(context.Background())
	assertAbout(t, r.Time, r.OK(), want, 500*time.Millisecond, 2*time.Second)
	if r.Status != NetworkOK || r.Answers != 2 || r.Agreeing != 2 || r.Tampered {
		t.Fatalf("result = %+v", r)
	}
	if doh.queries.Load() == 0 {
		t.Fatal("hostnames must be resolved with DoH")
	}
}

// Without a DoH answer a hostname source is never asked: nothing falls back
// to the system resolver (or the hosts file behind it).
func TestCheckNetworkTimeNeverUsesSystemResolver(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Date", time.Now().UTC().Format(http.TimeFormat))
	}))
	t.Cleanup(srv.Close)
	doh := newDoHServer(t, func(string, uint16) (uint16, []rr, bool) { return 2, nil, true }) // SERVFAIL
	src := timeSource{url: "https://localhost:" + srv.URL[strings.LastIndexByte(srv.URL, ':')+1:] + "/"}
	r := newChecker(nil, testRoots(srv), []timeSource{src, src}, []string{doh.endpoint()}).check(context.Background())
	if r.OK() || r.Status != NetworkOffline || hits.Load() != 0 {
		t.Fatalf("result = %+v, hits = %d", r, hits.Load())
	}
	hc := newHostClient(nil, nil, &resolvedHosts{})
	if tr := hc.Transport.(*http.Transport); tr.Proxy != nil || tr.DialContext == nil {
		t.Fatal("the hostname client must use no proxy and dial only DoH answers")
	}
	if _, err := hc.Get("https://" + "example.com/"); !errors.Is(err, errNotResolved) {
		t.Fatalf("unresolved host: err = %v", err)
	}
}

func TestCheckNetworkTimeReportsTampering(t *testing.T) {
	want := time.Date(2030, time.April, 1, 8, 0, 0, 0, time.UTC)
	a := timeServer(t, dateReply(want))
	doh := newDoHServer(t, func(string, uint16) (uint16, []rr, bool) {
		return 0, []rr{{addr: netip.IPv4Unspecified()}}, true
	})
	literal := timeSource{url: a.URL + "/"}
	// One literal answer and a blocked hostname: tampering, not offline.
	r := newChecker(nil, testRoots(a), []timeSource{literal, hostSource(a)}, []string{doh.endpoint()}).check(context.Background())
	if r.OK() || r.Status != NetworkTampered || !r.Tampered || r.Answers != 1 {
		t.Fatalf("result = %+v", r)
	}
	// Enough literal answers agree before the hostname is reached: ok, and
	// the hostname is never resolved.
	r = newChecker(nil, testRoots(a), []timeSource{literal, literal, hostSource(a)}, []string{doh.endpoint()}).check(context.Background())
	if !r.OK() || r.Tampered || doh.queries.Load() != 1 {
		t.Fatalf("result = %+v, DoH queries = %d", r, doh.queries.Load())
	}
	// A blocked hostname does not hide agreement reached afterwards.
	r = newChecker(nil, testRoots(a), []timeSource{hostSource(a), literal, literal}, []string{doh.endpoint()}).check(context.Background())
	if !r.OK() || !r.Tampered {
		t.Fatalf("result = %+v", r)
	}
}

func TestCheckNetworkTimeStatuses(t *testing.T) {
	base := time.Date(2032, time.January, 1, 0, 0, 0, 0, time.UTC)
	a, b := timeServer(t, dateReply(base)), timeServer(t, dateReply(base.Add(time.Hour)))
	roots := testRoots(a)
	r := newChecker(nil, roots, dateSources(a, b), nil).check(context.Background())
	if r.Status != NetworkDisagree || r.Answers != 2 || r.Agreeing != 0 || !r.Time.IsZero() {
		t.Fatalf("disagreement: %+v", r)
	}
	r = newChecker(nil, roots, dateSources(a), nil).check(context.Background())
	if r.Status != NetworkOffline || r.Answers != 1 {
		t.Fatalf("one answer: %+v", r)
	}
	r = newChecker(nil, roots, nil, nil).check(context.Background())
	if r.Status != NetworkOffline || r.OK() {
		t.Fatalf("no sources: %+v", r)
	}
}

// Certificates of hostname sources are verified at the trusted time too.
func TestHostClientVerifiesAtTrustedNow(t *testing.T) {
	want := time.Date(2030, time.March, 4, 5, 6, 7, 0, time.UTC)
	a := timeServer(t, dateReply(want))
	doh := newDoHServer(t, func(string, uint16) (uint16, []rr, bool) { return 0, []rr{{addr: loopback4}}, true })
	sources := []timeSource{hostSource(a), hostSource(a)}
	late := func() time.Time { return time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC) }
	// DoH itself goes through the literal client, which fails at 2100 too:
	// give the resolver its own client so only the hostname client is late.
	c := newChecker(late, testRoots(a), sources, []string{doh.endpoint()})
	c.resolver.client = newNetworkClient(nil, testRoots(a))
	if r := c.check(context.Background()); r.OK() || r.Answers != 0 {
		t.Fatalf("expired certificate accepted: %+v", r)
	}
	c = newChecker(func() time.Time { return want }, testRoots(a), sources, []string{doh.endpoint()})
	r := c.check(context.Background())
	assertAbout(t, r.Time, r.OK(), want, 500*time.Millisecond, 2*time.Second)
}
