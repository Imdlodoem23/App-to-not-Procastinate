package catalog

import (
	"reflect"
	"slices"
	"testing"
)

func sortedCopy(s []string) []string {
	out := slices.Clone(s)
	slices.SortFunc(out, compareUTF16)
	return out
}

func TestResolveTargets(t *testing.T) {
	c := testCatalog(t)
	empty := Resolved{Domains: []string{}, ExcludedDomains: []string{}, Processes: []string{}}

	t.Run("service", func(t *testing.T) {
		got := c.ResolveTargets(Selection{ServiceIDs: []string{"discord"}}, PlatformWin)
		if want := sortedCopy(c.Service("discord").Domains); !slices.Equal(got.Domains, want) {
			t.Errorf("domains %q, want %q", got.Domains, want)
		}
		if want := []string{"Discord.exe", "DiscordCanary.exe", "DiscordPTB.exe"}; !slices.Equal(got.Processes, want) {
			t.Errorf("processes %q, want %q", got.Processes, want)
		}
	})

	t.Run("platform", func(t *testing.T) {
		for _, tc := range []struct {
			id   string
			p    Platform
			want []string
		}{
			{"steam", PlatformMac, []string{"Steam Helper", "steam_osx"}},
			{"roblox", PlatformLinux, []string{}},
			{"youtube", PlatformWin, []string{}},
			{"discord", PlatformLinux, []string{"Discord", "discord", "DiscordCanary", "DiscordPTB"}},
		} {
			got := c.ResolveTargets(Selection{ServiceIDs: []string{tc.id}}, tc.p).Processes
			if !slices.Equal(got, tc.want) {
				t.Errorf("%s on %s: %q, want %q", tc.id, tc.p, got, tc.want)
			}
		}
	})

	t.Run("category", func(t *testing.T) {
		got := c.ResolveTargets(Selection{CategoryIDs: []string{"games"}}, PlatformWin)
		for _, svc := range c.ServicesInCategory("games") {
			for _, d := range svc.Domains {
				if !slices.Contains(got.Domains, d) && !c.IsAlwaysAllowedHost(d) {
					t.Errorf("games misses %q", d)
				}
			}
		}
		for _, p := range []string{"steam.exe", "RobloxPlayerBeta.exe", "VALORANT.exe", "cs2.exe"} {
			if !slices.Contains(got.Processes, p) {
				t.Errorf("games misses process %q", p)
			}
		}
		if slices.Contains(got.Domains, "youtube.com") {
			t.Error("games blocks youtube.com")
		}
		for _, h := range []string{"create.roblox.com", "dev.epicgames.com", "education.minecraft.net", "www.epicgames.com"} {
			if !slices.Contains(got.ExcludedDomains, h) || slices.Contains(got.Domains, h) {
				t.Errorf("games: %q should be excluded, not blocked", h)
			}
		}
	})

	t.Run("custom domains", func(t *testing.T) {
		got := c.ResolveTargets(Selection{Domains: []string{"https://Example.com/x", "m.foo.org", "not a domain", "10.0.0.1"}}, PlatformLinux)
		want := Resolved{Domains: []string{"example.com", "m.foo.org", "www.example.com"}, ExcludedDomains: []string{}, Processes: []string{}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("apps and custom processes", func(t *testing.T) {
		got := c.ResolveTargets(Selection{
			AppIDs:       []string{"telegram", "nope"},
			ProcessNames: []string{" MyGame.exe ", `C:\x\evil.exe`, "explorer.exe", "csrss", "mygame.EXE"},
		}, PlatformWin)
		want := Resolved{Domains: []string{}, ExcludedDomains: []string{}, Processes: []string{"MyGame.exe", "Telegram.exe"}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %+v, want %+v", got, want)
		}
		if got := c.ResolveTargets(Selection{ProcessNames: []string{"osk.exe", "VoiceOver", "orca"}}, PlatformWin); !reflect.DeepEqual(got, empty) {
			t.Errorf("accessibility tools resolved to %+v", got)
		}
	})

	t.Run("case rules", func(t *testing.T) {
		got := c.ResolveTargets(Selection{ProcessNames: []string{"Game", "game", "GAME"}}, PlatformMac).Processes
		if !slices.Equal(got, []string{"Game"}) {
			t.Errorf("mac: %q", got)
		}
		got = c.ResolveTargets(Selection{ProcessNames: []string{"Game", "game", "GAME"}}, PlatformLinux).Processes
		if !slices.Equal(got, []string{"GAME", "Game", "game"}) {
			t.Errorf("linux: %q", got)
		}
	})

	t.Run("overlaps are unique and sorted", func(t *testing.T) {
		got := c.ResolveTargets(Selection{
			ServiceIDs:  []string{"youtube", "youtube", "tiktok"},
			CategoryIDs: []string{"video"},
			Domains:     []string{"youtube.com", "www.youtube.com"},
		}, PlatformWin)
		if !slices.IsSortedFunc(got.Domains, compareUTF16) || len(slices.Compact(slices.Clone(got.Domains))) != len(got.Domains) {
			t.Errorf("domains not unique and sorted: %q", got.Domains)
		}
		for _, d := range []string{"tiktok.com", "netflix.com"} {
			if !slices.Contains(got.Domains, d) {
				t.Errorf("missing %q", d)
			}
		}
	})

	t.Run("unknown ids and empty selections", func(t *testing.T) {
		for _, sel := range []Selection{{}, {ServiceIDs: []string{"nope"}, CategoryIDs: []string{"nope"}, AppIDs: []string{"nope"}}} {
			if got := c.ResolveTargets(sel, PlatformMac); !reflect.DeepEqual(got, empty) {
				t.Errorf("%+v resolved to %+v", sel, got)
			}
		}
	})

	t.Run("always-allowed hosts", func(t *testing.T) {
		yt := c.ResolveTargets(Selection{ServiceIDs: []string{"youtube"}}, PlatformWin)
		if !slices.Contains(yt.Domains, "youtube.com") || slices.Contains(yt.Domains, "accounts.youtube.com") {
			t.Errorf("youtube domains %q", yt.Domains)
		}
		if !slices.Equal(yt.ExcludedDomains, []string{"accounts.youtube.com"}) {
			t.Errorf("youtube excluded %q", yt.ExcludedDomains)
		}
		for _, sel := range []Selection{{CategoryIDs: []string{"video"}}, {Domains: []string{"youtube.com"}}} {
			if !slices.Contains(c.ResolveTargets(sel, PlatformWin).ExcludedDomains, "accounts.youtube.com") {
				t.Errorf("%+v does not exempt accounts.youtube.com", sel)
			}
		}
		typed := c.ResolveTargets(Selection{Domains: []string{"accounts.youtube.com", "x.accounts.youtube.com"}}, PlatformWin)
		if !reflect.DeepEqual(typed, empty) {
			t.Errorf("typed always-allowed hosts resolved to %+v", typed)
		}
		if got := c.ResolveTargets(Selection{ServiceIDs: []string{"tiktok"}}, PlatformWin).ExcludedDomains; len(got) != 0 {
			t.Errorf("tiktok excluded %q", got)
		}
	})

	t.Run("excluded subdomains", func(t *testing.T) {
		got := c.ResolveTargets(Selection{ServiceIDs: []string{"amazon"}}, PlatformWin).ExcludedDomains
		if want := []string{"aws.amazon.com", "leer.amazon.es", "read.amazon.com"}; !slices.Equal(got, want) {
			t.Errorf("amazon excluded %q, want %q", got, want)
		}
		typed := c.ResolveTargets(Selection{ServiceIDs: []string{"amazon"}, Domains: []string{"docs.aws.amazon.com"}}, PlatformWin)
		if !slices.Contains(typed.Domains, "docs.aws.amazon.com") {
			t.Error("a typed excluded host is not blocked")
		}
		if want := []string{"leer.amazon.es", "read.amazon.com"}; !slices.Equal(typed.ExcludedDomains, want) {
			t.Errorf("excluded %q, want %q", typed.ExcludedDomains, want)
		}
	})
}

func TestAllDistractionTargets(t *testing.T) {
	c := testCatalog(t)
	for _, p := range allPlatforms {
		all := c.AllDistractionTargets(p)
		if every := c.ResolveTargets(Selection{CategoryIDs: c.CategoryIDs()}, p); !reflect.DeepEqual(all, every) {
			t.Errorf("%s: AllDistractionTargets differs from every category", p)
		}
		for _, name := range all.Processes {
			if c.IsProtectedProcessName(name) {
				t.Errorf("%s: protected process %q in the punishment", p, name)
			}
		}
		for _, d := range all.Domains {
			if c.IsProtectedDomain(d) {
				t.Errorf("%s: protected domain %q in the punishment", p, d)
			}
		}
	}
	win := c.AllDistractionTargets(PlatformWin)
	for _, id := range []string{"youtube", "tiktok", "steam", "discord", "amazon", "marca"} {
		for _, d := range c.Service(id).Domains {
			if !slices.Contains(win.Domains, d) {
				t.Errorf("punishment misses %s domain %q", id, d)
			}
		}
	}
	if slices.Contains(win.Domains, "linkedin.com") || slices.Contains(win.Processes, "Spotify.exe") {
		t.Error("the punishment blocks an opt-in service")
	}
	if !slices.Contains(win.Processes, "Discord.exe") {
		t.Error("the punishment misses Discord.exe")
	}
	for _, h := range []string{"accounts.youtube.com", "aws.amazon.com"} {
		if !slices.Contains(win.ExcludedDomains, h) {
			t.Errorf("the punishment does not exempt %q", h)
		}
	}
}

func TestStudyWhitelist(t *testing.T) {
	c := testCatalog(t)
	domains := c.StudyWhitelistDomains()
	if !slices.IsSortedFunc(domains, compareUTF16) || !slices.Contains(domains, "classroom.google.com") {
		t.Errorf("study domains %q", domains)
	}
	patterns := c.StudyWhitelistHostPatterns()
	if len(patterns) == 0 || !slices.IsSortedFunc(patterns, compareUTF16) {
		t.Errorf("study patterns %q", patterns)
	}
	for _, p := range patterns {
		for _, svc := range c.Snapshot().Services {
			for _, d := range svc.Domains {
				if MatchesHostPattern(d, p) {
					t.Errorf("pattern %q matches distraction host %q", p, d)
				}
			}
		}
	}
	for _, host := range []string{"classroom.google.com", "accounts.youtube.com", "doc-0s-8c-docs.googleusercontent.com", "lh3.googleusercontent.com", "https://es.wikipedia.org/wiki/Roma"} {
		if !c.IsAllowedInStudyWhitelist(host, nil) {
			t.Errorf("%q not allowed in the study whitelist", host)
		}
	}
	if c.IsAllowedInStudyWhitelist("www.youtube.com", nil) || c.IsAllowedInStudyWhitelist("aulavirtual.example.edu", nil) {
		t.Error("the study whitelist allows too much")
	}
	if !c.IsAllowedInStudyWhitelist("aulavirtual.example.edu", []string{"example.edu"}) {
		t.Error("extra domains are ignored")
	}
	if c.IsAllowedInStudyWhitelist("not a host", []string{"example.edu"}) {
		t.Error("invalid host allowed")
	}
	win := c.StudyWhitelistProcesses(PlatformWin)
	for _, p := range []string{"WINWORD.EXE", "EXCEL.EXE", "POWERPNT.EXE", "Code.exe", "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "Zoom.exe"} {
		if !slices.Contains(win, p) {
			t.Errorf("study apps (win) miss %q", p)
		}
	}
	if !slices.IsSortedFunc(win, compareProcessNames) {
		t.Errorf("study apps not sorted: %q", win)
	}
	for p, name := range map[Platform]string{PlatformMac: "Microsoft Word", PlatformLinux: "soffice.bin"} {
		if !slices.Contains(c.StudyWhitelistProcesses(p), name) {
			t.Errorf("study apps (%s) miss %q", p, name)
		}
	}
	// The results are copies.
	domains[0] = "evil.example"
	if c.StudyWhitelistDomains()[0] == "evil.example" {
		t.Error("StudyWhitelistDomains returned shared memory")
	}
}
