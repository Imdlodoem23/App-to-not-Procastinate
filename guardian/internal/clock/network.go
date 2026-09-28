package clock

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// timeSource is one fixed HTTPS endpoint that tells the time.
type timeSource struct {
	url string
	// trace marks a Cloudflare /cdn-cgi/trace page: it is fetched with GET and
	// its "ts=" line (Unix time with millisecond resolution) is read. Other
	// sources are fetched with HEAD and their Date header is read; so is a
	// trace page's when its ts line is missing or malformed.
	trace bool
}

// hostname returns the host of a source whose URL names a host instead of
// an IP literal, or "" for an IP literal (or an unparseable URL, which the
// request then rejects).
func (s timeSource) hostname() string {
	u, err := url.Parse(s.url)
	if err != nil {
		return ""
	}
	h := u.Hostname()
	if _, err := netip.ParseAddr(h); err == nil {
		return ""
	}
	return strings.ToLower(h)
}

// networkTimeSources is the fixed list NetworkTime asks, in this order. The
// first three are IP literals whose certificates carry IP SANs, so neither DNS
// nor the hosts file (which the guardian itself manages, and where a user
// could list a hostname as a custom block) can redirect or block them. The
// hostnames are a fallback for networks that filter those addresses; they are
// resolved with DNS-over-HTTPS through the same IP literals (dohServers),
// never through the system resolver. Every hostname here and its parents are
// in the catalog's PROTECTED_DOMAINS, so no block can list them.
var networkTimeSources = []timeSource{
	{url: "https://1.1.1.1/cdn-cgi/trace", trace: true},
	{url: "https://1.0.0.1/cdn-cgi/trace", trace: true},
	{url: "https://8.8.8.8/"},
	{url: "https://www.google.com/"},
	{url: "https://www.cloudflare.com/"},
	{url: "https://www.apple.com/"},
}

const (
	// networkTimeout bounds each request; the caller's context bounds the total.
	networkTimeout = 5 * time.Second
	// NetworkTime needs minAgreeing answers within maxSpread of one another.
	minAgreeing = 2
	maxSpread   = 3 * time.Second
	// maxAge bounds the Age header of a cached answer; older ones are ignored.
	maxAge = 24 * time.Hour
	// maxBody bounds what is read of a response (a trace page is ~300 bytes).
	maxBody = 4 << 10
	// userAgent is sent with every request; nothing about the user is.
	userAgent = "centrate-guardian"
)

// NetworkStatus is the outcome of a network time check.
type NetworkStatus string

const (
	// NetworkOK: at least two answers agreed; NetworkResult.Time holds the time.
	NetworkOK NetworkStatus = "ok"
	// NetworkDisagree: two or more answers came back but no two agreed.
	NetworkDisagree NetworkStatus = "disagree"
	// NetworkOffline: fewer than two usable answers (no network, timeout,
	// every source filtered).
	NetworkOffline NetworkStatus = "offline"
	// NetworkTampered: no agreement, and a calibration hostname resolved to
	// 0.0.0.0 or :: (a blocking resolver answered for a time source). It is
	// reported as tampering, never as offline.
	NetworkTampered NetworkStatus = "tampered"
)

// NetworkResult is what CheckNetworkTime learned.
type NetworkResult struct {
	// Time is the median of the agreeing answers (only when Status is
	// NetworkOK), as of the moment the check returned, in UTC.
	Time time.Time
	// Status is the outcome.
	Status NetworkStatus
	// Answers counts the usable answers received; Agreeing the answers in the
	// agreeing group (0 unless Status is NetworkOK).
	Answers  int
	Agreeing int
	// Tampered is true when a calibration hostname resolved to 0.0.0.0 or ::,
	// whatever the Status (enough IP-literal answers may still have agreed).
	Tampered bool
}

// OK reports whether the check produced a time.
func (r NetworkResult) OK() bool { return r.Status == NetworkOK }

