package catalog

import (
	"fmt"
	"slices"
	"strings"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

// Browser engines (Browser.Family).
const (
	EngineChromium = "chromium"
	EngineFirefox  = "firefox"
	EngineSafari   = "safari"
	EngineOther    = "other"
)

// Browser is a web browser the guardian recognises by process name (the catalog's
// browsers, packages/shared/src/catalog/data/browsers.ts).
type Browser struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Family is the engine: chromium, firefox, safari or other. Browsers that share a
	// process name always share it.
	Family string `json:"family"`
	// ExtensionFamily is the BrowserFamily the Céntrate extension reports in this browser
	// (chrome, edge, brave, opera, vivaldi, chromium, firefox; other without one): pairing
	// binds to it and browsersWithoutExtension lists the browser under it.
	ExtensionFamily string `json:"extensionFamily"`
	// Processes are the main executable and, on macOS, the network helper.
	Processes embedded.ProcessNames `json:"processes"`
}

// Catalog answers catalog questions from one catalog snapshot. It is immutable and safe
// for concurrent use. The *embedded.Service, *embedded.Category and *embedded.App values
// it returns point into the snapshot: never modify them.
type Catalog struct {
	snap   *embedded.CatalogSnapshot
	extras extras

	servicesByID   map[string]*embedded.Service
	categoriesByID map[string]*embedded.Category
	appsByID       map[string]*embedded.App
	browsersByID   map[string]int
	// servicesByDomain is the owner of each catalog host (the first service wins).
	servicesByDomain map[string]*embedded.Service
	// unblockedHosts belong to no service although they sit under one: excluded
	// subdomains and always-allowed hosts. Domain lookups stop there.
	unblockedHosts map[string]struct{}
	// appsByProcess maps ProcessNameKey → app per platform (the first app wins).
	appsByProcess map[Platform]map[string]*embedded.App
	// serviceByApp is the first service (catalog order) that lists each app.
	serviceByApp map[string]*embedded.Service
	// distractionDomains are the domains of services with at least one category.
	distractionDomains []domainOwner
	// distractionApps maps ProcessNameKey → app id, per platform, for the apps some
	// category blocks (the last app wins, like DISTRACTION_APP_KEYS).
	distractionApps map[Platform]map[string]string
	multiLabel      map[string]struct{}
	protectedKeys   map[string]struct{}
	studyDomains    []string
	studyPatterns   []string
}

type domainOwner struct {
	domain    string
	serviceID string
}

var defaultCatalog = func() *Catalog {
	c, err := New(embedded.Catalog())
	if err != nil {
		panic("catalog: " + err.Error())
	}
	return c
}()

// Default returns the catalog built from the embedded snapshot (embedded.Catalog()).
func Default() *Catalog { return defaultCatalog }

// New builds a Catalog from a snapshot, which must not change afterwards.
func New(snap *embedded.CatalogSnapshot) (*Catalog, error) {
	x, err := extrasOf(snap)
	if err != nil {
		return nil, err
	}
	return newCatalog(snap, x), nil
}

