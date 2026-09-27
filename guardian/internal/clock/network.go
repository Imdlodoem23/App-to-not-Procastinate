package clock

import (
	"context"
	"io"
	"net/http"
	"time"
)

// networkTimeURLs is the fixed list of HTTPS endpoints whose Date header
// NetworkTime reads. Nothing about the user is sent: a HEAD request with a
// fixed User-Agent.
var networkTimeURLs = []string{
	"https://www.google.com/",
	"https://www.cloudflare.com/",
	"https://www.apple.com/",
}

// networkTimeout bounds each request; the caller's context bounds the total.
const networkTimeout = 5 * time.Second

// NetworkTime asks a fixed list of well-known HTTPS servers for the current
// time (their Date header) and returns the first plausible answer. It is
// optional: ok is false when offline, on timeout or on any error, and the
// guardian must work without it.
//
// The result is accurate to about one second plus network latency, far
// better than the jump tolerance. TLS is verified against the system roots
// with the system clock, so a clock moved years away from the truth makes the
// certificates look invalid and NetworkTime report ok == false.
func NetworkTime(ctx context.Context) (t time.Time, ok bool) {
	return networkTime(ctx, newNetworkClient(), networkTimeURLs)
}

func newNetworkClient() *http.Client {
	tr := &http.Transport{Proxy: http.ProxyFromEnvironment, TLSHandshakeTimeout: networkTimeout}
	if def, ok := http.DefaultTransport.(*http.Transport); ok {
		tr = def.Clone()
	}
	tr.DisableKeepAlives = true // one-off requests; keep no idle connections in the service
	return &http.Client{
		Transport: tr,
		Timeout:   networkTimeout,
		// Any response carries a Date header; never follow redirects elsewhere.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func networkTime(ctx context.Context, client *http.Client, urls []string) (time.Time, bool) {
	for _, u := range urls {
		if ctx.Err() != nil {
			return time.Time{}, false
		}
		if t, ok := dateFrom(ctx, client, u); ok {
			return t, true
		}
	}
	return time.Time{}, false
}

func dateFrom(ctx context.Context, client *http.Client, url string) (time.Time, bool) {
	ctx, cancel := context.WithTimeout(ctx, networkTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, url, nil)
	if err != nil {
		return time.Time{}, false
	}
	req.Header.Set("User-Agent", "centrate-guardian")
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := client.Do(req)
	if err != nil {
		return time.Time{}, false
	}
	received := time.Now()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	date, err := http.ParseTime(resp.Header.Get("Date"))
	if err != nil || date.Before(minPlausibleTime) {
		return time.Time{}, false
	}
	// Date has one-second resolution: take the middle of that second, then add
	// the time spent since the response arrived (Go's monotonic clock).
	return date.Add(500*time.Millisecond + time.Since(received)).UTC(), true
}
