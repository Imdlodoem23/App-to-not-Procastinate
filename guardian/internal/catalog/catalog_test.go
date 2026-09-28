package catalog

import (
	"encoding/json"
	"reflect"
	"slices"
	"sync"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

func TestDefaultUsesTheEmbeddedCatalog(t *testing.T) {
	c := Default()
	if c.Snapshot() != embedded.Catalog() {
		t.Fatal("Default is not built from embedded.Catalog()")
	}
	if c.Version() != embedded.Catalog().Version || c.Version() < 1 {
		t.Fatalf("version %d", c.Version())
	}
	if c.String() == "" {
		t.Fatal("empty String")
	}
}

// The browsers, protected domains and multi-label suffixes of the embedded catalog equal
// the TypeScript data they are generated from, so a stale catalog.json fails here even
// without Node. Until the generator has been re-run with them (docs/ARCHITECTURE.md §17
// item 1) the embedded snapshot has none and the test is skipped; testCatalog then reads
// them from the TypeScript sources.
func TestEmbeddedExtrasMatchSharedSources(t *testing.T) {
	x := Default().extras
	if !x.present() {
		if len(x.Browsers)+len(x.ProtectedDomains)+len(x.MultiLabelSuffixes) > 0 {
			t.Fatalf("the embedded catalog has only some of browsers, protectedDomains and multiLabelSuffixes: %d, %d, %d",
				len(x.Browsers), len(x.ProtectedDomains), len(x.MultiLabelSuffixes))
		}
		t.Skip("embedded catalog.json predates browsers, protectedDomains and multiLabelSuffixes: " +
			"run `npm run gen:guardian` and declare them in embedded.CatalogSnapshot")
	}
	if want := sharedExtras(t); !reflect.DeepEqual(x, want) {
		t.Fatalf("embedded §17 lists differ from packages/shared (stale catalog.json?)\n got %+v\nwant %+v", x, want)
	}
}

// extrasOf must keep working once embedded.CatalogSnapshot declares the fields, whatever
// Go types it gives them.
func TestExtrasOfFutureSnapshot(t *testing.T) {
	type futureBrowser struct {
		ID              string                `json:"id"`
		Name            string                `json:"name"`
		Family          string                `json:"family"`
		ExtensionFamily string                `json:"extensionFamily"`
		Processes       embedded.ProcessNames `json:"processes"`
	}
	future := struct {
		embedded.CatalogSnapshot
		Browsers           []futureBrowser `json:"browsers"`
		ProtectedDomains   []string        `json:"protectedDomains"`
		MultiLabelSuffixes []string        `json:"multiLabelSuffixes"`
	}{
		CatalogSnapshot: *embedded.Catalog(),
		Browsers: []futureBrowser{{ID: "firefox", Name: "Firefox", Family: EngineFirefox, ExtensionFamily: "firefox",
			Processes: embedded.ProcessNames{Win: []string{"firefox.exe"}, Mac: []string{"firefox"}, Linux: []string{"firefox"}}}},
		ProtectedDomains:   []string{"example.org"},
		MultiLabelSuffixes: []string{"co.uk"},
	}
	x, err := extrasOf(&future)
	if err != nil {
		t.Fatal(err)
	}
	if !x.present() || x.Browsers[0].ID != "firefox" || x.Browsers[0].Processes.Win[0] != "firefox.exe" ||
		x.ProtectedDomains[0] != "example.org" || x.MultiLabelSuffixes[0] != "co.uk" {
		t.Fatalf("extras %+v", x)
	}
	if _, err := extrasOf(func() {}); err == nil {
		t.Fatal("extrasOf accepted a value that is not JSON")
	}
	bad := map[string]any{"browsers": "nope"}
	if _, err := extrasOf(bad); err == nil {
		t.Fatal("extrasOf accepted a browsers list of the wrong type")
	}
}

func TestLookups(t *testing.T) {
	c := testCatalog(t)
	if s := c.Service("youtube"); s == nil || s.Name != "YouTube" {
		t.Errorf("Service(youtube) = %+v", s)
	}
	if s := c.Service("x-twitter"); s == nil || s.Name != "X (Twitter)" {
		t.Errorf("Service(x-twitter) = %+v", s)
	}
	if cat := c.Category("games"); cat == nil || cat.Name != "Juegos" {
		t.Errorf("Category(games) = %+v", cat)
	}
	if a := c.App("discord"); a == nil || !slices.Contains(a.Processes.Win, "Discord.exe") {
		t.Errorf("App(discord) = %+v", a)
	}
	if c.Service("nope") != nil || c.Category("nope") != nil || c.App("nope") != nil {
		t.Error("unknown ids found")
	}
	var social []string
	for _, s := range c.ServicesInCategory("social") {
		social = append(social, s.ID)
	}
	if len(social) < 3 || !slices.Equal(social[:3], []string{"tiktok", "instagram", "x-twitter"}) || slices.Contains(social, "linkedin") {
		t.Errorf("social %q", social)
	}
	if len(c.ServicesInCategory("nope")) != 0 {
		t.Error("unknown category has services")
	}
	if got := c.CategoryIDs(); !slices.Equal(got, []string{"social", "video", "games", "messaging", "shopping", "news"}) {
		t.Errorf("CategoryIDs %q", got)
	}
}

func TestFindServiceByDomain(t *testing.T) {
	c := testCatalog(t)
	for host, want := range map[string]string{
		"youtu.be":                           "youtube",
		"https://es.m.youtube.com/watch?v=1": "youtube",
		"atv-ps.amazon.com":                  "prime-video",
		"store.epicgames.com":                "epic-games",
		"www.roblox.com":                     "roblox",
		"www.amazon.com":                     "amazon",
		"smile.amazon.com":                   "amazon",
		"m.youtube.com":                      "youtube",
		"minecraft.net":                      "minecraft",
		"rr3.googlevideo.com":                "",
		"foo.googleapis.com":                 "",
		"com":                                "",
		"":                                   "",
		"accounts.youtube.com":               "",
		"https://accounts.youtube.com/x":     "",
		"aws.amazon.com":                     "",
		"docs.aws.amazon.com":                "",
		"console.aws.amazon.com":             "",
		"read.amazon.com":                    "",
		"leer.amazon.es":                     "",
		"dev.epicgames.com":                  "",
		"www.epicgames.com":                  "",
		"education.minecraft.net":            "",
		"create.roblox.com":                  "",
	} {
		got := ""
		if s := c.FindServiceByDomain(host); s != nil {
			got = s.ID
		}
		if got != want {
			t.Errorf("FindServiceByDomain(%q) = %q, want %q", host, got, want)
		}
	}
	if !c.IsAlwaysAllowedHost("accounts.youtube.com") || !c.IsAlwaysAllowedHost("https://accounts.youtube.com/accounts/SetSID?x=1") {
		t.Error("accounts.youtube.com is not always allowed")
	}
	for _, h := range []string{"www.youtube.com", "youtube.com", "not a host"} {
		if c.IsAlwaysAllowedHost(h) {
			t.Errorf("%q always allowed", h)
		}
	}
	if !slices.Contains(c.AlwaysAllowedHosts(), "accounts.youtube.com") {
		t.Error("AlwaysAllowedHosts misses accounts.youtube.com")
	}
}

func TestFindByProcessName(t *testing.T) {
	c := testCatalog(t)
	for _, tc := range []struct {
		name string
		p    Platform
		app  string
		svc  string
	}{
		{"discord.exe", PlatformWin, "discord", "discord"},
		{"STEAM.EXE", PlatformWin, "steam", "steam"},
		{"steam_osx", PlatformMac, "steam", "steam"},
		{"discord", PlatformLinux, "discord", "discord"},
		{"STEAM", PlatformLinux, "", ""},
		{"Discord.exe", PlatformLinux, "", ""},
		{"notepad.exe", PlatformWin, "", ""},
		{"RobloxPlayerBeta.exe", PlatformWin, "roblox", "roblox"},
		{"LeagueClientUx.exe", PlatformWin, "league-of-legends", "league-of-legends"},
		{"WhatsApp.Root.exe", PlatformWin, "whatsapp", "whatsapp"},
		{"cs2.exe", PlatformWin, "popular-pc-games", ""},
		{"  Discord.exe  ", PlatformWin, "discord", "discord"},
	} {
		app, svc := "", ""
		if a := c.FindAppByProcessName(tc.name, tc.p); a != nil {
			app = a.ID
		}
		if s := c.FindServiceByProcessName(tc.name, tc.p); s != nil {
			svc = s.ID
		}
		if app != tc.app || svc != tc.svc {
			t.Errorf("%q on %s: app %q service %q, want %q %q", tc.name, tc.p, app, svc, tc.app, tc.svc)
		}
	}
}

// Calibration hostnames of guardian/internal/clock (networkTimeSources).
var calibrationHosts = []string{"www.google.com", "www.cloudflare.com", "www.apple.com"}

func TestProtectedDomains(t *testing.T) {
	c := testCatalog(t)
	list := c.ProtectedDomains()
	if len(list) == 0 || !slices.Contains(list, "localhost") {
		t.Fatalf("protected domains %q", list)
	}
	for _, d := range list {
		if d != "localhost" && !IsValidDomain(d) {
			t.Errorf("protected domain %q is not canonical", d)
		}
	}
	for _, host := range calibrationHosts {
		for d := host; ; {
			if !c.IsProtectedDomain(d) {
				t.Errorf("calibration host or parent %q is not protected", d)
			}
			for _, v := range c.ExpandDomainVariants(d) {
				if !c.IsProtectedDomain(v) {
					t.Errorf("custom %q would block unprotected %q", d, v)
				}
			}
			_, parent, ok := cutFirstLabel(d)
			if !ok {
				break
			}
			d = parent
		}
	}
	for _, host := range []string{"microsoft.com", "windowsupdate.com", "windows.com", "apple.com", "time.windows.com", "time.apple.com", "pool.ntp.org", "0.pool.ntp.org", "github.com", "objects.githubusercontent.com", "centrate.onrender.com", "app.localhost", "https://download.windowsupdate.com/x"} {
		if !c.IsProtectedDomain(host) {
			t.Errorf("%q is not protected", host)
		}
	}
	for _, host := range []string{"youtube.com", "onrender.com", "other.onrender.com", "ntp.org", "notgoogle.com", "google.com.evil.example", "localhost", "not a domain", ""} {
		if c.IsProtectedDomain(host) {
			t.Errorf("%q is protected", host)
		}
	}
	// No service blocks a protected host or a parent of one.
	for _, svc := range c.Snapshot().Services {
		for _, d := range svc.Domains {
			for _, p := range list {
				if IsSameOrSubdomain(p, d) {
					t.Errorf("service %s domain %q would block protected %q", svc.ID, d, p)
				}
			}
		}
	}
	list[0] = "evil.example"
	if slices.Contains(c.ProtectedDomains(), "evil.example") {
		t.Error("ProtectedDomains returned shared memory")
	}
}

// cutFirstLabel splits "a.b.c" into "a" and "b.c"; ok is false when the rest would be a
// bare top-level label.
func cutFirstLabel(d string) (string, string, bool) {
	for i := 0; i < len(d); i++ {
		if d[i] == '.' {
			rest := d[i+1:]
			return d[:i], rest, slices.Contains([]byte(rest), '.')
		}
	}
	return d, "", false
}

func TestBrowsers(t *testing.T) {
	c := testCatalog(t)
	browsers := c.Browsers()
	ids := map[string]bool{}
	for _, b := range browsers {
		if ids[b.ID] {
			t.Errorf("duplicate browser %q", b.ID)
		}
		ids[b.ID] = true
		if !slices.Contains([]string{EngineChromium, EngineFirefox, EngineSafari, EngineOther}, b.Family) {
			t.Errorf("%s: family %q", b.ID, b.Family)
		}
		if !slices.Contains([]string{"chrome", "edge", "brave", "opera", "vivaldi", "chromium", "firefox", "other"}, b.ExtensionFamily) {
			t.Errorf("%s: extension family %q", b.ID, b.ExtensionFamily)
		}
		for _, p := range allPlatforms {
			for _, name := range b.Processes.For(string(p)) {
				if !IsValidProcessName(name) || c.IsProtectedProcessName(name) {
					t.Errorf("%s: bad process name %q", b.ID, name)
				}
				for _, other := range c.BrowsersForProcess(name, p) {
					if other.Family != b.Family {
						t.Errorf("%s and %s share %q on %s with different engines", b.ID, other.ID, name, p)
					}
				}
			}
		}
	}
	for _, id := range []string{"chrome", "edge", "brave", "opera", "opera-gx", "vivaldi", "firefox", "safari", "arc", "chromium", "yandex"} {
		if !ids[id] {
			t.Errorf("browser %q missing", id)
		}
	}
	if b, ok := c.Browser("firefox"); !ok || b.Family != EngineFirefox || b.ExtensionFamily != "firefox" {
		t.Errorf("Browser(firefox) = %+v, %v", b, ok)
	}
	if _, ok := c.Browser("netscape"); ok {
		t.Error("unknown browser found")
	}
	idsOf := func(bs []Browser) []string {
		out := []string{}
		for _, b := range bs {
			out = append(out, b.ID)
		}
		return out
	}
	for _, tc := range []struct {
		name string
		p    Platform
		want []string
	}{
		{"CHROME.EXE", PlatformWin, []string{"chrome", "chromium"}},
		{" msedge.exe ", PlatformWin, []string{"edge"}},
		{"opera.exe", PlatformWin, []string{"opera", "opera-gx"}},
		{"google chrome helper", PlatformMac, []string{"chrome"}},
		{"firefox", PlatformLinux, []string{"firefox"}},
		{"Firefox", PlatformLinux, []string{}},
		{"chrome.exe", PlatformLinux, []string{}},
		{"notepad.exe", PlatformWin, []string{}},
	} {
		if got := idsOf(c.BrowsersForProcess(tc.name, tc.p)); !slices.Equal(got, tc.want) {
			t.Errorf("BrowsersForProcess(%q, %s) = %q, want %q", tc.name, tc.p, got, tc.want)
		}
	}
	// Results are copies.
	browsers[0].Processes.Win = append(browsers[0].Processes.Win[:0], "evil.exe")
	if b, _ := c.Browser(browsers[0].ID); slices.Contains(b.Processes.Win, "evil.exe") {
		t.Error("Browsers returned shared memory")
	}
	if raw, err := json.Marshal(c.Browsers()[0]); err != nil || !json.Valid(raw) {
		t.Errorf("browser JSON %s, %v", raw, err)
	}
}

// Every method may be called from any goroutine (run with -race).
func TestConcurrentUse(t *testing.T) {
	c := testCatalog(t)
	var wg sync.WaitGroup
	for g := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p := allPlatforms[g%len(allPlatforms)]
			for range 20 {
				_ = c.ResolveTargets(Selection{CategoryIDs: []string{"games"}, Domains: []string{"example.com"}, ProcessNames: []string{"MyGame.exe"}}, p)
				_ = c.FindAllowDistraction(AllowEntries{Domains: []string{"wikipedia.org"}, Processes: []string{"steam.exe"}}, AllowPaths{"d", "p"}, "")
				_ = c.IsAllowedInStudyWhitelist("doc-0s-8c-docs.googleusercontent.com", nil)
				_ = c.BrowsersForProcess("chrome.exe", p)
				_ = c.ProcessTargetKey("Discord.exe", p)
				_ = c.IsProtectedDomain("www.google.com")
			}
		}()
	}
	wg.Wait()
}
