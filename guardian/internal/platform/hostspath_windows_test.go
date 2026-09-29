package platform

import "testing"

func TestDataBasePathReadable(t *testing.T) {
	dir, ok := dataBasePath()
	if !ok {
		t.Fatal("DataBasePath could not be read or is not a local absolute path")
	}
	p, redirected := systemHostsPath()
	if redirected == samePath(p, system32HostsPath()) {
		t.Fatalf("path %q (DataBasePath %q) redirected=%v", p, dir, redirected)
	}
	if !redirected {
		t.Logf("DataBasePath is the default: %s", dir)
	}
}