func newCatalog(snap *embedded.CatalogSnapshot, x extras) *Catalog {
	c := &Catalog{
		snap:             snap,
		extras:           x,
		servicesByID:     make(map[string]*embedded.Service, len(snap.Services)),
		categoriesByID:   make(map[string]*embedded.Category, len(snap.Categories)),
		appsByID:         make(map[string]*embedded.App, len(snap.Apps)),
		browsersByID:     make(map[string]int, len(x.Browsers)),
		servicesByDomain: make(map[string]*embedded.Service),
		unblockedHosts:   make(map[string]struct{}),
		appsByProcess:    make(map[Platform]map[string]*embedded.App, len(allPlatforms)),
		serviceByApp:     make(map[string]*embedded.Service),
		distractionApps:  make(map[Platform]map[string]string, len(allPlatforms)),
		multiLabel:       make(map[string]struct{}, len(x.MultiLabelSuffixes)),
		protectedKeys:    make(map[string]struct{}, len(snap.ProtectedProcesses)),
	}
	// Ids are unique (tests on both sides check it); like a JavaScript Map built from the
	// list, a repeated id would keep the last entry.
	for i := range snap.Categories {
		c.categoriesByID[snap.Categories[i].ID] = &snap.Categories[i]
	}
	for i := range snap.Apps {
		c.appsByID[snap.Apps[i].ID] = &snap.Apps[i]
	}
	for i := range x.Browsers {
		c.browsersByID[x.Browsers[i].ID] = i
	}
	distractionAppIDs := make(map[string]struct{})
	for i := range snap.Services {
		svc := &snap.Services[i]
		c.servicesByID[svc.ID] = svc
		for _, d := range svc.Domains {
			if _, dup := c.servicesByDomain[d]; !dup {
				c.servicesByDomain[d] = svc
			}
		}
		for _, h := range svc.ExcludedSubdomains {
			c.unblockedHosts[h] = struct{}{}
		}
		for _, id := range svc.AppIDs {
			if _, dup := c.serviceByApp[id]; !dup {
				c.serviceByApp[id] = svc
			}
		}
		if len(svc.Categories) > 0 {
			for _, d := range svc.Domains {
				c.distractionDomains = append(c.distractionDomains, domainOwner{d, svc.ID})
			}
			for _, id := range svc.AppIDs {
				distractionAppIDs[id] = struct{}{}
			}
		}
	}
	for _, h := range snap.AlwaysAllowedHosts {
		c.unblockedHosts[h] = struct{}{}
	}
	for _, cat := range snap.Categories {
		for _, id := range cat.AppIDs {
			distractionAppIDs[id] = struct{}{}
		}
	}
	for _, p := range allPlatforms {
		byProcess := make(map[string]*embedded.App)
		distraction := make(map[string]string)
		for i := range snap.Apps {
			app := &snap.Apps[i]
			_, isDistraction := distractionAppIDs[app.ID]
			for _, name := range app.Processes.For(string(p)) {
				key := ProcessNameKey(name, p)
				if _, dup := byProcess[key]; !dup {
					byProcess[key] = app
				}
				if isDistraction {
					distraction[key] = app.ID
				}
			}
		}
		c.appsByProcess[p] = byProcess
		c.distractionApps[p] = distraction
	}
	for _, s := range x.MultiLabelSuffixes {
		c.multiLabel[s] = struct{}{}
	}
	for _, name := range snap.ProtectedProcesses {
		c.protectedKeys[protectedKey(name)] = struct{}{}
	}
	for _, site := range snap.StudyWhitelist {
		c.studyDomains = append(c.studyDomains, site.Domains...)
		c.studyPatterns = append(c.studyPatterns, site.HostPatterns...)
	}
	c.studyDomains = uniqueSorted(c.studyDomains)
	c.studyPatterns = uniqueSorted(c.studyPatterns)
	return c
}

// uniqueSorted returns the unique strings of list in UTF-16 order (JavaScript's sort),
// as a new non-nil slice.
func uniqueSorted(list []string) []string {
	out := append([]string{}, list...)
	slices.SortFunc(out, compareUTF16)
	return slices.Compact(out)
}

// Snapshot returns the snapshot the catalog was built from (read-only).
func (c *Catalog) Snapshot() *embedded.CatalogSnapshot { return c.snap }

// Version is the catalog data version (CATALOG_VERSION).
func (c *Catalog) Version() int { return c.snap.Version }

// Service returns the service with that id, or nil.
func (c *Catalog) Service(id string) *embedded.Service { return c.servicesByID[id] }

// Category returns the category with that id, or nil.
func (c *Catalog) Category(id string) *embedded.Category { return c.categoriesByID[id] }

// App returns the desktop app with that id, or nil.
func (c *Catalog) App(id string) *embedded.App { return c.appsByID[id] }

// CategoryIDs returns every category id in catalog order.
func (c *Catalog) CategoryIDs() []string {
	ids := make([]string, 0, len(c.snap.Categories))
	for _, cat := range c.snap.Categories {
		ids = append(ids, cat.ID)
	}
	return ids
}

// ServicesInCategory returns the services of a category in catalog order. Opt-in
// services (no category) are in none.
func (c *Catalog) ServicesInCategory(id string) []*embedded.Service {
	var out []*embedded.Service
	for i := range c.snap.Services {
		if slices.Contains(c.snap.Services[i].Categories, id) {
			out = append(out, &c.snap.Services[i])
		}
	}
	return out
}

// AlwaysAllowedHosts returns the hosts that are never blocked, in any mode, together
// with their subdomains (whitelist mode allows them too).
func (c *Catalog) AlwaysAllowedHosts() []string {
	return slices.Clone(c.snap.AlwaysAllowedHosts)
}

// IsAlwaysAllowedHost reports whether domain (a host or URL) is an always-allowed host
// or a subdomain of one: it must never be blocked, in any mode.
func (c *Catalog) IsAlwaysAllowedHost(domain string) bool {
	normalized, ok := NormalizeDomain(domain)
	if !ok {
		return false
	}
	for _, host := range c.snap.AlwaysAllowedHosts {
		if IsSameOrSubdomain(normalized, host) {
			return true
		}
	}
	return false
}

