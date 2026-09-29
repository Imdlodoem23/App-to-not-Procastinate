package hosts

import (
	"slices"
	"testing"
)

func TestDefenderSensitive(t *testing.T) {
	yes := []string{
		"microsoft.com", "settings-win.data.microsoft.com", "WWW.BING.COM", "linkedin.com",
		"www.linkedin.com", "xbox.com", "login.live.com", "msn.com", "office.com",
		"windowsupdate.com", "download.windowsupdate.com", "skype.com", "windows.com",
	}
	no := []string{
		"youtube.com", "notmicrosoft.com", "microsoft.com.evil.net", "bing.co", "xbox.co.uk",
		"linkedin.com.", "", "*.bing.com", "live.co", "office.net",
	}
	for _, d := range yes {
		if !DefenderSensitive(d) {
			t.Errorf("DefenderSensitive(%q) = false", d)
		}
	}
	for _, d := range no {
		if DefenderSensitive(d) {
			t.Errorf("DefenderSensitive(%q) = true", d)
		}
	}
	list := DefenderSensitiveDomains()
	if !slices.IsSorted(list) || len(list) != len(defenderSensitive) {
		t.Fatalf("DefenderSensitiveDomains = %v", list)
	}
	for _, d := range list {
		if _, err := ValidateDomain(d); err != nil {
			t.Errorf("%q: %v", d, err)
		}
	}
	list[0] = "changed.example"
	if DefenderSensitiveDomains()[0] == "changed.example" {
		t.Fatal("DefenderSensitiveDomains returned the internal array")
	}
}

func TestHostsLayerDomains(t *testing.T) {
	in := []string{"youtube.com", "www.linkedin.com", "Bing.com", "reddit.com", "bad domain", "xbox.com"}
	kept, skipped := hostsLayerDomains("windows", in)
	if want := []string{"youtube.com", "reddit.com", "bad domain"}; !slices.Equal(kept, want) || skipped != 3 {
		t.Fatalf("windows: kept %v skipped %d, want %v and 3", kept, skipped, want)
	}
	for _, goos := range []string{"linux", "darwin"} {
		kept, skipped := hostsLayerDomains(goos, in)
		if !slices.Equal(kept, in) || skipped != 0 {
			t.Fatalf("%s: kept %v skipped %d", goos, kept, skipped)
		}
	}
	if kept, skipped := hostsLayerDomains("windows", nil); kept == nil || len(kept) != 0 || skipped != 0 {
		t.Fatalf("nil input: %#v %d", kept, skipped)
	}
	// The exported wrapper uses the running OS.
	kept, _ = HostsLayerDomains([]string{"youtube.com"})
	if !slices.Equal(kept, []string{"youtube.com"}) {
		t.Fatalf("HostsLayerDomains = %v", kept)
	}
}
