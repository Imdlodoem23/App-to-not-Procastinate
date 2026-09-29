package api

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/platform"
	"github.com/imdlodoem23/centrate/guardian/internal/version"
)

// Listener limits of docs/ARCHITECTURE.md §9.1 (not in the generated data).
const (
	readHeaderTimeout = 5 * time.Second
	readTimeout       = 10 * time.Second
	writeTimeout      = 30 * time.Second
	maxHeaderBytes    = 16 << 10
	maxOpenConns      = 64
	// stopGrace is how long Stop lets requests finish (§13: 2 s).
	stopGrace = 2 * time.Second
	// Bind retry while the port is taken (a squatter, or the previous instance still
	// closing): the guardian keeps enforcing and retries with backoff.
	bindRetryMin = time.Second
	bindRetryMax = 30 * time.Second
)

// listenHost is the only address the API binds (never 0.0.0.0 or ::).
const listenHost = "127.0.0.1"

// Options configures a Server. Zero values select the defaults.
type Options struct {
	// Engine serves the commands (required).
	Engine Engine
	// DataDir holds config.json and client.json. Default platform.DataDir().
	DataDir string
	// Config is the loaded config.json; nil loads it from DataDir (invalid values are
	// logged and replaced by defaults).
	Config *Config
	// Version is the guardianVersion written to client.json. Default version.Version.
	Version string
	// Logger receives operational logs (never tokens, codes, domains or bodies).
	Logger *slog.Logger
	// Peers resolves loopback peers. Default OSPeerResolver().
	Peers PeerResolver
	// Now is the clock of the rate limiters and client.json's issuedAt. Default
	// time.Now.
	Now func() time.Time
	// Listen opens the listener (tests). Default a TCP listener on addr.
	Listen func(ctx context.Context, addr string) (net.Listener, error)
}

// Server is the guardian's HTTP API: 127.0.0.1 only, the request pipeline of §8.3 in
// front of the engine's commands. It implements svc.Runner (Start, Stop) so the
// service wiring can run it next to the engine, and http.Handler.
type Server struct {
	o      Options
	eng    Engine
	cfg    Config
	log    *slog.Logger
	router *router
	peers  PeerResolver
	now    func() time.Time

	// peerSem bounds the peer lookups in flight (maxPeerLookups).
	peerSem chan struct{}

	// port is the port the Host check accepts (the bound one once listening).
	port      atomic.Int32
	appDigest atomic.Pointer[[sha256.Size]byte]
	mode      atomic.Pointer[string]

	limits *rateLimiter
	claims *windowLimiter
	polls  *pollLimiter

	mu      sync.Mutex
	started bool
	stopped bool
	srv     *http.Server
	baseCtx context.Context
	cancel  context.CancelFunc
	addr    net.Addr
	bound   chan struct{}
	wg      sync.WaitGroup
}