// NetworkTime asks the fixed HTTPS sources in networkTimeSources for the
// current time, one after another, and stops as soon as two answers agree
// within 3 s. It returns the median of the agreeing answers, each corrected
// for half its round trip and for the Age of a cached response (RFC 9111),
// as of the moment it returns. ok is false when offline, on timeout, when no
// two answers agree, or on any error: the check is optional and the guardian
// must work without it. The result is accurate to about a second, far better
// than the jump tolerance. See CheckNetworkTime for the details.
func NetworkTime(ctx context.Context, trustedNow func() time.Time) (t time.Time, ok bool) {
	r := CheckNetworkTime(ctx, trustedNow)
	return r.Time, r.OK()
}

// CheckNetworkTime is NetworkTime with the full outcome (docs/ARCHITECTURE.md
// §10.2): the IP-literal sources are asked first; the hostname sources are
// resolved with DNS-over-HTTPS (dohServers) and dialled at the addresses it
// returned, never through the system resolver or the hosts file, and without
// any proxy. A hostname that resolves to 0.0.0.0 or :: is skipped and
// reported as tampering (NetworkResult.Tampered, and Status NetworkTampered
// when no two answers agreed).
//
// Certificates are verified against the system roots at trustedNow()
// (typically Detector.EffectiveNow) instead of the wall clock, so a clock
// moved years ahead cannot make valid certificates look expired. A nil
// trustedNow uses the wall clock.
//
// Nothing about the user is sent: requests carry a fixed User-Agent and no
// cookies. Like any connection, they show the machine's IP address to the
// servers contacted (Cloudflare and Google first; Apple only as a fallback).
func CheckNetworkTime(ctx context.Context, trustedNow func() time.Time) NetworkResult {
	return newChecker(trustedNow, nil, networkTimeSources, dohServers).check(ctx)
}

// newNetworkClient returns the client for the IP-literal sources and the DoH
// servers. roots nil means the system roots; tests pass their own.
func newNetworkClient(now func() time.Time, roots *x509.CertPool) *http.Client {
	tr := &http.Transport{Proxy: http.ProxyFromEnvironment, TLSHandshakeTimeout: networkTimeout}
	if def, ok := http.DefaultTransport.(*http.Transport); ok {
		tr = def.Clone()
	}
	tr.DisableKeepAlives = true // one-off requests; keep no idle connections in the service
	tr.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, Time: now}
	return &http.Client{
		Transport: tr,
		Timeout:   networkTimeout,
		// Any response carries a Date header; never follow redirects elsewhere.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// resolvedHosts maps the hostnames of the time sources to the addresses DoH
// returned for them. The hostname client dials only those addresses.
type resolvedHosts struct {
	mu sync.Mutex
	m  map[string][]netip.Addr
}

func (h *resolvedHosts) set(host string, addrs []netip.Addr) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.m == nil {
		h.m = map[string][]netip.Addr{}
	}
	h.m[strings.ToLower(host)] = addrs
}

func (h *resolvedHosts) get(host string) []netip.Addr {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.m[strings.ToLower(host)]
}

// errNotResolved: the hostname client was asked for a host DoH did not
// resolve. It never falls back to the system resolver.
var errNotResolved = errors.New("clock: time-source host not resolved with DNS-over-HTTPS")

