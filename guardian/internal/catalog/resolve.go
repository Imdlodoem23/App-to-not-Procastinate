package catalog

import (
	"slices"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

// Port of packages/shared/src/catalog/resolve.ts.

// Selection is what the user chose to block (TS TargetSelection; the block's targets).
type Selection struct {
	ServiceIDs  []string
	CategoryIDs []string
	// Domains are custom domains or URLs; they are normalized and expanded with www.
	Domains []string
	AppIDs  []string
	// ProcessNames are custom process names.
	ProcessNames []string
}

// Resolved are the concrete targets of a Selection on one platform (TS ResolvedTargets).
// Every slice is non-nil.
type Resolved struct {
	// Domains are unique, sorted hosts for the hosts file and the extension.
	Domains []string `json:"domains"`
	// ExcludedDomains are unique, sorted hosts under Domains that must stay reachable
	// (the selected services' excludedSubdomains and the always-allowed hosts). The hosts
	// file ignores them (its entries are exact); the extension, which also matches
	// subdomains, exempts them.
	ExcludedDomains []string `json:"excludedDomains"`
	// Processes are unique (case-insensitively on Windows and macOS, keeping the first
	// spelling), sorted process names for the platform.
	Processes []string `json:"processes"`
}

// orderedSet is a JavaScript Set of strings: unique, in insertion order (a member
// removed and added again moves to the end).
type orderedSet struct {
	pos   map[string]int // member → its index in items
	items []string
}

func (s *orderedSet) add(v string) {
	if s.pos == nil {
		s.pos = make(map[string]int)
	}
	if _, ok := s.pos[v]; !ok {
		s.pos[v] = len(s.items)
		s.items = append(s.items, v)
	}
}

func (s *orderedSet) remove(v string) { delete(s.pos, v) }

// values returns the members in insertion order.
func (s *orderedSet) values() []string {
	out := make([]string, 0, len(s.pos))
	for i, v := range s.items {
		if p, ok := s.pos[v]; ok && p == i {
			out = append(out, v)
		}
	}
	return out
}

// compareProcessNames orders process names case-insensitively, then by exact spelling,
// in UTF-16 order.
func compareProcessNames(a, b string) int {
	la, lb := jsToLower(a), jsToLower(b)
	if la != lb {
		return compareUTF16(la, lb)
	}
	return compareUTF16(a, b)
}

// ResolveTargets expands a selection into the concrete hosts and process names to block
// on platform:
//
//   - Categories add every service in them plus category-wide apps; services add their
//     domains, apps and excluded subdomains.
//   - Custom domains are normalized and expanded with ExpandDomainVariants; invalid ones
//     are dropped.
//   - Always-allowed hosts are never returned in Domains, even when typed as custom
//     domains; when one sits under a returned domain it is listed in ExcludedDomains.
//   - A service's excluded subdomain is dropped from ExcludedDomains when the user typed it
//     (or a host under it) as a custom domain: what the user names explicitly is blocked.
//   - Custom process names are trimmed; invalid and protected names are dropped.
//   - Unknown service, category and app ids are ignored (the API refuses them earlier).
func (c *Catalog) ResolveTargets(sel Selection, platform Platform) Resolved {
	var domains, excluded, appIDs orderedSet
	processes := make(map[string]string)
	var processOrder []string

	addService := func(svc *embedded.Service) {
		for _, d := range svc.Domains {
			domains.add(d)
		}
		for _, h := range svc.ExcludedSubdomains {
			excluded.add(h)
		}
		for _, id := range svc.AppIDs {
			appIDs.add(id)
		}
	}
	addProcess := func(name string) {
		if !IsValidProcessName(name) || c.IsProtectedProcessName(name) {
			return
		}
		key := ProcessNameKey(name, platform)
		if _, dup := processes[key]; !dup {
			processes[key] = name
			processOrder = append(processOrder, key)
		}
	}

	for _, id := range sel.CategoryIDs {
		cat := c.Category(id)
		if cat == nil {
			continue
		}
		for _, svc := range c.ServicesInCategory(cat.ID) {
			addService(svc)
		}
		for _, appID := range cat.AppIDs {
			appIDs.add(appID)
		}
	}
	for _, id := range sel.ServiceIDs {
		if svc := c.Service(id); svc != nil {
			addService(svc)
		}
	}
	for _, raw := range sel.Domains {
		for _, d := range c.ExpandDomainVariants(raw) {
			domains.add(d)
		}
	}
	for _, id := range sel.AppIDs {
		appIDs.add(id)
	}
	for _, id := range appIDs.values() {
		if app := c.App(id); app != nil {
			for _, name := range app.Processes.For(string(platform)) {
				addProcess(name)
			}
		}
	}
	for _, raw := range sel.ProcessNames {
		addProcess(jsTrim(raw))
	}

	for _, d := range domains.values() {
		if c.IsAlwaysAllowedHost(d) {
			domains.remove(d)
		}
	}
	blocked := domains.values()
	for _, host := range excluded.values() {
		for _, d := range blocked {
			if IsSameOrSubdomain(d, host) {
				excluded.remove(host)
				break
			}
		}
	}
	for _, host := range c.snap.AlwaysAllowedHosts {
		for _, d := range blocked {
			if IsSameOrSubdomain(host, d) {
				excluded.add(host)
				break
			}
		}
	}

	out := Resolved{
		Domains:         blocked,
		ExcludedDomains: excluded.values(),
		Processes:       make([]string, 0, len(processOrder)),
	}
	for _, key := range processOrder {
		out.Processes = append(out.Processes, processes[key])
	}
	slices.SortFunc(out.Domains, compareUTF16)
	slices.SortFunc(out.ExcludedDomains, compareUTF16)
	slices.SortFunc(out.Processes, compareProcessNames)
	return out
}

// AllDistractionTargets returns every category's domains and processes on platform:
// what the level-1 punishment blocks.
func (c *Catalog) AllDistractionTargets(platform Platform) Resolved {
	return c.ResolveTargets(Selection{CategoryIDs: c.CategoryIDs()}, platform)
}

// StudyWhitelistDomains returns the default study whitelist as a unique, sorted domain
// list; each domain also allows its subdomains.
func (c *Catalog) StudyWhitelistDomains() []string { return slices.Clone(c.studyDomains) }

// StudyWhitelistHostPatterns returns the default study whitelist's host patterns (RE2
// sources anchored with ^…$, matched against the whole canonical host), unique and
// sorted.
func (c *Catalog) StudyWhitelistHostPatterns() []string { return slices.Clone(c.studyPatterns) }

// IsAllowedInStudyWhitelist reports whether whitelist mode (punishment level 2, exam
// mode) allows domain: an always-allowed host, a default study domain or host pattern,
// or one of extraDomains (settings.studyWhitelist.extraDomains). Subdomains of allowed
// domains are allowed too; URLs work.
func (c *Catalog) IsAllowedInStudyWhitelist(domain string, extraDomains []string) bool {
	return c.IsAlwaysAllowedHost(domain) ||
		IsDomainAllowedInWhitelist(domain, c.studyDomains, c.studyPatterns) ||
		IsDomainAllowedInWhitelist(domain, extraDomains, nil)
}

// StudyWhitelistProcesses returns the default study apps' process names for platform,
// unique (per ProcessNameKey, keeping the first spelling) and sorted.
func (c *Catalog) StudyWhitelistProcesses(platform Platform) []string {
	seen := make(map[string]struct{})
	out := []string{}
	for _, app := range c.snap.StudyAppWhitelist {
		for _, name := range app.Processes.For(string(platform)) {
			key := ProcessNameKey(name, platform)
			if _, dup := seen[key]; !dup {
				seen[key] = struct{}{}
				out = append(out, name)
			}
		}
	}
	slices.SortFunc(out, compareProcessNames)
	return out
}
