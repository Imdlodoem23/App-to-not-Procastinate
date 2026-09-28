package catalog

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

func TestFindAllowDistraction(t *testing.T) {
	c := testCatalog(t)
	paths := AllowPaths{Domains: "settings.studyWhitelist.extraDomains", Processes: "settings.studyWhitelist.extraProcesses"}
	for _, tc := range []struct {
		entries  AllowEntries
		platform Platform
		want     *AllowDistraction
	}{
		{AllowEntries{Domains: []string{"wikipedia.org"}, Processes: []string{"GeoGebra.exe"}}, "", nil},
		{AllowEntries{Domains: []string{"educacion.gob.es", "gob.es"}}, "",
			&AllowDistraction{Path: paths.Domains + "[1]", Reason: ReasonPublicSuffix}},
		{AllowEntries{Domains: []string{"m.youtube.com"}}, "",
			&AllowDistraction{Path: paths.Domains + "[0]", Reason: ReasonServiceDomain, ServiceID: "youtube"}},
		{AllowEntries{Domains: []string{"googleapis.com"}}, "",
			&AllowDistraction{Path: paths.Domains + "[0]", Reason: ReasonParentOfServiceDomain, ServiceID: "youtube"}},
		{AllowEntries{Domains: []string{"aws.amazon.com", "docs.aws.amazon.com"}}, "", nil},
		// Opt-in services (no category) are not distractions for the whitelist.
		{AllowEntries{Domains: []string{"linkedin.com"}}, "", nil},
		{AllowEntries{Domains: []string{"wikipedia.org"}, Processes: []string{"notepad.exe", "Discord"}}, "",
			&AllowDistraction{Path: paths.Processes + "[1]", Reason: ReasonDistractionApp, AppID: "discord"}},
		{AllowEntries{Processes: []string{"Discord"}}, PlatformLinux,
			&AllowDistraction{Path: paths.Processes + "[0]", Reason: ReasonDistractionApp, AppID: "discord"}},
		{AllowEntries{Processes: []string{"discord.exe"}}, PlatformLinux, nil},
		// Domains are checked before processes.
		{AllowEntries{Domains: []string{"ok.example", "tiktok.com"}, Processes: []string{"steam.exe"}}, PlatformWin,
			&AllowDistraction{Path: paths.Domains + "[1]", Reason: ReasonServiceDomain, ServiceID: "tiktok"}},
	} {
		got := c.FindAllowDistraction(tc.entries, paths, tc.platform)
		if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
			t.Errorf("FindAllowDistraction(%+v, %q) = %+v, want %+v", tc.entries, tc.platform, got, tc.want)
		}
	}
}

func TestAllowDistractionJSON(t *testing.T) {
	for _, tc := range []struct {
		in   AllowDistraction
		want string
	}{
		{AllowDistraction{Path: "allow.customDomains[0]", Reason: ReasonPublicSuffix},
			`{"path":"allow.customDomains[0]","reason":"public_suffix","serviceId":null,"appId":null}`},
		{AllowDistraction{Path: "p[1]", Reason: ReasonServiceDomain, ServiceID: "youtube"},
			`{"path":"p[1]","reason":"service_domain","serviceId":"youtube","appId":null}`},
		{AllowDistraction{Path: "p[2]", Reason: ReasonDistractionApp, AppID: "steam"},
			`{"path":"p[2]","reason":"distraction_app","serviceId":null,"appId":"steam"}`},
	} {
		b, err := json.Marshal(tc.in)
		if err != nil || string(b) != tc.want {
			t.Errorf("json %s (%v), want %s", b, err, tc.want)
		}
		if b, err := json.Marshal(&tc.in); err != nil || string(b) != tc.want {
			t.Errorf("json via pointer %s (%v)", b, err)
		}
	}
}

func TestTargetKeys(t *testing.T) {
	c := testCatalog(t)
	for host, want := range map[string]string{
		"www.youtube.com":            "svc:youtube",
		"https://es.m.youtube.com/x": "svc:youtube",
		"www.example.org":            "dom:example.org",
		"accounts.youtube.com":       "dom:accounts.youtube.com",
		"www.www.example.org":        "dom:www.example.org",
	} {
		if got := c.DomainTargetKey(host); got != want {
			t.Errorf("DomainTargetKey(%q) = %q, want %q", host, got, want)
		}
	}
	for _, tc := range []struct {
		name string
		p    Platform
		want string
	}{
		{"RobloxPlayerBeta.exe", PlatformWin, "svc:roblox"},
		{"WhatsApp.Root.exe", PlatformWin, "svc:whatsapp"},
		{"cs2.exe", PlatformWin, "app:popular-pc-games"},
		{" STEAM.exe ", PlatformWin, "svc:steam"},
		{"MyGame.EXE", PlatformWin, "proc:mygame.exe"},
		{"MyGame", PlatformLinux, "proc:MyGame"},
	} {
		if got := c.ProcessTargetKey(tc.name, tc.p); got != tc.want {
			t.Errorf("ProcessTargetKey(%q, %s) = %q, want %q", tc.name, tc.p, got, tc.want)
		}
	}
	if got := ServiceTargetKey("netflix"); got != "svc:netflix" {
		t.Errorf("ServiceTargetKey = %q", got)
	}
}

func TestTextFieldIssue(t *testing.T) {
	l := embedded.API().Limits
	for _, tc := range []struct {
		field    TextField
		min, max int
		text     bool
	}{
		{FieldReason, 0, l.ReasonMaxLength, true},
		{FieldTask, 0, l.TaskMaxLength, true},
		{FieldScheduleName, 1, l.ScheduleNameMaxLength, true},
		{FieldPhrase, 1, l.PhraseMaxLength, false},
	} {
		if tc.max <= 1 {
			t.Fatalf("%s: embedded limit %d", tc.field, tc.max)
		}
		check := func(value, want string) {
			t.Helper()
			if got := TextFieldIssue(tc.field, value); got != want {
				t.Errorf("TextFieldIssue(%s, %d units) = %q, want %q", tc.field, UTF16Len(value), got, want)
			}
		}
		check(strings.Repeat("a", tc.max), "")
		check(strings.Repeat("a", tc.max+1), IssueLength)
		check(strings.Repeat("a", tc.max-2)+u(0x1F600), "")
		check(strings.Repeat("a", tc.max-1)+u(0x1F600), IssueLength)
		check(strings.Repeat("ñ", tc.max), "")
		if tc.min == 1 {
			check("", IssueLength)
		} else {
			check("", "")
		}
		for _, bad := range []rune{0, 0x1F, 0x7F, 0x9F, 0x202A, 0x202E, 0x2066, 0x2069} {
			want := ""
			if tc.text {
				want = IssuePattern
			}
			check("a"+u(bad)+"b", want)
		}
		check("a"+u(0xA0, 0x202F, 0x206A)+"b", "")
	}
	if got := TextFieldIssue("nickname", "x"); got != IssueRule {
		t.Errorf("unknown field: %q", got)
	}
}