// dial connects to one of the addresses DoH returned for addr's host.
func (h *resolvedHosts) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	port, err := strconv.ParseUint(portStr, 10, 16)
	if err != nil {
		return nil, err
	}
	addrs := h.get(host)
	if len(addrs) == 0 {
		return nil, errNotResolved
	}
	d := net.Dialer{Timeout: networkTimeout}
	var firstErr error
	for _, a := range addrs {
		c, err := d.DialContext(ctx, network, netip.AddrPortFrom(a, uint16(port)).String())
		if err == nil {
			return c, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return nil, firstErr
}

// newHostClient returns the client for the hostname sources: it dials the
// addresses in hosts (never the system resolver), uses no proxy (a proxy
// would resolve the name itself), verifies certificates for the hostname at
// now() and follows no redirect.
func newHostClient(now func() time.Time, roots *x509.CertPool, hosts *resolvedHosts) *http.Client {
	tr := &http.Transport{
		Proxy:               nil,
		DialContext:         hosts.dial,
		TLSHandshakeTimeout: networkTimeout,
		DisableKeepAlives:   true,
		ForceAttemptHTTP2:   true,
		TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, Time: now},
	}
	return &http.Client{
		Transport:     tr,
		Timeout:       networkTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// checker runs one network time check.
type checker struct {
	literal *http.Client // IP-literal sources and DoH
	host    *http.Client // hostname sources, dialing DoH answers
	hosts   *resolvedHosts
	// resolver resolves hostname sources; nil sends them through literal
	// unresolved (tests of the answer logic).
	resolver *dohResolver
	sources  []timeSource
}

func newChecker(now func() time.Time, roots *x509.CertPool, sources []timeSource, doh []string) *checker {
	literal := newNetworkClient(now, roots)
	hosts := &resolvedHosts{}
	return &checker{
		literal:  literal,
		host:     newHostClient(now, roots, hosts),
		hosts:    hosts,
		resolver: &dohResolver{client: literal, servers: doh},
		sources:  sources,
	}
}

// networkTime asks sources through client alone, without DoH (tests).
func networkTime(ctx context.Context, client *http.Client, sources []timeSource) (time.Time, bool) {
	r := (&checker{literal: client, sources: sources}).check(ctx)
	return r.Time, r.OK()
}

func (c *checker) check(ctx context.Context) NetworkResult {
	var got []answer
	res := NetworkResult{}
	for _, src := range c.sources {
		if ctx.Err() != nil {
			break
		}
		client := c.literal
		if host := src.hostname(); host != "" && c.resolver != nil {
			addrs, err := c.resolver.lookup(ctx, host)
			if errors.Is(err, errDNSUnspecified) {
				res.Tampered = true
				continue
			}
			if err != nil {
				continue
			}
			c.hosts.set(host, addrs)
			client = c.host
		}
		a, ok := ask(ctx, client, src)
		if !ok {
			continue
		}
		got = append(got, a)
		if t, n, ok := agreed(got, time.Now()); ok {
			res.Time, res.Status, res.Answers, res.Agreeing = t, NetworkOK, len(got), n
			return res
		}
	}
	res.Answers = len(got)
	switch {
	case res.Tampered:
		res.Status = NetworkTampered
	case len(got) >= minAgreeing:
		res.Status = NetworkDisagree
	default:
		res.Status = NetworkOffline
	}
	return res
}

// answer is one source's reading: server is the estimated server time at the
// local instant local, which carries Go's monotonic reading so that answers
// taken at different moments can be compared.
type answer struct {
	server time.Time
	local  time.Time
}

// at projects the answer to the local instant now.
func (a answer) at(now time.Time) time.Time { return a.server.Add(now.Sub(a.local)) }

// agreed finds the largest group of answers lying within maxSpread of one
// another once projected to now, and returns the median of that group and
// its size when it holds at least minAgreeing answers.
func agreed(answers []answer, now time.Time) (time.Time, int, bool) {
	ts := make([]time.Time, len(answers))
	for i, a := range answers {
		ts[i] = a.at(now)
	}
	slices.SortFunc(ts, time.Time.Compare)
	best, n := 0, 0
	for i := range ts {
		j := i
		for j+1 < len(ts) && ts[j+1].Sub(ts[i]) <= maxSpread {
			j++
		}
		if j-i+1 > n {
			best, n = i, j-i+1
		}
	}
	if n < minAgreeing {
		return time.Time{}, 0, false
	}
	g := ts[best : best+n]
	if n%2 == 1 {
		return g[n/2], n, true
	}
	lo, hi := g[n/2-1], g[n/2]
	return lo.Add(hi.Sub(lo) / 2), n, true
}

// ask queries one source.
func ask(ctx context.Context, client *http.Client, src timeSource) (answer, bool) {
	ctx, cancel := context.WithTimeout(ctx, networkTimeout)
	defer cancel()
	var mu sync.Mutex // the trace hooks run on the transport's goroutines
	var sent, first time.Time
	hooks := &httptrace.ClientTrace{
		WroteRequest: func(httptrace.WroteRequestInfo) {
			mu.Lock()
			sent = time.Now()
			mu.Unlock()
		},
		GotFirstResponseByte: func() {
			mu.Lock()
			first = time.Now()
			mu.Unlock()
		},
	}
	method := http.MethodHead
	if src.trace {
		method = http.MethodGet
	}
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, hooks), method, src.url, nil)
	if err != nil {
		return answer{}, false
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Cache-Control", "no-cache")
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return answer{}, false
	}
	done := time.Now()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	_ = resp.Body.Close()

	mu.Lock()
	if sent.IsZero() {
		sent = start
	}
	if first.IsZero() {
		first = done
	}
	local, rtt := first, max(first.Sub(sent), 0)
	mu.Unlock()

	server, ok := time.Time{}, false
	if src.trace && resp.StatusCode == http.StatusOK {
		server, ok = traceTime(body)
	}
	if !ok {
		server, ok = dateHeader(resp.Header)
	}
	if !ok {
		return answer{}, false
	}
	age, ok := ageHeader(resp.Header)
	if !ok {
		return answer{}, false
	}
	// The server read its clock somewhere between the request and the first
	// byte of the response: take the middle of that round trip.
	server = server.Add(age + rtt/2)
	if server.Before(minPlausibleTime) {
		return answer{}, false
	}
	return answer{server: server.UTC(), local: local}, true
}