// New builds a Server. It fails when the route table and the handlers disagree.
func New(o Options) (*Server, error) {
	if o.Engine == nil {
		return nil, errors.New("api: Options.Engine is required")
	}
	if o.DataDir == "" {
		o.DataDir = platform.DataDir()
	}
	if o.Version == "" {
		o.Version = version.Version
	}
	if o.Logger == nil {
		o.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if o.Peers == nil {
		o.Peers = OSPeerResolver()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Listen == nil {
		o.Listen = func(ctx context.Context, addr string) (net.Listener, error) {
			var lc net.ListenConfig
			return lc.Listen(ctx, "tcp4", addr)
		}
	}
	var cfg Config
	if o.Config != nil {
		c, err := normalizeConfig(*o.Config)
		if err != nil {
			o.Logger.Warn("guardian config has invalid values; defaults used", "errType", errType(err))
		}
		cfg = c
	} else {
		c, err := LoadConfig(o.DataDir)
		if err != nil {
			o.Logger.Warn("guardian config unreadable or invalid; defaults used", "err", err)
		}
		cfg = c
	}
	rt, err := newRouter(embedded.API().Endpoints, handlerTable(), testHooks)
	if err != nil {
		return nil, err
	}
	if len(rt.routes) == 0 {
		return nil, errNoRoutes
	}
	l := embedded.API().Limits
	s := &Server{
		o: o, eng: o.Engine, cfg: cfg, log: o.Logger, router: rt, peers: o.Peers, now: o.Now,
		limits:  newRateLimiter(),
		claims:  &windowLimiter{n: l.PairingClaimsPerWindow, window: embedded.Millis(l.PairingClaimWindowMs)},
		polls:   newPollLimiter(),
		bound:   make(chan struct{}),
		peerSem: make(chan struct{}, maxPeerLookups),
	}
	s.port.Store(int32(cfg.Port))
	return s, nil
}

// Config is the effective configuration (config.json with defaults applied).
func (s *Server) Config() Config { return s.cfg }

// TestHooksEnabled reports whether this build routes the testOnly endpoints; the
// service wiring passes it to engine.Options.TestHooks (health capability testhooks).
func TestHooksEnabled() bool { return testHooks }

// Start implements svc.Runner: it binds 127.0.0.1:<port>, then rotates the app token
// and writes client.json (§9.2; only after the bind, so a process squatting the port
// never receives a fresh token), and serves in the background. When the port is
// taken it logs, returns nil and keeps retrying with backoff: enforcement never
// depends on the API. ctx ending stops the server like Stop.
func (s *Server) Start(ctx context.Context) error {
	s.mu.Lock()
	if s.started || s.stopped {
		s.mu.Unlock()
		return errors.New("api: already started or stopped")
	}
	s.started = true
	s.baseCtx, s.cancel = context.WithCancel(ctx)
	s.srv = &http.Server{
		Handler:           s,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		BaseContext:       func(net.Listener) context.Context { return s.baseCtx },
		ErrorLog:          slog.NewLogLogger(s.log.Handler(), slog.LevelDebug),
	}
	s.mu.Unlock()

	addr := net.JoinHostPort(listenHost, strconv.Itoa(s.cfg.Port))
	ln, err := s.o.Listen(s.baseCtx, addr)
	if err != nil {
		s.log.Warn("guardian API port unavailable; retrying", "port", s.cfg.Port, "errType", errType(err))
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.bindLoop(addr)
		}()
	} else {
		s.serveOn(ln)
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		<-s.baseCtx.Done()
		s.shutdown()
	}()
	return nil
}

// bindLoop retries the bind until it succeeds or the server stops.
func (s *Server) bindLoop(addr string) {
	delay := bindRetryMin
	for {
		t := time.NewTimer(delay)
		select {
		case <-s.baseCtx.Done():
			t.Stop()
			return
		case <-t.C:
		}
		ln, err := s.o.Listen(s.baseCtx, addr)
		if err == nil {
			s.serveOn(ln)
			return
		}
		delay = min(delay*2, bindRetryMax)
	}
}

// serveOn rotates the token, writes client.json and serves ln.
func (s *Server) serveOn(ln net.Listener) {
	port := s.cfg.Port
	if ta, ok := ln.Addr().(*net.TCPAddr); ok {
		port = ta.Port
	}
	s.port.Store(int32(port))
	if err := s.rotateToken(port); err != nil {
		s.log.Error("client.json could not be written; the app cannot authenticate", "errType", errType(err))
	}
	s.mu.Lock()
	srv := s.srv
	s.addr = ln.Addr()
	s.mu.Unlock()
	close(s.bound)
	s.log.Info("guardian API listening", "port", port)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		if err := srv.Serve(newLimitListener(ln, maxOpenConns)); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.log.Error("guardian API stopped serving", "errType", errType(err))
		}
	}()
}

// rotateToken generates a new app token (32 random bytes, on every start) and writes
// client.json atomically before any request can use it.
func (s *Server) rotateToken(port int) error {
	tok, err := newAppToken()
	if err != nil {
		return err
	}
	d := tokenDigest(tok)
	s.appDigest.Store(&d)
	return writeClientFile(s.o.DataDir, newClientFile(port, tok, s.o.Version, s.now()))
}

// Bound is closed once the listener is bound (and client.json written).
func (s *Server) Bound() <-chan struct{} { return s.bound }

// Addr is the bound address (nil before Bound).
func (s *Server) Addr() net.Addr {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.addr
}

// Stop implements svc.Runner: long polls end at once, other requests get stopGrace
// to finish, then connections are closed (§13).
func (s *Server) Stop() error {
	s.mu.Lock()
	s.stopped = true
	cancel := s.cancel
	s.mu.Unlock()
	if cancel != nil {
		cancel()
		s.wg.Wait()
	}
	return nil
}

// shutdown closes the HTTP server (called once the base context ends).
func (s *Server) shutdown() {
	s.mu.Lock()
	srv := s.srv
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), stopGrace)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		_ = srv.Close()
	}
}

// errType names an error's type for logs (error texts may carry paths or data).
func errType(err error) string { return fmt.Sprintf("%T", err) }

// limitListener caps the open connections (§9.1): Accept waits while n are open.
type limitListener struct {
	net.Listener
	sem       chan struct{}
	done      chan struct{}
	closeOnce sync.Once
}

func newLimitListener(l net.Listener, n int) *limitListener {
	return &limitListener{Listener: l, sem: make(chan struct{}, n), done: make(chan struct{})}
}

func (l *limitListener) Accept() (net.Conn, error) {
	select {
	case l.sem <- struct{}{}:
	case <-l.done:
		return nil, net.ErrClosed
	}
	c, err := l.Listener.Accept()
	if err != nil {
		<-l.sem
		return nil, err
	}
	return &limitConn{Conn: c, release: sync.OnceFunc(func() { <-l.sem })}, nil
}

func (l *limitListener) Close() error {
	err := l.Listener.Close()
	l.closeOnce.Do(func() { close(l.done) })
	return err
}

type limitConn struct {
	net.Conn
	release func()
}

func (c *limitConn) Close() error {
	err := c.Conn.Close()
	c.release()
	return err
}
