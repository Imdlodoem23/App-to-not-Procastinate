package clock

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// dateServer answers every request with the given Date header value; an
// empty value suppresses the header.
func dateServer(t *testing.T, date string) *httptest.Server {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead {
			t.Errorf("method = %s, want HEAD", r.Method)
		}
		if date == "" {
			w.Header()["Date"] = nil
		} else {
			w.Header().Set("Date", date)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func testClient(srv *httptest.Server) *http.Client {
	c := srv.Client()
	c.Timeout = 2 * time.Second
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return c
}

func TestNetworkTimeReadsDateHeader(t *testing.T) {
	want := time.Date(2030, time.March, 4, 5, 6, 7, 0, time.UTC)
	srv := dateServer(t, want.Format(http.TimeFormat))
	got, ok := networkTime(context.Background(), testClient(srv), []string{srv.URL})
	if !ok {
		t.Fatal("ok = false")
	}
	// Middle of the Date second, plus the little time spent since.
	if got.Before(want.Add(500*time.Millisecond)) || got.After(want.Add(2*time.Second)) {
		t.Fatalf("got %v, want about %v", got, want)
	}
	if got.Location() != time.UTC {
		t.Fatalf("location = %v, want UTC", got.Location())
	}
}

func TestNetworkTimeFallsBackToNextServer(t *testing.T) {
	want := time.Date(2031, time.January, 2, 3, 4, 5, 0, time.UTC)
	good := dateServer(t, want.Format(http.TimeFormat))
	noDate := dateServer(t, "")
	// The client trusts every httptest certificate. The malformed URL fails
	// before any connection; the second server answers without a Date.
	urls := []string{"https://bad host/", noDate.URL, good.URL}
	got, ok := networkTime(context.Background(), testClient(good), urls)
	if !ok || got.Sub(want).Abs() > 2*time.Second {
		t.Fatalf("got %v, %v; want about %v", got, ok, want)
	}
}

func TestNetworkTimeRejectsBadDates(t *testing.T) {
	for _, date := range []string{"", "not a date", "Mon, 01 Jan 1990 00:00:00 GMT"} {
		srv := dateServer(t, date)
		if got, ok := networkTime(context.Background(), testClient(srv), []string{srv.URL}); ok {
			t.Errorf("Date %q: got %v, want ok = false", date, got)
		}
	}
}

func TestNetworkTimeHonoursContext(t *testing.T) {
	srv := dateServer(t, time.Now().UTC().Format(http.TimeFormat))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, ok := networkTime(ctx, testClient(srv), []string{srv.URL}); ok {
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
	got, ok := networkTime(context.Background(), testClient(srv), []string{srv.URL + "/"})
	if !ok || got.Sub(want).Abs() > 2*time.Second {
		t.Fatalf("got %v, %v; want the redirect's own Date %v", got, ok, want)
	}
}

func TestNetworkTimeURLsAreFixedHTTPS(t *testing.T) {
	if len(networkTimeURLs) == 0 {
		t.Fatal("no servers configured")
	}
	for _, u := range networkTimeURLs {
		if !strings.HasPrefix(u, "https://") {
			t.Errorf("%s is not HTTPS", u)
		}
	}
	c := newNetworkClient()
	if c.Timeout <= 0 || c.CheckRedirect == nil {
		t.Fatal("client must have a timeout and must not follow redirects")
	}
}