// dateHeader reads the Date header. It has one-second resolution, so the
// middle of that second is returned.
func dateHeader(h http.Header) (time.Time, bool) {
	d, err := http.ParseTime(h.Get("Date"))
	if err != nil {
		return time.Time{}, false
	}
	return d.Add(500 * time.Millisecond), true
}

// ageHeader reads the Age header (RFC 9111, section 5.1): how many seconds
// ago a cache got the response from the origin, whose Date is that old. A
// missing header means zero. A malformed one, or one above maxAge, makes the
// answer unusable.
func ageHeader(h http.Header) (time.Duration, bool) {
	v := strings.TrimSpace(h.Get("Age"))
	if v == "" {
		return 0, true
	}
	if len(v) > 10 || !allDigits(v) {
		return 0, false
	}
	n, err := strconv.ParseUint(v, 10, 64)
	if err != nil || n > uint64(maxAge/time.Second) {
		return 0, false
	}
	return time.Duration(n) * time.Second, true
}

// traceTime reads the "ts=<seconds>.<fraction>" line of a Cloudflare trace
// page.
func traceTime(body []byte) (time.Time, bool) {
	for line := range strings.SplitSeq(string(body), "\n") {
		v, ok := strings.CutPrefix(strings.TrimSpace(line), "ts=")
		if !ok {
			continue
		}
		sec, frac, _ := strings.Cut(v, ".")
		if sec == "" || len(sec) > 11 || len(frac) > 9 || !allDigits(sec) || !allDigits(frac) {
			return time.Time{}, false
		}
		s, err := strconv.ParseInt(sec, 10, 64)
		if err != nil {
			return time.Time{}, false
		}
		var ns int64
		if frac != "" {
			ns, _ = strconv.ParseInt(frac+strings.Repeat("0", 9-len(frac)), 10, 64)
		}
		return time.Unix(s, ns).UTC(), true
	}
	return time.Time{}, false
}

// allDigits reports whether s holds only ASCII digits (true for "").
func allDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}