// ProtectedDomains returns the domains no block may list, each with its subdomains: OS
// updates and time, the guardian's time calibration, Céntrate's own hosts and localhost.
func (c *Catalog) ProtectedDomains() []string { return slices.Clone(c.extras.ProtectedDomains) }

// IsProtectedDomain reports whether domain (a host or URL) is a protected domain or a
// subdomain of one: a custom domain like that is refused with protected_target. Invalid
// input is not protected (it is refused as invalid instead).
func (c *Catalog) IsProtectedDomain(domain string) bool {
	normalized, ok := NormalizeDomain(domain)
	if !ok {
		return false
	}
	for _, host := range c.extras.ProtectedDomains {
		if IsSameOrSubdomain(normalized, host) {
			return true
		}
	}
	return false
}

// ProtectedProcesses returns the catalog's protected process names (see
// IsProtectedProcessName).
func (c *Catalog) ProtectedProcesses() []string {
	return slices.Clone(c.snap.ProtectedProcesses)
}

// FindServiceByDomain returns the service a host or URL belongs to, matching exact
// catalog hosts first and then their parents (https://es.m.youtube.com/watch → YouTube),
// or nil. Hosts that stay reachable during a block (excluded subdomains such as
// docs.aws.amazon.com and always-allowed hosts such as accounts.youtube.com) belong to no
// service.
func (c *Catalog) FindServiceByDomain(domain string) *embedded.Service {
	candidate, ok := NormalizeDomain(domain)
	if !ok {
		return nil
	}
	for {
		if svc := c.servicesByDomain[candidate]; svc != nil {
			return svc
		}
		if _, unblocked := c.unblockedHosts[candidate]; unblocked {
			return nil
		}
		dot := strings.IndexByte(candidate, '.')
		// Stop before reaching a bare top-level label.
		if dot < 0 || !strings.Contains(candidate[dot+1:], ".") {
			return nil
		}
		candidate = candidate[dot+1:]
	}
}

// FindAppByProcessName returns the catalog app that runs as processName on platform
// (trimmed; case rules per platform), or nil.
func (c *Catalog) FindAppByProcessName(processName string, platform Platform) *embedded.App {
	return c.appsByProcess[platform][ProcessNameKey(jsTrim(processName), platform)]
}

// FindServiceByProcessName returns the service whose desktop app runs as processName on
// platform, or nil.
func (c *Catalog) FindServiceByProcessName(processName string, platform Platform) *embedded.Service {
	app := c.FindAppByProcessName(processName, platform)
	if app == nil {
		return nil
	}
	return c.serviceByApp[app.ID]
}

// Browsers returns every catalog browser, in catalog order (a copy).
func (c *Catalog) Browsers() []Browser { return cloneBrowsers(c.extras.Browsers) }

// Browser returns the browser with that id.
func (c *Catalog) Browser(id string) (Browser, bool) {
	i, ok := c.browsersByID[id]
	if !ok {
		return Browser{}, false
	}
	return cloneBrowsers(c.extras.Browsers[i : i+1])[0], true
}

// BrowsersForProcess returns the browsers that run as processName on platform (trimmed;
// case rules per platform), in catalog order. Several browsers can share a name (Chromium
// runs as chrome.exe on Windows, like Google Chrome); they always share Family.
func (c *Catalog) BrowsersForProcess(processName string, platform Platform) []Browser {
	key := ProcessNameKey(jsTrim(processName), platform)
	var out []Browser
	for i := range c.extras.Browsers {
		for _, name := range c.extras.Browsers[i].Processes.For(string(platform)) {
			if ProcessNameKey(name, platform) == key {
				out = append(out, cloneBrowsers(c.extras.Browsers[i : i+1])[0])
				break
			}
		}
	}
	return out
}

func cloneBrowsers(in []Browser) []Browser {
	out := make([]Browser, len(in))
	for i, b := range in {
		out[i] = b
		out[i].Processes = embedded.ProcessNames{
			Win:   slices.Clone(b.Processes.Win),
			Mac:   slices.Clone(b.Processes.Mac),
			Linux: slices.Clone(b.Processes.Linux),
		}
	}
	return out
}

// String describes the catalog for diagnostics (never user data).
func (c *Catalog) String() string {
	return fmt.Sprintf("catalog v%d: %d services, %d apps, %d browsers", c.snap.Version,
		len(c.snap.Services), len(c.snap.Apps), len(c.extras.Browsers))
}
